/**
 * Express application assembly.
 *
 * MIDDLEWARE ORDER IS LOAD-BEARING. Each block below depends on the ones
 * above it, and reordering them silently creates security holes:
 *
 *   1. trust proxy      — before rate limiting, or every client looks like
 *                         the load balancer and shares one bucket
 *   2. helmet           — before anything that can produce a response
 *   3. cors             — before routes, so preflights are answered
 *   4. body parsers     — before sanitisers, which need a parsed body
 *   5. sanitisers       — before validation and handlers
 *   6. rate limiter     — before routes, after trust proxy
 *   7. routes
 *   8. 404 handler      — after all routes
 *   9. error handler    — last, always
 *
 * This file exports the app without starting it, so tests can import it
 * and issue requests without binding a port.
 */
'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const logger = require('./config/logger');
const routes = require('./routes');
const requestId = require('./middleware/requestId.middleware');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');
const {
  corsMiddleware,
  helmetMiddleware,
  globalLimiter,
  mongoSanitizeMiddleware,
  sanitizeInput,
  hppMiddleware,
} = require('./middleware/security');

const app = express();

/* ── 1. Proxy awareness ────────────────────────────────────────
   Behind nginx / an ALB / Vercel, the socket address is the proxy's.
   Without this, req.ip is the proxy for every request, so the rate
   limiter throttles all users as if they were one client, and logs
   record a useless IP.

   Set TRUST_PROXY to the number of proxies in front of the app.
   Never use `true` — that trusts a client-supplied X-Forwarded-For
   header and lets an attacker spoof their IP to evade rate limits. */
if (env.trustProxy > 0) app.set('trust proxy', env.trustProxy);

/* Do not advertise the framework. */
app.disable('x-powered-by');

/* ── 2. Observability ── */
app.use(requestId);
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  })
);

/* ── 3. Security headers ── */
app.use(helmetMiddleware);

/* ── 4. CORS ── */
app.use(corsMiddleware);

/* ── 5. Body parsing ──
   The size limit is a DoS control: without it a single request can buffer
   an arbitrarily large body into memory. Keep it small and raise it only
   on the specific routes that need it (file upload). */
app.use(express.json({ limit: env.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: env.bodyLimit }));
app.use(cookieParser());

/* ── 6. Sanitisation — must run after parsing, before handlers ── */
app.use(mongoSanitizeMiddleware); // NoSQL injection
app.use(sanitizeInput);           // XSS (maintained xss-clean replacement)
app.use(hppMiddleware);           // HTTP parameter pollution

/* ── 7. Compression ── */
app.use(compression());

/* ── 8. Rate limiting ── */
app.use('/api', globalLimiter);

/* ── 9. Routes ── */
app.use('/api/v1', routes);

/* Serves the static front-end from the same origin as the API, which
   removes CORS from the picture entirely for first-party pages. */
app.use(
  express.static(path.join(__dirname, '..', '..', 'public'), {
    maxAge: env.isProd ? '1d' : 0,
    etag: true,
  })
);

/* ── 10. 404 — after every route ── */
app.use(notFoundHandler);

/* ── 11. Error handler — must be last, and must take four arguments ── */
app.use(errorHandler);

module.exports = app;
