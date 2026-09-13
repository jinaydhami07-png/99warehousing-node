/**
 * Route aggregator.
 *
 * Versioning from day one (/api/v1) means a future breaking change can ship
 * as /api/v2 while existing clients keep working.
 */
'use strict';

const express = require('express');

const router = express.Router();

router.use('/health', require('./health.routes'));
router.use('/config', require('./config.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/properties', require('./property.routes'));
router.use('/favorites', require('./favorite.routes'));
router.use('/enquiries', require('./enquiry.routes'));

/* Image upload and delivery. Split across two mounts because writing is
   authenticated while reading must stay public for plain <img> tags. */
const { uploadRouter, imageRouter } = require('./image.routes');
router.use('/upload', uploadRouter);
router.use('/images', imageRouter);
router.use('/admin', require('./admin.routes'));

module.exports = router;
