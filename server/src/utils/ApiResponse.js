/**
 * A single response envelope for every endpoint.
 *
 * Consistency matters more than elegance here: clients can rely on
 * `success` being present on every response, success or failure, so error
 * handling never depends on guessing the shape.
 */
'use strict';

const success = (res, { statusCode = 200, message = 'OK', data = null, meta } = {}) =>
  res.status(statusCode).json({
    success: true,
    message,
    ...(data !== null ? { data } : {}),
    ...(meta ? { meta } : {}),
  });

const created = (res, opts = {}) => success(res, { statusCode: 201, message: 'Created', ...opts });

const noContent = (res) => res.status(204).send();

/** Pagination metadata in a fixed shape so clients can build pagers generically. */
const paginated = (res, { items, page, limit, total, message = 'OK' }) =>
  success(res, {
    message,
    data: items,
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });

module.exports = { success, created, noContent, paginated };
