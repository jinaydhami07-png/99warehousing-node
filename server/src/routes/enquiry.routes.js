/**
 * Enquiry routes — mounted at /api/v1/enquiries.
 */
'use strict';

const express = require('express');
const controller = require('../controllers/enquiry.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate, optionalAuth } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/security');
const schemas = require('../validators/enquiry.validator');

const router = express.Router();

/* '/mine' before any pattern route, and before the public POST, so the
   literal path is never shadowed. */
router.get('/mine', authenticate, controller.listMine);

/* Public on purpose — the contact form must work for signed-out visitors.
   optionalAuth attaches req.user when a session happens to exist so the
   enquiry can be linked to the account; writeLimiter is what stops the open
   endpoint being used as a spam relay. */
router.post('/', optionalAuth, writeLimiter, validate(schemas.create), controller.create);

module.exports = router;
