/**
 * DynamoDB table and index definitions — the single source of truth.
 *
 * Both the table-creation job and the repositories read from here, so an index
 * can never be queried that was not created, or created and then forgotten.
 *
 * ── Why a table per entity, not single-table design ───────────────────────
 * Single-table design wins when you need many related entities fetched in one
 * round trip under tight latency budgets. This application does not: the
 * access patterns below are simple lookups by id, by owner, or by status, and
 * the whole catalogue is a few hundred rows. A table per entity is far easier
 * to read, to back up, to delete selectively, and to reason about in the
 * console — and it costs nothing extra, because DynamoDB bills per request
 * and per stored byte, not per table.
 *
 * ── Keys ──────────────────────────────────────────────────────────────────
 * Ids stay 24-character hex, the same shape MongoDB's ObjectId produced.
 * The route validators enforce /^[0-9a-fA-F]{24}$/, and migrated rows keep
 * the ids they already had, so every existing URL and foreign key survives
 * the move untouched.
 *
 * ── Capacity ──────────────────────────────────────────────────────────────
 * PAY_PER_REQUEST: no capacity planning, no idle cost, and it stays inside
 * the DynamoDB free tier at this volume. Switch to PROVISIONED only if the
 * traffic ever becomes predictable enough to be worth the commitment.
 */
'use strict';

const PREFIX = process.env.DYNAMO_TABLE_PREFIX || '99w';
const t = (name) => `${PREFIX}_${name}`;

/* Attribute types: S = string, N = number. Only attributes used in a key or
   an index are declared — everything else is schemaless, as DynamoDB intends. */

const TABLES = {
  users: {
    name: t('users'),
    hash: 'id',
    attributes: { id: 'S', email: 'S', googleId: 'S', role: 'S', createdAt: 'S' },
    indexes: [
      /* Sign-in, and the uniqueness check on registration. */
      { name: 'email-index', hash: 'email', project: 'ALL' },
      /* Google OAuth: find the account behind a Google subject id. */
      { name: 'googleId-index', hash: 'googleId', project: 'ALL' },
      /* Staff lookup, and the admin user list, newest first. */
      { name: 'role-createdAt-index', hash: 'role', range: 'createdAt', project: 'ALL' },
    ],
  },

  properties: {
    name: t('properties'),
    hash: 'id',
    attributes: { id: 'S', status: 'S', owner: 'S', city: 'S', createdAt: 'S' },
    indexes: [
      /* The public catalogue and every admin queue: approved / pending /
         rejected, newest first. This is the workhorse index. */
      { name: 'status-createdAt-index', hash: 'status', range: 'createdAt', project: 'ALL' },
      /* "My listings" for an owner or agency. */
      { name: 'owner-createdAt-index', hash: 'owner', range: 'createdAt', project: 'ALL' },
      /* City landing pages. Secondary filters (type, grade, rate, area) ride
         along as a FilterExpression rather than earning their own index —
         they cut a few hundred rows, which is not worth the write cost. */
      { name: 'city-createdAt-index', hash: 'city', range: 'createdAt', project: 'ALL' },
    ],
  },

  /* The one entity that is a natural fit: a favourite IS its composite key, so
     adding one is an idempotent Put and removing one is a Delete. No index,
     no read-modify-write, no duplicate rows possible. */
  favorites: {
    name: t('favorites'),
    hash: 'user',
    range: 'property',
    attributes: { user: 'S', property: 'S' },
    indexes: [],
  },

  enquiries: {
    name: t('enquiries'),
    hash: 'id',
    attributes: { id: 'S', user: 'S', property: 'S', feed: 'S', createdAt: 'S' },
    indexes: [
      { name: 'user-createdAt-index', hash: 'user', range: 'createdAt', project: 'ALL' },
      { name: 'property-createdAt-index', hash: 'property', range: 'createdAt', project: 'ALL' },
      /* The admin inbox needs every enquiry in date order. A Scan would read
         the table and sort in memory; instead every row carries the literal
         string "ENQUIRY" in `entity`, giving one partition sorted by date.
         The tradeoff is a single hot partition on write — fine at this volume,
         and the note in enquiry.repo.js says what to do if it stops being so. */
      { name: 'feed-createdAt-index', hash: 'feed', range: 'createdAt', project: 'ALL' },
    ],
  },

  reviews: {
    name: t('reviews'),
    /* property + author as the composite key enforces one review per person
       per property as a property of the data model, rather than something the
       application has to remember to check. */
    hash: 'property',
    range: 'author',
    attributes: { property: 'S', author: 'S', id: 'S', status: 'S', createdAt: 'S' },
    indexes: [
      /* Moderation acts on a review id, which is not the table key. */
      { name: 'id-index', hash: 'id', project: 'ALL' },
      /* The pending-review queue. */
      { name: 'status-createdAt-index', hash: 'status', range: 'createdAt', project: 'ALL' },
    ],
  },

  auditlogs: {
    name: t('auditlogs'),
    hash: 'id',
    attributes: { id: 'S', feed: 'S', createdAt: 'S' },
    indexes: [
      { name: 'feed-createdAt-index', hash: 'feed', range: 'createdAt', project: 'ALL' },
    ],
    /* Audit rows are append-only and only the recent ones are ever read.
       expiresAt holds a unix timestamp; DynamoDB deletes expired rows for
       free, which keeps the table from growing without bound. */
    ttlAttribute: 'expiresAt',
  },

  /* METADATA ONLY. The bytes live in S3.
     A DynamoDB item is capped at 400KB, and one property photo stored at four
     widths exceeds that on its own, so image data cannot go here at any size
     worth serving. storage.service.js already implements S3 — this table holds
     the keys that point at it. */
  images: {
    name: t('images'),
    hash: 'id',
    attributes: { id: 'S', property: 'S', createdAt: 'S' },
    indexes: [
      { name: 'property-createdAt-index', hash: 'property', range: 'createdAt', project: 'ALL' },
    ],
  },
};

/** Literal partition values for the constant-partition indexes above. */
const PARTITION = { ENQUIRY: 'ENQUIRY', AUDIT: 'AUDIT' };

module.exports = { TABLES, PARTITION, PREFIX };
