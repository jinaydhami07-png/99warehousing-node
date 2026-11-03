'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created } = require('../utils/ApiResponse');
const authService = require('../services/auth.service');
const env = require('../config/env');
const logger = require('../config/logger');

/** POST /api/v1/auth/register */
const register = catchAsync(async (req, res) => {
  const { accessToken, user } = await authService.register(res, req.body);
  created(res, { message: 'Account created', data: { accessToken, user } });
});

/** POST /api/v1/auth/login */
const login = catchAsync(async (req, res) => {
  const { accessToken, user } = await authService.login(res, req.body);
  success(res, { message: 'Signed in', data: { accessToken, user } });
});

/** POST /api/v1/auth/admin — "Staff access" passkey panel on the login page */
const adminLogin = catchAsync(async (req, res) => {
  const { accessToken, user } = await authService.adminLogin(res, req.body.passkey);
  success(res, { message: 'Admin session started', data: { accessToken, user } });
});

/**
 * GET /api/v1/auth/google
 *
 * Google OAuth is not wired up on this server yet (no client credentials in
 * .env). Rather than 404 — which surfaces as a confusing dead button —
 * redirect back to the login page with a flag it already knows how to
 * display. Swap this for the real consent-screen redirect once
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are configured.
 */
/**
 * Every OAuth exit lands on the login page — but *which* login page.
 *
 * A relative redirect means this server's own host, and since the API moved
 * off the web host that is no longer where the site is. A visitor who
 * started on the real domain would be handed back to the API's host and
 * silently finish signing in on a different site.
 *
 * env.siteUrl comes from the configured CORS origins, never from the
 * request, so there is nothing here an attacker can point somewhere else.
 * It is empty in development, where the API serves the pages itself and a
 * relative path is already right.
 */
const loginPage = (suffix) => `${env.siteUrl}/login.html${suffix}`;

/* ── Where the packaged mobile app wants to come back to ──────────────
 * The app's pages are files inside the APK, so there is no URL on this
 * server that can hand control back to it. A custom scheme can: Android
 * routes com.warehousing99.app://auth to the app, which reads the token off
 * the end exactly as the website reads it off the fragment.
 *
 * The app cannot use the website's flow at all. Google refuses OAuth inside
 * an embedded WebView (disallowed_useragent), so the app opens this in a
 * real Chrome tab instead — and a Chrome tab has no way back into the app
 * except a link like this one.
 *
 * NONE of this is reachable from the website. It turns on only when
 * /auth/google is called with ?native=1, which only the app sends, and the
 * web path below is left exactly as it was. */
const APP_SCHEME_URL = 'com.warehousing99.app://auth';
const NATIVE_COOKIE = 'bpsf_oauth_native';

/* Carried in a cookie rather than the state parameter so the existing CSRF
   check is not touched. 'lax' and a 10-minute life mirror the state and
   callback cookies next to it in auth.service.js — proven to survive
   Google's cross-site redirect back, which a 'strict' cookie would not. */
const markNative = (res) =>
  res.cookie(NATIVE_COOKIE, '1', {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

/**
 * The destination for every exit from the OAuth round-trip.
 *
 * Returns the website's login page unless this run was started by the app,
 * so a change here cannot alter web behaviour. Errors honour it too — an app
 * user who cancels should land back in the app, not on the website inside
 * the Chrome tab they were sent to.
 */
function exitTo(req, res, suffix) {
  if (req.cookies?.[NATIVE_COOKIE] !== '1') return loginPage(suffix);
  res.clearCookie(NATIVE_COOKIE, { path: '/' });
  return APP_SCHEME_URL + suffix;
}

const googleStart = (req, res) => {
  const native = req.query.native === '1';
  /* Marked before the guard below, so even the not-configured exit returns
     an app caller to the app rather than stranding it on the website. */
  if (native) markNative(res);
  if (!env.google.enabled) return res.redirect(exitTo(req, res, '?error=google_not_configured'));
  res.redirect(authService.googleAuthUrl(res, req));
};

/**
 * GET /api/v1/auth/google/callback
 *
 * Google sends the browser here, so the response has to be a redirect to a
 * page rather than JSON. The access token rides back in the URL fragment:
 * fragments are never sent to the server and stay out of server logs and
 * Referer headers, and api.js consumes it and strips it from the address bar
 * immediately (see captureOAuthToken).
 */
const googleCallback = catchAsync(async (req, res) => {
  if (!env.google.enabled) return res.redirect(exitTo(req, res, '?error=google_not_configured'));

  /* The user pressed Cancel, or Google refused. Not an error worth a stack
     trace — send them back to sign in normally. */
  if (req.query.error || !req.query.code) {
    return res.redirect(exitTo(req, res, '?error=google_cancelled'));
  }

  try {
    const { accessToken } = await authService.googleCallback(req, res, {
      code: req.query.code,
      state: req.query.state,
    });
    return res.redirect(exitTo(req, res, '#token=' + encodeURIComponent(accessToken)));
  } catch (err) {
    logger.warn({ err: err.message }, 'Google sign-in failed');
    return res.redirect(exitTo(req, res, '?error=google_failed'));
  }
});

/** POST /api/v1/auth/refresh */
const refresh = catchAsync(async (req, res) => {
  const { accessToken, user } = await authService.refresh(req, res);
  success(res, { message: 'Session refreshed', data: { accessToken, user } });
});

/** POST /api/v1/auth/logout */
const logout = catchAsync(async (req, res) => {
  await authService.logout(req, res);
  success(res, { message: 'Signed out' });
});

/** GET /api/v1/auth/me */
const me = catchAsync(async (req, res) => {
  success(res, { message: 'Session valid', data: { user: req.user } });
});

module.exports = {
  register, login, adminLogin, googleStart, googleCallback, refresh, logout, me,
};
