'use strict';

const express = require('express');
const authController = require('../controllers/auth.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/security');
const schemas = require('../validators/user.validator');

const router = express.Router();

/* authLimiter is applied only to credential endpoints — the routes an
   attacker would target with a password list. Applied to the admin passkey
   too, since that is a single shared secret and therefore the most
   brute-forceable entry point in the whole system. */
router.post('/register', authLimiter, validate(schemas.register), authController.register);
router.post('/login', authLimiter, validate(schemas.login), authController.login);
router.post('/admin', authLimiter, validate(schemas.adminLogin), authController.adminLogin);

/* Full-page redirects — OAuth cannot run inside fetch().

   Not behind authLimiter: that limiter counts failed sign-in attempts, and
   an OAuth round trip is two GETs per attempt, so a user who mistypes their
   Google password a couple of times would be locked out of the button
   itself. The global limiter still applies.

   Both are no-ops that redirect to the login page with an explanatory flag
   when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are absent. */
router.get('/google', authController.googleStart);
router.get('/google/callback', authController.googleCallback);

router.post('/refresh', authController.refresh);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);

module.exports = router;
