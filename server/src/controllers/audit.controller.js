/**
 * Audit controller — HTTP layer only.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success } = require('../utils/ApiResponse');
const auditService = require('../services/audit.service');

/** GET /api/v1/admin/audit — recent moderation activity */
const list = catchAsync(async (req, res) => {
  const items = await auditService.list({
    limit: req.query.limit,
    entityId: req.query.entityId,
    action: req.query.action,
  });
  success(res, { message: 'Audit log retrieved', data: { items } });
});

module.exports = { list };
