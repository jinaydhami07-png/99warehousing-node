/**
 * Authentication service — token issuing and session lifecycle.
 *
 * Token strategy:
 *   • Access token  — 15 minutes, sent in the Authorization header, held in
 *                     memory by the client. Short-lived so a leaked token
 *                     has a small blast radius.
 *   • Refresh token — 7 days, delivered as an httpOnly cookie. JavaScript
 *                     cannot read it, so an XSS bug cannot exfiltrate a
 *                     long-lived credential.
 *
 * Refresh tokens carry a `tokenVersion` claim. Logging out increments the
 * stored version, which invalidates every refresh token already issued to
 * that user — "sign out everywhere" without maintaining a blacklist.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../config/logger');
const User = require('../models/user.model');
const ApiError = require('../utils/ApiError');
const userService = require('./user.service');

const REFRESH_COOKIE = 'bpsf_refresh';

const signAccessToken = (user) =>
  jwt.sign(
    { sub: user._id.toString(), role: user.role },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpires, issuer: 'bpsf-api', audience: 'bpsf-client' }
  );

const signRefreshToken = (user) =>
  jwt.sign(
    { sub: user._id.toString(), ver: user.tokenVersion || 0 },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpires, issuer: 'bpsf-api', audience: 'bpsf-client' }
  );

/** Cookie options kept in one place so they cannot drift between routes. */
const refreshCookieOptions = () => ({
  httpOnly: true,                 // unreadable from JavaScript
  secure: env.isProd,             // HTTPS only in production
  sameSite: env.isProd ? 'strict' : 'lax', // CSRF mitigation
  path: '/api/v1/auth',           // never sent to unrelated endpoints
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

function setRefreshCookie(res, user) {
  res.cookie(REFRESH_COOKIE, signRefreshToken(user), refreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
}

/** Registers a user and starts a session. */
async function register(res, payload) {
  const user = await userService.createUser(payload);
  setRefreshCookie(res, user);
  return { accessToken: signAccessToken(user), user };
}

/** Signs in an existing user. */
async function login(res, { email, password }) {
  const user = await userService.verifyCredentials(email, password);
  setRefreshCookie(res, user);
  return { accessToken: signAccessToken(user), user };
}

/**
 * Admin passkey sign-in, used by the dashboard's "Staff access" panel.
 *
 * The passkey is compared here on the server and never sent to the browser,
 * so it cannot be read out of page source the way a client-side check could.
 * Comparison is constant-time to avoid leaking the prefix through response
 * timing.
 */
async function adminLogin(res, passkey) {
  const expected = env.adminPasskey;

  if (!expected) {
    throw new ApiError(503, 'Admin access is not configured on this server');
  }

  const a = Buffer.from(String(passkey));
  const b = Buffer.from(String(expected));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) throw ApiError.unauthorized('Incorrect admin passkey');

  // Bootstrap a single admin identity on first use so audit trails and
  // ownership checks have a real user to point at.
  let admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    admin = await User.create({
      name: '99Warehousing Admin',
      email: 'admin@99warehousing.local',
      role: 'admin',
      isEmailVerified: true,
      authProvider: 'local',
      // Never used to sign in — the passkey is the only route to this account.
      password: crypto.randomBytes(24).toString('hex'),
    });
  }

  setRefreshCookie(res, admin);
  return { accessToken: signAccessToken(admin), user: admin };
}

/**
 * Exchanges a valid refresh cookie for a new access token.
 * Rejects tokens whose version is stale (i.e. issued before a logout).
 */
/* ── Google sign-in ────────────────────────────────────────────
   Authorization-code flow, done directly against Google's endpoints rather
   than through passport: it is two HTTPS calls, and avoiding the dependency
   keeps the session logic in one place instead of split across a strategy.
   ───────────────────────────────────────────────────────────── */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_STATE_COOKIE = 'bpsf_oauth_state';

/**
 * Builds the consent-screen URL and the CSRF state that goes with it.
 *
 * `state` is random per attempt and echoed back by Google; the callback only
 * proceeds if it matches the cookie. Without it, an attacker could feed a
 * victim a callback URL carrying their own authorization code and silently
 * link the victim's session to the attacker's Google account.
 */
/**
 * Picks which registered callback to use for this request.
 *
 * The redirect_uri sent to Google, and the one sent again when the code is
 * exchanged, must be identical — and both must be registered. Hard-coding a
 * single value means a build configured for the live domain sends anyone
 * testing on localhost to the production host after consent, which is a 404
 * until that host is actually running the app.
 *
 * The chosen value is always one of the strings the operator configured, so
 * a forged Host header can only select among URLs already trusted — it can
 * never introduce a new one. That is the difference between this and simply
 * building the URL out of req.headers.host, which would let an attacker
 * redirect the authorization code to their own server.
 */
function pickCallbackUrl(req) {
  const list = env.google.callbackUrls;
  if (!req || list.length < 2) return env.google.callbackUrl;

  const proto = req.protocol;
  const host = req.get('host');
  if (!host) return env.google.callbackUrl;

  const origin = `${proto}://${host}`.toLowerCase();
  const match = list.find((u) => {
    try { return new URL(u).origin.toLowerCase() === origin; } catch { return false; }
  });
  return match || env.google.callbackUrl;
}

function googleAuthUrl(res, req) {
  if (!env.google.enabled) throw new ApiError(503, 'Google sign-in is not configured on this server');

  const redirectUri = pickCallbackUrl(req);

  /* Remembered so the token exchange sends exactly the same value. Google
     rejects the exchange if the two differ. */
  res.cookie('bpsf_oauth_cb', redirectUri, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.isProd,
    /* 'lax' — not 'strict'. Google's redirect back is a cross-site
       navigation, and a strict cookie would not be sent with it, breaking
       the state check on every attempt. */
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Reads a JWT payload without verifying the signature. Safe only for the
 *  id_token returned by the token endpoint, which arrived over a direct TLS
 *  connection to Google — Google's own documentation says verification can
 *  be skipped in exactly that case. Never use this on a token that reached
 *  us via the browser. */
function decodeIdToken(idToken) {
  const part = String(idToken).split('.')[1];
  if (!part) throw ApiError.unauthorized('Malformed response from Google');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Completes the flow: swaps the code for tokens, then finds or creates the
 * matching local account and issues our own session.
 */
async function googleCallback(req, res, { code, state }) {
  if (!env.google.enabled) throw new ApiError(503, 'Google sign-in is not configured on this server');

  const expected = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
  if (!expected || !state || state !== expected) {
    throw ApiError.unauthorized('Sign-in request expired or was tampered with. Please try again.');
  }

  /* Must be byte-identical to the redirect_uri used on the consent request,
     or Google refuses the exchange with redirect_uri_mismatch. Read back from
     the cookie set at that moment rather than recomputed, so the two cannot
     drift; validated against the configured list so a tampered cookie cannot
     introduce an arbitrary value. */
  const cookieCb = req.cookies?.bpsf_oauth_cb;
  const redirectUri = env.google.callbackUrls.includes(cookieCb)
    ? cookieCb
    : pickCallbackUrl(req);
  res.clearCookie('bpsf_oauth_cb', { path: '/' });

  const body = new URLSearchParams({
    code,
    client_id: env.google.clientId,
    client_secret: env.google.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    logger.warn({ status: tokenRes.status, detail: detail.slice(0, 300) }, 'Google token exchange failed');
    throw ApiError.unauthorized('Google sign-in failed. Please try again.');
  }

  const tokens = await tokenRes.json();
  const profile = decodeIdToken(tokens.id_token);

  if (!profile.email) throw ApiError.unauthorized('Google did not return an email address');
  if (profile.email_verified === false) {
    throw ApiError.unauthorized('Your Google email address is not verified');
  }

  const email = String(profile.email).toLowerCase().trim();

  /* Match on googleId first, then fall back to email so someone who
     registered with a password can sign in with Google afterwards and land
     in the same account rather than a duplicate. */
  let user = await User.findOne({ googleId: profile.sub });

  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      user.googleId = profile.sub;
      if (!user.isEmailVerified) user.isEmailVerified = true;
      if (profile.picture) user.avatar = profile.picture;
      await user.save();
    }
  }

  if (!user) {
    user = await User.create({
      name: profile.name || email.split('@')[0],
      email,
      googleId: profile.sub,
      avatar: profile.picture || undefined,
      authProvider: 'google',
      isEmailVerified: true,
      /* No password is set: the schema only requires one for local accounts,
         and generating a throwaway would leave a credential nobody knows
         that could still be brute-forced. */
    });
    logger.info({ userId: user.id }, 'New account created via Google');
  }

  if (!user.isActive) throw ApiError.forbidden('This account has been disabled');

  setRefreshCookie(res, user);
  return { accessToken: signAccessToken(user), user: user.toJSON() };
}

async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw ApiError.unauthorized('No active session');

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.refreshSecret, {
      algorithms: ['HS256'],
      issuer: 'bpsf-api',
      audience: 'bpsf-client',
    });
  } catch {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || !user.isActive) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Account unavailable');
  }

  if ((payload.ver ?? 0) !== (user.tokenVersion ?? 0)) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Session was ended. Please sign in again.');
  }

  // Rotate the refresh cookie on every use, so a stolen one has a short life.
  setRefreshCookie(res, user);
  return { accessToken: signAccessToken(user), user };
}

/** Ends the session everywhere by bumping the token version. */
async function logout(req, res) {
  if (req.user) await userService.revokeSessions(req.user._id);
  clearRefreshCookie(res);
}

module.exports = {
  register,
  login,
  adminLogin,
  googleAuthUrl,
  googleCallback,
  refresh,
  logout,
  signAccessToken,
  REFRESH_COOKIE,
};
