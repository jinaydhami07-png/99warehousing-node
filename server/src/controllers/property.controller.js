/**
 * Property controller — HTTP layer only.
 * Pulls validated data off the request, calls a service, shapes the response.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created, paginated } = require('../utils/ApiResponse');
const { getPagination } = require('../utils/pagination');
const propertyService = require('../services/property.service');

/** GET /api/v1/properties — public feed, approved listings only */
const list = catchAsync(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const result = await propertyService.listPublic({ page, limit, skip, ...req.query });
  paginated(res, { ...result, message: 'Properties retrieved' });
});

/** GET /api/v1/properties/mine — the signed-in user's own submissions */
const listMine = catchAsync(async (req, res) => {
  const items = await propertyService.listMine(req.user._id);
  success(res, { message: 'Your listings retrieved', data: { items } });
});

/** GET /api/v1/properties/:id */
const getOne = catchAsync(async (req, res) => {
  const item = await propertyService.getById(req.params.id, req.user);
  success(res, { message: 'Property retrieved', data: { item } });
});

/** GET /api/v1/properties/:id/contact — signed-in users only */
const getContact = catchAsync(async (req, res) => {
  const contact = await propertyService.getContact(req.params.id, req.user);
  success(res, { message: 'Contact details retrieved', data: { contact } });
});

/** POST /api/v1/properties — submit for review */
const create = catchAsync(async (req, res) => {
  const item = await propertyService.create(req.body, req.user);
  created(res, { data: { item } });
});

/** PATCH /api/v1/properties/:id */
const update = catchAsync(async (req, res) => {
  const item = await propertyService.update(req.params.id, req.body, req.user);
  success(res, { message: 'Property updated', data: { item } });
});

/** DELETE /api/v1/properties/:id */
const remove = catchAsync(async (req, res) => {
  await propertyService.remove(req.params.id, req.user);
  success(res, { message: 'Property deleted' });
});

/* ── Admin ───────────────────────────────────────────────── */

/** GET /api/v1/properties/admin/all — every status */
const listAll = catchAsync(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const result = await propertyService.listAll({ page, limit, skip, ...req.query });
  paginated(res, { ...result, message: 'All properties retrieved' });
});

/** GET /api/v1/properties/admin/stats */
const stats = catchAsync(async (req, res) => {
  const data = await propertyService.stats();
  success(res, { message: 'Stats retrieved', data });
});

/** PATCH /api/v1/properties/:id/approve */
const approve = catchAsync(async (req, res) => {
  const item = await propertyService.approve(req.params.id, req.user);
  success(res, { message: 'Property approved', data: { item } });
});

/** PATCH /api/v1/properties/:id/reject */
const reject = catchAsync(async (req, res) => {
  const item = await propertyService.reject(req.params.id, req.body.reason, req.user);
  success(res, { message: 'Property rejected', data: { item } });
});

module.exports = {
  list, listMine, getOne, getContact, create, update, remove, listAll, stats, approve, reject,
};
