'use strict';

const express = require('express');
const db = require('../db');
const storage = require('../services/storage.service');
const { success } = require('../utils/ApiResponse');

const router = express.Router();

/**
 * Liveness + readiness in one endpoint.
 *
 * Returns 503 when the database is unreachable so a load balancer or
 * orchestrator stops routing traffic to this instance instead of serving
 * errors to users.
 */
router.get('/', async (req, res) => {
  /* Asks the ACTIVE driver, not MongoDB. The check used to call the Mongoose
     connection directly, so a DynamoDB deployment — which never opens one —
     reported itself permanently degraded while serving every request
     normally. */
  const store = await db.health();
  const status = store.ready ? 200 : 503;

  res.status(status).json({
    success: store.ready,
    message: store.ready ? 'OK' : 'Degraded — database unavailable',
    data: {
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: store.status,
      driver: db.driver,
      /* Which store images are going to. Deliberately not part of the
         ready/not-ready decision: S3 being unreachable degrades uploads,
         but every text page on the site still works, and taking the whole
         instance out of the load balancer over it would be the larger
         outage. Reported so it is visible, not so it fails the check. */
      media: storage.available() ? 's3' : 'mongo',
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
});

/**
 * GET /api/v1/health/media — the S3 credential and bucket check.
 *
 * Its own endpoint because it makes a network call to AWS, which the main
 * health check is hit far too often to afford.
 */
router.get('/media', async (req, res) => {
  const result = await storage.check();
  success(res, { message: result.ok ? 'Object storage reachable' : 'Object storage not in use', data: result });
});

module.exports = router;
