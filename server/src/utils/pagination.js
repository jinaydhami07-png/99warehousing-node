/**
 * Normalises pagination query params.
 *
 * The hard cap on `limit` is a denial-of-service control: without it a
 * client can request ?limit=1000000 and force the database to materialise
 * an entire collection into memory.
 */
'use strict';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getPagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const requested = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { getPagination, DEFAULT_LIMIT, MAX_LIMIT };
