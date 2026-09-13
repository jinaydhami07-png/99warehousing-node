/**
 * Enquiry controller — HTTP layer only.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created, paginated } = require('../utils/ApiResponse');
const { getPagination } = require('../utils/pagination');
const enquiryService = require('../services/enquiry.service');

/** POST /api/v1/enquiries — public; req.user is present only if signed in */
const create = catchAsync(async (req, res) => {
  const item = await enquiryService.create(req.body, req.user, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  created(res, { message: 'Enquiry received', data: { item } });
});

/** GET /api/v1/enquiries/mine */
const listMine = catchAsync(async (req, res) => {
  const items = await enquiryService.listMine(req.user._id);
  success(res, { message: 'Your enquiries retrieved', data: { items } });
});

/* ── Admin ── */

/** GET /api/v1/admin/enquiries */
const listAll = catchAsync(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const result = await enquiryService.listAll({ page, limit, skip, ...req.query });
  paginated(res, { ...result, message: 'Enquiries retrieved' });
});

/** PATCH /api/v1/admin/enquiries/:id */
const update = catchAsync(async (req, res) => {
  const item = await enquiryService.update(req.params.id, req.body, req.user);
  success(res, { message: 'Enquiry updated', data: { item } });
});

module.exports = { create, listMine, listAll, update };
