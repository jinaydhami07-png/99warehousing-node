/**
 * Runs a Zod schema against the request and replaces the raw input with the
 * parsed result.
 *
 * The replacement matters: Zod coerces and strips, so downstream code gets
 * `page` as a number rather than a string, and unknown keys declared with
 * `.strict()` are rejected rather than silently carried along.
 */
'use strict';

const ApiError = require('../utils/ApiError');

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      // Drop the leading "body"/"query" segment so the client sees the
      // field name its form actually uses.
      field: issue.path.slice(1).join('.') || issue.path.join('.'),
      message: issue.message,
    }));
    return next(ApiError.unprocessable('Validation failed', details));
  }

  if (result.data.body) req.body = result.data.body;
  if (result.data.params) req.params = result.data.params;
  // req.query is a getter in some Express versions — assign defensively.
  if (result.data.query) {
    try { req.query = result.data.query; }
    catch { Object.assign(req.query, result.data.query); }
  }

  next();
};

module.exports = validate;
