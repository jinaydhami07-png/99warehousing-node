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
const googleStart = (req, res) => {
  if (!env.google.enabled) return res.redirect('/login.html?error=google_not_configured');
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
  if (!env.google.enabled) return res.redirect('/login.html?error=google_not_configured');

  /* The user pressed Cancel, or Google refused. Not an error worth a stack
     trace — send them back to sign in normally. */
  if (req.query.error || !req.query.code) {
    return res.redirect('/login.html?error=google_cancelled');
  }

  try {
    const { accessToken } = await authService.googleCallback(req, res, {
      code: req.query.code,
      state: req.query.state,
    });
    return res.redirect('/login.html#token=' + encodeURIComponent(accessToken));
  } catch (err) {
    logger.warn({ err: err.message }, 'Google sign-in failed');
    return res.redirect('/login.html?error=google_failed');
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
