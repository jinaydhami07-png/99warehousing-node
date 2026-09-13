/**
 * An error that carries an HTTP status and is safe to show a client.
 *
 * The `isOperational` flag is the important part: it distinguishes expected
 * failures (bad input, missing record, wrong password) from genuine bugs.
 * The global error handler shows operational messages verbatim and hides
 * everything else behind a generic 500 in production, so a stack trace or
 * an internal detail never reaches a user.
 */
'use strict';

class ApiError extends Error {
  constructor(statusCode, message, { details = undefined, isOperational = true, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg = 'Bad request', details) { return new ApiError(400, msg, { details }); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(401, msg); }
  static forbidden(msg = 'You do not have permission to perform this action') { return new ApiError(403, msg); }
  static notFound(msg = 'Resource not found') { return new ApiError(404, msg); }
  static conflict(msg = 'Resource already exists', details) { return new ApiError(409, msg, { details }); }
  static unprocessable(msg = 'Validation failed', details) { return new ApiError(422, msg, { details }); }
  static tooMany(msg = 'Too many requests') { return new ApiError(429, msg); }
  static internal(msg = 'Internal server error') { return new ApiError(500, msg, { isOperational: false }); }
}

module.exports = ApiError;
