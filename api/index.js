/**
 * Vercel serverless entry point.
 *
 * cPanel/Passenger runs app.js, which starts a long-lived process and calls
 * app.listen(). Vercel has no long-lived process: it invokes a handler per
 * request and may run many instances at once. So this file does what
 * server.js does *minus* the listening, and adds the two things serverless
 * actually requires.
 *
 * 1. The database connection is cached on globalThis, not in a module
 *    variable. Vercel reuses a warm instance for many requests but may also
 *    re-evaluate modules; without a cache outside module scope every cold
 *    start opens a new MongoDB connection, and a burst of traffic exhausts
 *    the Atlas connection limit. Caching the PROMISE (not the result) also
 *    means concurrent first requests share one connection attempt instead of
 *    racing to open several.
 *
 * 2. A failed connection is not fatal here either. It clears the cache so the
 *    next request retries, and returns 503 with a readable message rather
 *    than a Vercel crash page that says nothing.
 *
 * Static pages are NOT served through this function — vercel.json routes only
 * /api/* here, and the CDN serves public/ directly, which is faster and does
 * not burn function invocations.
 */
'use strict';

const app = require('../server/src/app');
const database = require('../server/src/config/database');
const logger = require('../server/src/config/logger');

/* Survives module re-evaluation within the same warm instance. */
const globalCache = globalThis.__bpsfDb || (globalThis.__bpsfDb = { promise: null });

function connectOnce() {
  if (!globalCache.promise) {
    globalCache.promise = database.connect().catch((err) => {
      /* Drop the rejected promise so the next request tries again rather than
         re-awaiting a permanently failed one. */
      globalCache.promise = null;
      throw err;
    });
  }
  return globalCache.promise;
}

module.exports = async function handler(req, res) {
  try {
    await connectOnce();
  } catch (err) {
    logger.error({ err: err.message }, 'Database unavailable for this invocation');
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        message:
          'The database is unreachable. If this is a new deployment, check that ' +
          'MONGODB_URI is set in the Vercel project settings and that 0.0.0.0/0 ' +
          'is allowed under MongoDB Atlas → Network Access (Vercel functions do ' +
          'not have a fixed IP).',
      })
    );
    return;
  }

  /* An Express app is already a (req, res) handler. */
  return app(req, res);
};
