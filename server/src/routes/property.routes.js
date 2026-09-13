'use strict';

const express = require('express');
const controller = require('../controllers/property.controller');
const reviewController = require('../controllers/review.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate, optionalAuth, authorize } = require('../middleware/auth.middleware');
const { writeLimiter, contactLimiter } = require('../middleware/security');
const schemas = require('../validators/property.validator');
const reviewSchemas = require('../validators/review.validator');

const router = express.Router();

/* ── ROUTE ORDER MATTERS ──────────────────────────────────────
   Express matches in declaration order, so every literal path must be
   declared BEFORE the '/:id' pattern. Otherwise a request to
   /properties/mine is captured by '/:id' with id="mine", which then fails
   ObjectId validation with a confusing 400.
   ───────────────────────────────────────────────────────────── */

/* Admin — mounted first so 'admin' is never swallowed by '/:id'. */
router.get(
  '/admin/all',
  authenticate,
  authorize('admin'),
  validate(schemas.listQuery),
  controller.listAll
);
router.get('/admin/stats', authenticate, authorize('admin'), controller.stats);

/* The owner's own submissions. */
router.get('/mine', authenticate, controller.listMine);

/* Public feed. optionalAuth so a signed-in owner/admin can still be
   identified on the detail route below, without requiring a session. */
router.get('/', validate(schemas.listQuery), controller.list);

/* Create — rate-limited because it writes and can be spammed. */
router.post(
  '/',
  authenticate,
  writeLimiter,
  validate(schemas.create),
  controller.create
);

/* Moderation. Declared before '/:id' for the same ordering reason. */
router.patch(
  '/:id/approve',
  authenticate,
  authorize('admin'),
  validate(schemas.byId),
  controller.approve
);
router.patch(
  '/:id/reject',
  authenticate,
  authorize('admin'),
  validate(schemas.reject),
  controller.reject
);

/* Owner contact details. Declared before '/:id' so the literal suffix is not
   swallowed by the pattern.

   `authenticate` (not optionalAuth) is the whole point: contact details are
   the one thing a signed-out visitor must never obtain, so this rejects
   rather than degrading. contactLimiter then caps how many an account can
   pull in an hour, which is what stops a signed-up scraper. */
router.get(
  '/:id/contact',
  authenticate,
  contactLimiter,
  validate(schemas.byId),
  controller.getContact
);

/* ── Reviews ───────────────────────────────────────────────────
   Nested under the property they belong to, and declared before '/:id' so
   the literal '/reviews' suffix is not swallowed by the pattern.

   Reading is public: a rating nobody can see is worth nothing to a buyer.
   Writing requires a session, which is what ties a review to a real account
   and stops the page filling up with anonymous claims. */
router.get(
  '/:id/reviews',
  validate(reviewSchemas.listForProperty),
  reviewController.listForProperty
);
router.get(
  '/:id/reviews/mine',
  authenticate,
  validate(reviewSchemas.byId),
  reviewController.mine
);
router.post(
  '/:id/reviews',
  authenticate,
  writeLimiter,
  validate(reviewSchemas.create),
  reviewController.create
);

/* Single listing. optionalAuth lets the service decide whether an
   unapproved listing is visible to this particular viewer. */
router.get('/:id', optionalAuth, validate(schemas.byId), controller.getOne);

/* Update / delete. Ownership is enforced inside the service, which also
   knows to send an owner's edit back to pending. Admins get the wider
   schema so they can change status directly. */
router.patch(
  '/:id',
  authenticate,
  (req, res, next) => {
    const schema = req.user?.role === 'admin' ? schemas.adminUpdate : schemas.update;
    return validate(schema)(req, res, next);
  },
  controller.update
);

router.delete('/:id', authenticate, validate(schemas.byId), controller.remove);

module.exports = router;
