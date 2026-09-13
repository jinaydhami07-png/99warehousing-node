/**
 * Wraps an async route handler so a rejected promise reaches Express's
 * error middleware.
 *
 * Without this, an `await` that throws inside a handler produces an
 * unhandled rejection and the request hangs until it times out — one of the
 * most common production bugs in Express codebases.
 *
 *   router.get('/', catchAsync(async (req, res) => { ... }));
 */
'use strict';

const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = catchAsync;
