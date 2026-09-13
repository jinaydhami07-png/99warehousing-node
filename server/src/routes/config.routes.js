'use strict';

const express = require('express');
const env = require('../config/env');
const { success } = require('../utils/ApiResponse');

const router = express.Router();

/**
 * Non-secret settings the browser legitimately needs, plus which optional
 * integrations are configured — so the UI can explain what is unavailable
 * instead of failing with a confusing 404.
 *
 * Only booleans and public keys are exposed here. No secret ever is.
 */
router.get('/', (req, res) => {
  success(res, {
    message: 'Config retrieved',
    data: {
      features: {
        googleAuth: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        adminAccess: Boolean(env.adminPasskey),
        uploads: false, // no upload route on this server yet
      },
    },
  });
});

module.exports = router;
