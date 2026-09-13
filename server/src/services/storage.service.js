/**
 * Object storage — the one place that talks to S3.
 *
 * Everything above this file deals in keys and URLs and never imports the
 * AWS SDK, so the day the bucket moves to Cloudflare R2 or back to disk,
 * this file changes and nothing else does.
 *
 * Two behaviours worth knowing about:
 *
 * 1. **The SDK is loaded lazily.** `require('@aws-sdk/client-s3')` happens on
 *    first use, not at startup. A deployment that has not run `npm install`
 *    yet, or one deliberately running without S3, still boots — it just
 *    reports `available: false` and the image service stores bytes in
 *    MongoDB as it always did.
 *
 * 2. **Objects are never made public individually.** The bucket stays
 *    private and CloudFront reads it through an Origin Access Control. That
 *    is why nothing here sets an ACL unless `AWS_S3_ACL` is explicitly
 *    configured for an older bucket — buckets created since April 2023 have
 *    ACLs disabled and reject any request that carries one.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

const cfg = env.media.s3;

/* Resolved once on first use and then reused: constructing an S3Client per
   request would rebuild the credential chain and the HTTP agent every time,
   losing connection reuse on exactly the path that needs it most. */
let client = null;
let sdk = null;
let loadFailed = false;

function load() {
  if (client) return { client, sdk };
  if (loadFailed || env.media.driver !== 's3') return null;

  try {
    sdk = require('@aws-sdk/client-s3');
    client = new sdk.S3Client({
      region: cfg.region,
      credentials: cfg.credentials, // undefined ⇒ instance role / shared config
      maxAttempts: 3,
      /* Both unset for real S3. An endpoint means an S3-compatible store
         (MinIO, R2, Spaces), and those address buckets by path rather than
         by subdomain — a virtual-hosted request to them 404s. */
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    });
    return { client, sdk };
  } catch (err) {
    /* Missing dependency is a configuration problem, not a crash. Say so
       once, loudly, and let the caller fall back. */
    loadFailed = true;
    logger.error(
      { err: err.message },
      'AWS SDK could not be loaded — falling back to MongoDB image storage. ' +
        'Run `npm install` in server/ to enable S3.'
    );
    return null;
  }
}

/** True when uploads should go to S3. Checked before every write. */
function available() {
  return Boolean(load());
}

/**
 * Public URL for a key.
 *
 * Prefers the CDN domain. Without one it falls back to the bucket's regional
 * endpoint, which only resolves if the bucket itself is public — that is the
 * configuration the AWS_S3_ACL setting exists for.
 */
function publicUrl(key) {
  if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl}/${key}`;
  if (cfg.endpoint) return `${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}/${key}`;
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
}

/**
 * A collision-proof key for one upload.
 *
 * Random rather than derived from the filename: two owners uploading
 * `warehouse.jpg` must not land on the same object, and a filename is
 * attacker-controlled text that has no business shaping a storage path.
 * The folder groups every size of one photo together so a delete is a
 * prefix operation rather than a list of guesses.
 */
function newFolder(kind) {
  const id = crypto.randomBytes(12).toString('hex');
  const day = new Date().toISOString().slice(0, 10); // keeps the bucket browsable
  return [cfg.prefix, kind, day, id].filter(Boolean).join('/');
}

/**
 * Uploads one object.
 *
 * `Cache-Control` is a year and immutable because these keys are never
 * rewritten — an edited photo is a new upload under a new key. That is what
 * lets the CDN and the browser skip the revalidation round-trip entirely,
 * and it is most of the reason the pages feel instant on a second visit.
 */
async function put({ key, body, contentType, cacheControl }) {
  const loaded = load();
  if (!loaded) throw ApiError.internal('Object storage is not configured');

  const params = {
    Bucket: cfg.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl || 'public, max-age=31536000, immutable',
  };
  if (cfg.acl) params.ACL = cfg.acl;

  await loaded.client.send(new loaded.sdk.PutObjectCommand(params));
  return { key, url: publicUrl(key) };
}

/**
 * Deletes objects, best-effort.
 *
 * A failed delete must never fail the user's action — the listing is already
 * updated by the time this runs, and an orphaned object costs a fraction of
 * a cent while a thrown error costs the user their edit. Failures are logged
 * so they can be swept up later.
 */
async function remove(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return { deleted: 0 };

  const loaded = load();
  if (!loaded) return { deleted: 0 };

  try {
    if (list.length === 1) {
      await loaded.client.send(
        new loaded.sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: list[0] })
      );
    } else {
      /* DeleteObjects caps at 1000 keys per call. A single photo is at most
         a handful of variants, but a whole property could exceed it. */
      for (let i = 0; i < list.length; i += 1000) {
        await loaded.client.send(
          new loaded.sdk.DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          })
        );
      }
    }
    return { deleted: list.length };
  } catch (err) {
    logger.warn({ err: err.message, keys: list.length }, 'S3 delete failed — objects orphaned');
    return { deleted: 0, error: err.message };
  }
}

/**
 * A one-off reachability check, used by the health route and at startup.
 *
 * Deliberately a HeadBucket rather than a write: it proves the credentials
 * and the bucket name resolve without leaving a test object behind.
 */
async function check() {
  const loaded = load();
  if (!loaded) return { driver: 'mongo', ok: false, reason: 'S3 not configured' };

  try {
    await loaded.client.send(new loaded.sdk.HeadBucketCommand({ Bucket: cfg.bucket }));
    return { driver: 's3', ok: true, bucket: cfg.bucket, region: cfg.region, cdn: Boolean(cfg.publicBaseUrl) };
  } catch (err) {
    return { driver: 's3', ok: false, bucket: cfg.bucket, reason: err.name || err.message };
  }
}

/** File extension for a content type — S3 keys carry one so a direct link
    downloads with a sensible filename and CloudFront logs stay readable. */
const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

const extFor = (contentType) => EXT[contentType] || '.bin';

/** Strips a key back out of a stored URL, for deleting objects saved before
    the key was recorded separately. */
function keyFromUrl(url) {
  if (!url) return null;
  try {
    const p = new URL(url, 'https://placeholder.invalid').pathname;
    return decodeURIComponent(p.replace(/^\/+/, '')) || null;
  } catch {
    return null;
  }
}

module.exports = {
  available,
  publicUrl,
  newFolder,
  put,
  remove,
  check,
  extFor,
  keyFromUrl,
  join: (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
  basename: (name) => path.basename(String(name || '')),
};
