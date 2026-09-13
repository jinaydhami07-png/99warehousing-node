/**
 * User controller — the HTTP layer.
 *
 * Controllers do exactly three things:
 *   1. pull already-validated data off the request
 *   2. call a service
 *   3. shape the response
 *
 * No database queries, no business rules. Every handler is wrapped in
 * catchAsync so a rejected promise reaches the global error handler instead
 * of hanging the request.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created, paginated } = require('../utils/ApiResponse');
const { getPagination } = require('../utils/pagination');
const userService = require('../services/user.service');

/** GET /api/v1/users/me */
const getMe = catchAsync(async (req, res) => {
  // req.user was attached by the authenticate middleware.
  success(res, { message: 'Profile retrieved', data: { user: req.user } });
});

/** PATCH /api/v1/users/me */
const updateMe = catchAsync(async (req, res) => {
  // Deliberately does not forward `role` or `isActive` — a user must not be
  // able to promote themselves by editing their own profile.
  const { name, mobile, company } = req.body;
  const user = await userService.updateUser(req.user.id, { name, mobile, company });
  success(res, { message: 'Profile updated', data: { user } });
});

/** GET /api/v1/users  (admin) */
const listUsers = catchAsync(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const result = await userService.listUsers({
    page,
    limit,
    skip,
    role: req.query.role,
    search: req.query.search,
  });
  paginated(res, { ...result, message: 'Users retrieved' });
});

/** GET /api/v1/users/:id  (admin) */
const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  success(res, { message: 'User retrieved', data: { user } });
});

/** POST /api/v1/users  (admin) */
const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  created(res, { data: { user } });
});

/** PATCH /api/v1/users/:id  (admin) */
const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);
  success(res, { message: 'User updated', data: { user } });
});

module.exports = { getMe, updateMe, listUsers, getUser, createUser, updateUser };
