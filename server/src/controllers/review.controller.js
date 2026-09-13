/**
 * Review controller — HTTP layer only.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created } = require('../utils/ApiResponse');
const { getPagination } = require('../utils/pagination');
const reviewService = require('../services/review.service');

/** GET /api/v1/properties/:id/reviews — public, published only */
const listForProperty = catchAsync(async (req, res) => {
  const { page, limit } = getPagination(req.query);
  const result = await reviewService.listForProperty(req.params.id, { page, limit });

  /* Not `paginated()`: this response carries the average and count alongside
     the page, and the shared paginated helper would drop them into meta
     where the client would have to know to look for them. */
  success(res, {
    message: 'Reviews retrieved',
    data: {
      items: result.items,
      average: result.average,
      count: result.count,
      total: result.total,
      page: result.page,
      pages: result.pages,
    },
  });
});

/** POST /api/v1/properties/:id/reviews — signed in */
const create = catchAsync(async (req, res) => {
  const { review, replaced } = await reviewService.create(req.params.id, req.body, req.user);
  const message = replaced
    ? 'Your review was updated and is awaiting moderation'
    : 'Thank you — your review is awaiting moderation';

  if (replaced) return success(res, { message, data: { item: review } });
  return created(res, { message, data: { item: review } });
});

/** GET /api/v1/properties/:id/reviews/mine — signed in */
const mine = catchAsync(async (req, res) => {
  const item = await reviewService.mineFor(req.params.id, req.user);
  success(res, { message: 'Your review retrieved', data: { item } });
});

/** DELETE /api/v1/reviews/:id — author or admin */
const remove = catchAsync(async (req, res) => {
  await reviewService.remove(req.params.id, req.user);
  success(res, { message: 'Review deleted' });
});

/* ── Admin ── */

/** GET /api/v1/admin/reviews */
const listPending = catchAsync(async (req, res) => {
  const { page, limit } = getPagination(req.query);
  const result = await reviewService.listPending({ page, limit });
  success(res, { message: 'Reviews retrieved', data: result });
});

/** PATCH /api/v1/admin/reviews/:id */
const moderate = catchAsync(async (req, res) => {
  const item = await reviewService.moderate(req.params.id, req.body, req.user);
  success(res, { message: `Review ${item.status}`, data: { item } });
});

module.exports = { listForProperty, create, mine, remove, listPending, moderate };
