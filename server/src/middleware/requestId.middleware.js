/**
 * Assigns a correlation id to every request.
 *
 * It goes into the logs and into error responses, so a user can quote one
 * short string and you can find the exact request that failed — without
 * exposing anything sensitive.
 */
'use strict';

const { randomUUID } = require('crypto');

module.exports = function requestId(req, res, next) {
  // Respect an upstream id (load balancer / gateway) so a trace spans hops.
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
