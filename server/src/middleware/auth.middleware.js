/**
 * Authentication and authorisation.
 *
 * `authenticate` proves who the caller is; `authorize` decides what they may
 * do. Keeping them separate means a route can require a session without
 * restricting by role, and role checks read declaratively at the route:
 *
 *   router.get('/users', authenticate, authorize('admin'), controller.listUsers)
 *
 * This is the real enforcement point. A hidden button in the UI is a
 * convenience; this is what actually stops the request.
 */
'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/user.model');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Rejects the request unless a valid, current access token is present. */
const authenticate = catchAsync(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Sign in to continue');

  /* jwt.verify throws on bad signature/expiry; the error handler maps those
     to friendly 401s.

     `algorithms` is pinned explicitly — without it, a token could be
     presented with a different alg header and the library would pick the
     algorithm from attacker-controlled input. `issuer`/`audience` must match
     what auth.service signs, so a token minted for another service (or an
     older deployment) is rejected rather than silently accepted. */
  const payload = jwt.verify(token, env.jwt.accessSecret, {
    algorithms: ['HS256'],
    issuer: 'bpsf-api',
    audience: 'bpsf-client',
  });

  // Re-read the user on every request rather than trusting the token body.
  // A token minted before a role change or deactivation must not keep
  // working until it expires.
  const user = await User.findById(payload.sub).select('+tokenVersion +passwordChangedAt');
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  if (user.passwordChangedAfter(payload.iat)) {
    throw ApiError.unauthorized('Password was changed. Please sign in again.');
  }

  req.user = user;
  next();
});

/** Attaches req.user when a token is present, but never rejects. */
const optionalAuth = catchAsync(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.jwt.accessSecret, {
      algorithms: ['HS256'],
      issuer: 'bpsf-api',
      audience: 'bpsf-client',
    });
    const user = await User.findById(payload.sub);
    if (user?.isActive) req.user = user;
  } catch {
    // Anonymous is a valid state for these routes.
  }
  next();
});

/** Role gate. Must run after `authenticate`. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden(`This action requires the ${roles.join(' or ')} role`));
  }
  next();
};

/**
 * Ownership gate for /:id routes. Admins bypass; everyone else must own the
 * document. `loadResource` returns the document (or null).
 */
const authorizeOwner = (loadResource, ownerField = 'owner') =>
  catchAsync(async (req, res, next) => {
    if (!req.user) throw ApiError.unauthorized();

    const doc = await loadResource(req);
    if (!doc) throw ApiError.notFound();

    if (req.user.role !== 'admin') {
      const ownerId = String(doc[ownerField]?._id || doc[ownerField] || '');
      if (ownerId !== String(req.user._id)) {
        throw ApiError.forbidden('You can only modify your own resources');
      }
    }

    req.resource = doc; // hand it on so the controller need not re-query
    next();
  });

module.exports = { authenticate, optionalAuth, authorize, authorizeOwner };
