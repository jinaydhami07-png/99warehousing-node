/**
 * Admin routes — the dashboard's surface, mounted at /api/v1/admin.
 *
 * These delegate to the same controllers as the public routes rather than
 * duplicating logic; the difference is the guard in front of them, not the
 * behaviour behind them. Grouping them under one prefix means a single
 * `router.use(authenticate, authorize('admin'))` protects the lot, so a new
 * admin route cannot accidentally ship without a guard.
 */
'use strict';

const express = require('express');
const propertyController = require('../controllers/property.controller');
const userController = require('../controllers/user.controller');
const auditController = require('../controllers/audit.controller');
const enquiryController = require('../controllers/enquiry.controller');
const reviewController = require('../controllers/review.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const propertySchemas = require('../validators/property.validator');
const userSchemas = require('../validators/user.validator');
const enquirySchemas = require('../validators/enquiry.validator');
const reviewSchemas = require('../validators/review.validator');

const router = express.Router();

/* One guard for every route below. Order matters: authenticate populates
   req.user, which authorize then reads. */
router.use(authenticate, authorize('admin'));

/* The dashboard's "All" tab sends status=all, but the validator only accepts
   real statuses (pending/approved/rejected). Treat "all" as "no filter"
   instead of rejecting it with a 400 the user would see as an empty table. */
const normaliseStatus = (req, _res, next) => {
  if (req.query.status === 'all' || req.query.status === '') delete req.query.status;
  next();
};

/* ── Overview ── */
router.get('/stats', propertyController.stats);
router.get('/audit', auditController.list);

/* ── Properties (every status, unlike the public feed) ── */
router.get(
  '/properties',
  normaliseStatus,
  validate(propertySchemas.listQuery),
  propertyController.listAll
);

/* Admins create listings already live — they are the moderators, so there is
   nobody left to review their submission. The service applies this based on
   req.user.role. */
router.post('/properties', validate(propertySchemas.adminCreate), propertyController.create);

/* Moderation. Declared before '/properties/:id' so the literal suffixes are
   not swallowed by the pattern. */
router.patch(
  '/properties/:id/approve',
  validate(propertySchemas.byId),
  propertyController.approve
);
router.patch(
  '/properties/:id/reject',
  validate(propertySchemas.reject),
  propertyController.reject
);

router.patch(
  '/properties/:id',
  validate(propertySchemas.adminUpdate),
  propertyController.update
);
router.delete('/properties/:id', validate(propertySchemas.byId), propertyController.remove);

/* ── Enquiries (the inbox behind the contact form) ── */
router.get('/enquiries', validate(enquirySchemas.listQuery), enquiryController.listAll);
router.patch(
  '/enquiries/:id',
  validate(enquirySchemas.updateStatus),
  enquiryController.update
);

/* ── Reviews (the moderation queue) ──
   Reviews are written by strangers and shown on a public page, so they go
   through the same pending → published path a listing does. */
router.get('/reviews', reviewController.listPending);
router.patch('/reviews/:id', validate(reviewSchemas.moderate), reviewController.moderate);
router.delete('/reviews/:id', validate(reviewSchemas.byId), reviewController.remove);

/* ── Users ── */
router.get('/users', validate(userSchemas.listQuery), userController.listUsers);
router.patch('/users/:id', validate(userSchemas.adminUpdateUser), userController.updateUser);

module.exports = router;
