/**
 * Environment loading and validation.
 *
 * Every environment variable is read HERE and nowhere else, so the rest of
 * the codebase imports a typed, validated config object rather than reaching
 * into `process.env` at arbitrary call sites. That keeps secrets in one
 * auditable place and makes a missing variable a startup failure with a
 * clear message, instead of an undefined-shaped bug at 3am.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

/* Load the settings file from the server directory.
 *
 * `.env` is the real name and is tried first. `env` — same contents, no
 * leading dot — is accepted as a fallback because cPanel's File Manager
 * hides dotfiles by default and routinely drops the dot when a file is
 * uploaded, extracted, or renamed through the web UI. The app then starts
 * with no configuration at all and fails with a message about a missing
 * variable, which points nowhere near the real cause: the file is sitting
 * right there, spelled slightly wrong.
 *
 * Accepting both costs one fs.existsSync at boot and removes an entire
 * category of deployment failure. `.env` still wins when both exist, so
 * nothing changes for a normal install. */
const ENV_DIR = path.join(__dirname, '..', '..');
const ENV_FILE = [
  path.join(ENV_DIR, '.env'),
  path.join(ENV_DIR, 'env'),
].find((f) => fs.existsSync(f));

if (ENV_FILE) require('dotenv').config({ path: ENV_FILE });

/** Treats blanks and leftover `<< PASTE … >>` placeholders as unset. */
const optional = (schema) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (!t || t.includes('<<') || t.includes('>>')) return undefined;
    return t;
  }, schema.optional());

const required = (name) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string({ required_error: `${name} is required` }).min(1, `${name} must not be empty`)
  );

const csv = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /* Usually a port number. But Phusion Passenger — what cPanel's "Setup
     Node.js App" runs behind — hands some configurations a Unix socket PATH
     in PORT instead. z.coerce.number() turns that into NaN, .int() then
     rejects it, and the app refuses to start with a validation error that
     says nothing about the real cause: a 503 in cPanel and no obvious reason
     in stderr.log.

     Accept both. net.Server#listen takes a pipe/socket path just as happily
     as a port, so passing the raw string through is all that is needed. */
  PORT: z
    .union([z.coerce.number().int().positive(), z.string().min(1)])
    .default(5000),

  /* Never hardcoded, never committed — see .env.example */
  MONGODB_URI: required('MONGODB_URI'),
  MONGO_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
  MONGO_MIN_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),

  /* Comma-separated list. CORS is an allow-list, never `*` with credentials. */
  CORS_ORIGINS: z.string().default('http://localhost:5000'),

  JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('7d'),

  RATE_LIMIT_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  BODY_LIMIT: z.string().default('100kb'),

  ADMIN_PASSKEY: optional(z.string()),

  /* Google sign-in. All three are optional: leaving them unset simply turns
     the feature off rather than stopping the server, so a deployment without
     Google still boots. */
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  /* Must match a redirect URI registered in the Google Cloud console
     character for character, or Google rejects the request. */
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:5000/api/v1/auth/google/callback'),

  /* Additional registered callbacks, comma-separated.
     The one whose origin matches the incoming request is used, so the same
     build works on localhost and on the live domain without editing config
     between them. Every entry must also be registered with Google. */
  GOOGLE_CALLBACK_URLS: z.string().default(''),

  /* ── AWS S3 media storage ────────────────────────────────────
     Photos and floor plans live in S3; MongoDB keeps only text — the
     metadata and the URLs that point at the objects.

     Every one of these is optional so the server still boots before the
     bucket exists. With no bucket configured the uploader falls back to
     storing bytes in MongoDB exactly as it did before, which keeps
     development and the existing production data working. The fallback is
     announced at startup rather than left to be discovered later. */
  /* The switch. 'mongo' keeps everything in the database and ignores the
     AWS settings below entirely, even if they are filled in — which is what
     makes it safe to leave real credentials in place while deliberately not
     using them. 'auto' (the default) uses S3 when a bucket and region are
     configured and MongoDB when they are not. 's3' insists on S3 and
     refuses to start without it, so a production box cannot quietly fall
     back to filling the database with image bytes. */
  MEDIA_DRIVER: z.enum(['auto', 'mongo', 's3']).default('auto'),

  AWS_REGION: optional(z.string()),
  AWS_S3_BUCKET: optional(z.string()),

  /* Leave both blank on EC2/ECS/Lightsail and the SDK picks up the
     instance role instead — long-lived keys in a file are the worse of the
     two options wherever a role is available. */
  AWS_ACCESS_KEY_ID: optional(z.string()),
  AWS_SECRET_ACCESS_KEY: optional(z.string()),

  /* CloudFront (or any CDN) domain in front of the bucket. Without it URLs
     point straight at S3, which works but is slower and bills egress at the
     S3 rate. Stored per image at upload time, so changing this later does
     not rewrite URLs already saved. */
  AWS_S3_PUBLIC_BASE_URL: optional(z.string()),

  /* Key prefix inside the bucket, so one bucket can host several
     environments without them colliding. */
  AWS_S3_PREFIX: z.string().default('media'),

  /* Buckets created after April 2023 have ACLs disabled and reject any
     request carrying one. Set to 'public-read' only for an older bucket
     whose objects are served directly without a CDN. */
  AWS_S3_ACL: optional(z.enum(['public-read', 'private'])),

  /* Points the S3 client somewhere other than AWS. Left unset for real S3.
     Set it for an S3-compatible store — MinIO, Cloudflare R2, DigitalOcean
     Spaces — or for LocalStack in a test environment. Path-style addressing
     comes with it, because those services generally do not offer the
     bucket-as-subdomain form that AWS defaults to. */
  AWS_S3_ENDPOINT: optional(z.string().url()),

  /* Widths generated for each upload. The browser picks one from the
     srcset, so a phone never downloads the 1920px file. */
  MEDIA_WIDTHS: z.string().default('320,640,1280,1920'),
  MEDIA_WEBP_QUALITY: z.coerce.number().int().min(40).max(95).default(78),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n  ✖ Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    console.error(`     • ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n  Copy server/.env.example to server/.env and fill in the values.\n');
  process.exit(1);
}

const raw = parsed.data;

/* MEDIA_DRIVER=s3 is an assertion, not a preference: it says this
   deployment must not store image bytes in the database. Honour it in every
   environment, not just production — the whole point is that it cannot
   silently degrade. */
if (raw.MEDIA_DRIVER === 's3' && !(raw.AWS_S3_BUCKET && raw.AWS_REGION)) {
  console.error(
    '\n  ✖ MEDIA_DRIVER=s3 requires AWS_S3_BUCKET and AWS_REGION.\n' +
      '    Set them, or use MEDIA_DRIVER=auto / mongo.\n'
  );
  process.exit(1);
}

/* Fail fast on footguns that are legal strings but wrong in practice. */
if (raw.JWT_ACCESS_SECRET === raw.JWT_REFRESH_SECRET) {
  console.error('\n  ✖ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.\n');
  process.exit(1);
}

/* Production refuses to start on a misconfiguration rather than booting with
   it. Every check here is for something that is survivable in development but
   is a live vulnerability once the app is on the internet — and each one is a
   mistake that is easy to make by copying .env.example and moving on. */
if (raw.NODE_ENV === 'production') {
  const fatal = [];

  const weak = [raw.JWT_ACCESS_SECRET, raw.JWT_REFRESH_SECRET].filter((s) => s.length < 32);
  if (weak.length) fatal.push('JWT secrets must be at least 32 characters.');

  if (raw.JWT_ACCESS_SECRET === raw.JWT_REFRESH_SECRET) {
    fatal.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ — sharing one key ' +
      'lets a stolen access token be replayed as a refresh token.'
    );
  }

  /* Anything still carrying the template's wording, or labelled for
     development, was almost certainly copied rather than generated. */
  const placeholder = /^(<|change|changeme|placeholder|dev[_-]|test[_-]|secret$)/i;
  if (placeholder.test(raw.JWT_ACCESS_SECRET) || placeholder.test(raw.JWT_REFRESH_SECRET)) {
    fatal.push(
      'JWT secrets still look like development placeholders. Generate real ones:\n' +
      "        node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
  }

  if (raw.ADMIN_PASSKEY) {
    if (raw.ADMIN_PASSKEY.startsWith('<')) {
      fatal.push('ADMIN_PASSKEY is still the placeholder from .env.example.');
    } else if (raw.ADMIN_PASSKEY.length < 12) {
      fatal.push(
        'ADMIN_PASSKEY must be at least 12 characters — it is the only thing ' +
        'standing between the internet and the moderation dashboard.'
      );
    }
  }

  if (csv(raw.CORS_ORIGINS).some((o) => o === '*')) {
    fatal.push('CORS_ORIGINS cannot be "*" — credentials are sent with requests.');
  }

  /* A callback still pointing at localhost sends every production sign-in to
     a machine that is not the server. Over plain http it also puts the
     authorization code on the wire in clear. */
  if (raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET) {
    if (/localhost|127\.0\.0\.1/.test(raw.GOOGLE_CALLBACK_URL)) {
      fatal.push('GOOGLE_CALLBACK_URL still points at localhost. Set it to the live domain.');
    } else if (!/^https:\/\//i.test(raw.GOOGLE_CALLBACK_URL)) {
      fatal.push('GOOGLE_CALLBACK_URL must use https in production.');
    }
  }
  if (csv(raw.CORS_ORIGINS).some((o) => /^https?:\/\/localhost/i.test(o))) {
    fatal.push('CORS_ORIGINS still contains localhost. Set it to the real domain.');
  }

  /* Rate limiting and audit logs key off req.ip. Behind a proxy or load
     balancer that is the proxy's address unless trust proxy is set, so every
     visitor shares one bucket and the limits protect nothing. */
  if (String(raw.TRUST_PROXY) === '0' || raw.TRUST_PROXY === undefined) {
    fatal.push(
      'TRUST_PROXY is off. Behind a reverse proxy (Render, Railway, nginx, an ' +
      'ALB) every request appears to come from the proxy, so rate limits apply ' +
      'to all users at once. Set TRUST_PROXY=1 when a proxy terminates TLS.'
    );
  }

  /* Half-configured S3 is worse than none: the driver needs both halves, so
     one without the other silently keeps writing binaries into MongoDB and
     the mistake only surfaces when the database bloats.

     Skipped when MEDIA_DRIVER=mongo, which says the operator has chosen
     MongoDB on purpose — a deliberate choice is not a misconfiguration, and
     failing to start over it would be the tool second-guessing them. */
  /* Only a BUCKET without a region is a mistake worth refusing over: it says
     "use S3" and then silently cannot, so uploads land in MongoDB unnoticed.

     A REGION without a bucket is not evidence of anything. AWS Lambda — and
     so Vercel, Netlify and anything else built on it — injects AWS_REGION
     into every function, whether or not the app has heard of S3. This used to
     be a two-way check, which refused to start on every Lambda host with no
     S3 configured at all. media.driver below already requires both values
     before choosing S3, so a lone region resolves to MongoDB correctly. */
  if (raw.MEDIA_DRIVER !== 'mongo' && raw.AWS_S3_BUCKET && !raw.AWS_REGION) {
    fatal.push(
      'AWS_S3_BUCKET is set but AWS_REGION is not. Without a region, uploads ' +
      'fall back to storing image bytes in MongoDB. Set AWS_REGION, or set ' +
      'MEDIA_DRIVER=mongo if MongoDB storage is what you actually want.'
    );
  }

  if (fatal.length) {
    console.error('\n  ✖ Refusing to start in production:\n');
    fatal.forEach((m) => console.error('    • ' + m));
    console.error('');
    process.exit(1);
  }
}

const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  bodyLimit: raw.BODY_LIMIT,
  trustProxy: raw.TRUST_PROXY,
  logLevel: raw.LOG_LEVEL,

  mongo: {
    uri: raw.MONGODB_URI,
    maxPoolSize: raw.MONGO_POOL_SIZE,
    minPoolSize: raw.MONGO_MIN_POOL_SIZE,
  },

  corsOrigins: csv(raw.CORS_ORIGINS),

  jwt: {
    accessSecret: raw.JWT_ACCESS_SECRET,
    refreshSecret: raw.JWT_REFRESH_SECRET,
    accessExpires: raw.JWT_ACCESS_EXPIRES,
    refreshExpires: raw.JWT_REFRESH_EXPIRES,
  },

  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MIN * 60 * 1000,
    max: raw.RATE_LIMIT_MAX,
    authMax: raw.AUTH_RATE_LIMIT_MAX,
  },

  bcryptRounds: raw.BCRYPT_ROUNDS,
  adminPasskey: raw.ADMIN_PASSKEY,

  /* Media storage. `driver` is the single flag the rest of the code reads,
     so nothing else has to know that "S3 is configured" means a bucket AND
     a region — and no call site has to re-derive it and get it wrong. */
  media: {
    driver:
      raw.MEDIA_DRIVER === 'mongo'
        ? 'mongo'
        : raw.AWS_S3_BUCKET && raw.AWS_REGION
          ? 's3'
          : 'mongo',
    /* Kept separate from the resolved driver so the startup log can tell
       "switched off on purpose" apart from "never configured" — the two
       need very different responses from whoever reads it. */
    disabled: raw.MEDIA_DRIVER === 'mongo',
    widths: [...new Set(csv(raw.MEDIA_WIDTHS).map(Number).filter((n) => n >= 64 && n <= 4096))]
      .sort((a, b) => a - b),
    webpQuality: raw.MEDIA_WEBP_QUALITY,
    s3: {
      region: raw.AWS_REGION,
      bucket: raw.AWS_S3_BUCKET,
      prefix: raw.AWS_S3_PREFIX.replace(/^\/+|\/+$/g, ''),
      acl: raw.AWS_S3_ACL,
      endpoint: raw.AWS_S3_ENDPOINT,
      /* Undefined when unset, which is what makes the SDK fall through to
         the instance role / shared credentials file. */
      credentials:
        raw.AWS_ACCESS_KEY_ID && raw.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: raw.AWS_ACCESS_KEY_ID, secretAccessKey: raw.AWS_SECRET_ACCESS_KEY }
          : undefined,
      /* Trailing slash trimmed here so every join downstream is a plain
         `base + '/' + key` with no double-slash special case. */
      publicBaseUrl: (raw.AWS_S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '') || undefined,
    },
  },

  google: {
    clientId: raw.GOOGLE_CLIENT_ID,
    clientSecret: raw.GOOGLE_CLIENT_SECRET,
    callbackUrl: raw.GOOGLE_CALLBACK_URL,
    /* Primary first, then any extras. Deduplicated so a value repeated
       across both settings cannot appear twice. */
    callbackUrls: [...new Set([raw.GOOGLE_CALLBACK_URL, ...csv(raw.GOOGLE_CALLBACK_URLS)])]
      .filter(Boolean),
    /* One flag the rest of the code reads, so nothing else has to know that
       "configured" means both halves of the credential are present. */
    enabled: Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET),
  },
});

module.exports = env;
