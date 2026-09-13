/**
 * Security middleware stack.
 *
 * ── A NOTE ON `xss-clean` ──────────────────────────────────────────────
 * You asked for `xss-clean`. It is deprecated and unmaintained — the author
 * archived it in 2022, and installing it now produces an npm deprecation
 * warning. Shipping an abandoned security package to production is a
 * liability: it will never receive a bypass fix.
 *
 * This file implements the same protection with `sanitize-html`, which is
 * actively maintained. `sanitizeInput` below is a drop-in replacement for
 * what xss-clean did (recursively strip HTML/script from request payloads).
 *
 * Worth knowing: input sanitisation is defence-in-depth, not the primary
 * control. The real fix for XSS is contextual escaping at OUTPUT plus a
 * strict Content-Security-Policy — both configured below. Stripping tags on
 * input also corrupts legitimate data (a property description containing
 * "steel < 5mm" loses characters), which is why the strict variant is opt-in
 * per route rather than global.
 * ──────────────────────────────────────────────────────────────────────
 */
'use strict';

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const sanitizeHtml = require('sanitize-html');

const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/* ─────────────────────────────────────────────────────────────
   1. CORS — explicit allow-list, never a wildcard with credentials
   ───────────────────────────────────────────────────────────── */
const corsMiddleware = cors({
  origin(origin, callback) {
    // Same-origin requests and server-to-server tools (curl, Postman) send
    // no Origin header. Allowing them does not weaken browser protection,
    // because the browser is the thing that enforces CORS.
    if (!origin) return callback(null, true);

    if (env.corsOrigins.includes(origin)) return callback(null, true);

    /* In development only, trust any localhost port. The pages are commonly
       opened through a different local server than this one (Live Server on
       5500, http-server on 8080, a bundler on 3000), and a CORS rejection
       there is indistinguishable in the browser from "the API is down" — the
       front-end falls back to demo data and quietly stops saving anything.

       Production keeps the strict allow-list: this branch cannot widen it,
       because isProd short-circuits before the pattern is even tested. */
    if (!env.isProd && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    logger.warn({ origin }, 'Blocked by CORS');
    return callback(new ApiError(403, 'Not allowed by CORS'));
  },
  credentials: true, // required for the refresh-token cookie
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 600, // cache the preflight for 10 minutes
});

/* ─────────────────────────────────────────────────────────────
   2. Helmet — secure HTTP headers
   ───────────────────────────────────────────────────────────── */

/**
 * Every origin a property photo can legitimately come from.
 *
 * Both the CDN and the raw bucket endpoint are listed: images uploaded
 * before a CloudFront distribution existed carry the direct S3 URL, and
 * those listings must keep rendering after one is added.
 */
function mediaImageHosts() {
  const hosts = new Set();
  const { bucket, region, publicBaseUrl, endpoint } = env.media.s3;

  if (publicBaseUrl) {
    try {
      hosts.add(new URL(publicBaseUrl).origin);
    } catch {
      logger.warn({ publicBaseUrl }, 'AWS_S3_PUBLIC_BASE_URL is not a valid URL — ignored in CSP');
    }
  }
  /* An S3-compatible store serves its objects from its own origin. */
  if (endpoint) {
    try {
      hosts.add(new URL(endpoint).origin);
    } catch {
      logger.warn({ endpoint }, 'AWS_S3_ENDPOINT is not a valid URL — ignored in CSP');
    }
  }
  if (bucket && region) {
    hosts.add(`https://${bucket}.s3.${region}.amazonaws.com`);
    hosts.add(`https://s3.${region}.amazonaws.com`); // path-style URLs
  }

  return [...hosts];
}
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' is required only because the front-end pages carry
      // inline <style>/<script>. Remove both once those are extracted to
      // files — an inline-script allowance materially weakens CSP.
      scriptSrc: ["'self'", "'unsafe-inline'"],

      /* Helmet's default is script-src-attr 'none', which blocks inline event
         handler ATTRIBUTES (onclick="…") separately from inline <script>
         blocks. The pages use ~310 of them, so the default silently killed
         every button on the site: the handler functions were defined and the
         attribute was present in the DOM, but the browser refused to compile
         it, leaving element.onclick === null and no console error.

         This grants nothing beyond the 'unsafe-inline' already allowed on
         scriptSrc above — injected markup could execute either way. The real
         hardening is to extract the handlers to addEventListener and then
         drop 'unsafe-inline' from BOTH directives; until then, leaving this
         at 'none' only breaks the site without buying security. */
      scriptSrcAttr: ["'unsafe-inline'"],

      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      /* Images come from wherever they are actually stored. `data:` covers
         the inline blur placeholders; the S3/CloudFront origin is added
         from config rather than hardcoded, so moving the bucket or putting
         a CDN in front of it does not silently break every photo on the
         site with a CSP violation and no visible error. */
      imgSrc: ["'self'", 'data:', 'blob:', ...mediaImageHosts()],
      connectSrc: ["'self'", ...env.corsOrigins],
      frameAncestors: ["'none'"], // clickjacking
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: env.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false, // would block the CDN's images and Google's fonts
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: env.isProd
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
    : false, // never send HSTS over plain http in dev — it poisons localhost
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
});

/* ─────────────────────────────────────────────────────────────
   3. Rate limiting
   ───────────────────────────────────────────────────────────── */
const limiterBase = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(ApiError.tooMany('Too many requests. Please slow down.')),
};

/** Broad limiter applied to the whole API. */
const globalLimiter = rateLimit({
  ...limiterBase,
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  /* Health checks would otherwise consume a load balancer's quota.
     NOTE: this limiter is mounted at '/api', so req.path here is relative to
     that mount ('/v1/health', not '/api/v1/health'). Matching on originalUrl
     avoids depending on where the middleware happens to be mounted. */
  skip: (req) => req.originalUrl.startsWith('/api/v1/health'),
});

/**
 * Tight limiter for credential endpoints — this is the brute-force control.
 * Keyed on IP + email so one attacker cannot lock out every user by
 * exhausting a shared IP bucket, and so rotating emails from one IP still
 * gets throttled.
 */
const authLimiter = rateLimit({
  ...limiterBase,
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  skipSuccessfulRequests: true, // only failed attempts count
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    return `${req.ip}:${email}`;
  },
  handler: (req, res, next) =>
    next(ApiError.tooMany('Too many failed attempts. Try again in a few minutes.')),
});

/** Stricter still for expensive write endpoints (uploads, enquiry spam). */
const writeLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 60 * 1000,
  max: 40,
});

/**
 * Contact reveals — the thing worth stealing on a marketplace.
 *
 * Requiring an account stops anonymous scraping, but an account is cheap to
 * create, so a signed-in scraper could still walk every listing and harvest
 * the owners' phone numbers. This caps how fast that can happen.
 *
 * Keyed per user where possible rather than per IP: an office behind one NAT
 * should not exhaust everyone else's allowance, and a scraper rotating IPs on
 * one account should not get a fresh budget each time.
 */
const contactLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.user ? `u:${req.user._id}` : `ip:${req.ip}`),
  handler: (req, res, next) =>
    next(ApiError.tooMany('You have viewed a lot of contact details. Please try again later.')),
});

/* ─────────────────────────────────────────────────────────────
   4. Data sanitisation
   ───────────────────────────────────────────────────────────── */

/**
 * NoSQL injection: strips keys containing `$` or `.` so a body like
 *   { "email": { "$gt": "" } }
 * cannot turn a findOne into a match-anything query.
 *
 * Express 4 exposes req.query as a mutable object, which this relies on.
 * (Express 5 makes it a getter — that version needs the `onSanitize`
 * variant instead. Pinned to Express 4 in package.json for this reason.)
 */
const mongoSanitizeMiddleware = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn({ ip: req.ip, key, path: req.path }, 'Stripped potential NoSQL injection');
  },
});

/* Keys that must never be copied onto a rebuilt object. Assigning
   out['__proto__'] = {...} does not create an own property — it REPLACES the
   object's prototype. A body of {"__proto__":{"role":"admin"}} would then
   make req.body.role read back as "admin" through the prototype chain, even
   though no such field was sent. Same class of problem for constructor and
   prototype. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Recursively walks an object, applying `fn` to every string leaf. */
function deepMapStrings(value, fn, depth = 0) {
  // Bound the recursion: a deliberately nested payload is a DoS vector.
  if (depth > 10) return value;
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, fn, depth + 1));

  if (value && typeof value === 'object' && value.constructor === Object) {
    // Null-prototype object: even if a forbidden key slipped through, there
    // is no prototype chain for it to poison.
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) {
        logger.warn({ key: k }, 'Dropped prototype-polluting key from request body');
        continue;
      }
      out[k] = deepMapStrings(v, fn, depth + 1);
    }
    // Hand back a normal object so downstream code (Mongoose, Zod) sees the
    // prototype it expects.
    return Object.assign({}, out);
  }

  return value;
}

const stripTags = (s) =>
  sanitizeHtml(s, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'recursiveEscape' });

/**
 * XSS input filter — the maintained replacement for `xss-clean`.
 *
 * Applied to req.body only. Query and params are left intact because they
 * are consumed as data (filters, ids) and are escaped at output; mangling
 * them silently breaks legitimate searches.
 */
function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepMapStrings(req.body, stripTags);
  }
  next();
}

/**
 * HTTP Parameter Pollution.
 *
 * `?sort=rate&sort=area` arrives as an array, which breaks code expecting a
 * string and can bypass validation. `hpp` keeps the last value. `whitelist`
 * names the params where repetition is legitimately meaningful.
 */
const hppMiddleware = hpp({
  whitelist: ['type', 'grade', 'city', 'status', 'tags'],
});

module.exports = {
  corsMiddleware,
  helmetMiddleware,
  globalLimiter,
  authLimiter,
  writeLimiter,
  contactLimiter,
  mongoSanitizeMiddleware,
  sanitizeInput,
  hppMiddleware,
};
