/**
 * Centralised error handling.
 *
 * Everything that throws anywhere in the app funnels through here, so error
 * responses have one shape and internal details are never leaked.
 *
 * The core rule: only errors explicitly marked operational have their
 * message shown to the client in production. A TypeError from a bug becomes
 * a generic 500 — because its message ("Cannot read properties of undefined
 * (reading 'ownerId')") tells an attacker about internal structure.
 */
'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/** Unmatched route → 404, handled by the same formatter as everything else. */
const notFoundHandler = (req, res, next) => {
  next(ApiError.notFound(`Cannot ${req.method} ${req.originalUrl}`));
};

/** Translates known library errors into ApiError with useful messages. */
function normalize(err) {
  if (err instanceof ApiError) return err;

  // ── Mongoose: schema validation ──
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return new ApiError(422, 'Validation failed', { details });
  }

  // ── Mongoose: malformed ObjectId in a path param ──
  if (err instanceof mongoose.Error.CastError) {
    return new ApiError(400, `Invalid value for "${err.path}"`);
  }

  // ── MongoDB: unique index violation ──
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    // Deliberately does not echo the value: on /register that would confirm
    // whether an email is registered, which is an enumeration oracle.
    return new ApiError(409, `That ${field} is already in use`);
  }

  // ── JWT ──
  if (err.name === 'JsonWebTokenError') return ApiError.unauthorized('Invalid authentication token');
  if (err.name === 'TokenExpiredError') return ApiError.unauthorized('Session expired. Please sign in again.');

  // ── Body parser: malformed JSON ──
  if (err.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON in request body');
  if (err.type === 'entity.too.large') return new ApiError(413, 'Request body is too large');

  // ── Zod (if a validator throws outside the validate middleware) ──
  if (err.name === 'ZodError') {
    return new ApiError(422, 'Validation failed', {
      details: err.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
    });
  }

  // Anything else is an unexpected bug.
  return new ApiError(err.statusCode || 500, err.message || 'Internal server error', {
    isOperational: false,
  });
}

/* eslint-disable no-unused-vars */
/**
 * Express identifies error middleware by its four-parameter signature —
 * `next` must stay in the list even though it is unused.
 */
function errorHandler(err, req, res, next) {
  const apiErr = normalize(err);
  const { statusCode, message, details, isOperational } = apiErr;

  // 5xx and non-operational errors are real incidents: log with the stack.
  // 4xx are routine client mistakes: log at warn without the noise.
  const logPayload = {
    err: { message: err.message, name: err.name, ...(env.isProd ? {} : { stack: err.stack }) },
    req: { method: req.method, url: req.originalUrl, ip: req.ip, userId: req.user?.id },
  };

  if (statusCode >= 500 || !isOperational) logger.error(logPayload, 'Unhandled error');
  else logger.warn(logPayload, 'Request error');

  // In production, hide anything that is not a deliberate, user-facing message.
  const clientMessage = !isOperational && env.isProd ? 'Something went wrong on our end' : message;

  res.status(statusCode).json({
    success: false,
    message: clientMessage,
    ...(details ? { errors: details } : {}),
    // A correlation id lets a user quote one string and you find the exact
    // log line, without exposing anything sensitive.
    ...(req.id ? { requestId: req.id } : {}),
    ...(env.isProd ? {} : { stack: err.stack }),
  });
}

module.exports = { errorHandler, notFoundHandler };
