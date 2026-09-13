/**
 * Favourite controller — HTTP layer only.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success } = require('../utils/ApiResponse');
const favoriteService = require('../services/favorite.service');

/** GET /api/v1/favorites */
const list = catchAsync(async (req, res) => {
  const items = await favoriteService.list(req.user._id);
  success(res, { message: 'Favourites retrieved', data: { items } });
});

/** POST /api/v1/favorites/:id */
const add = catchAsync(async (req, res) => {
  const data = await favoriteService.add(req.user._id, req.params.id);
  success(res, { message: 'Added to favourites', data });
});

/** DELETE /api/v1/favorites/:id */
const remove = catchAsync(async (req, res) => {
  const data = await favoriteService.remove(req.user._id, req.params.id);
  success(res, { message: 'Removed from favourites', data });
});

module.exports = { list, add, remove };
