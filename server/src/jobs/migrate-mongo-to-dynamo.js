/**
 * Copies every collection from MongoDB into DynamoDB.
 *
 *   node src/jobs/migrate-mongo-to-dynamo.js --dry-run   # count and validate only
 *   node src/jobs/migrate-mongo-to-dynamo.js             # write
 *
 * Properties of this job that matter:
 *
 *   • It READS from MongoDB and never writes to it. A failed run cannot
 *     damage the source, so it can be re-run as often as needed.
 *   • Ids are preserved. _id becomes `id` as the same 24-character hex string,
 *     so every foreign key, bookmark and shared URL keeps working.
 *   • It is idempotent: rows are Put by key, so a second run overwrites rather
 *     than duplicating.
 *   • Image BYTES are refused. DynamoDB caps an item at 400KB and a photo at
 *     four widths is larger. Run `npm run migrate:images` with MEDIA_DRIVER=s3
 *     first; this job then carries only the metadata and the S3 keys.
 */
'use strict';

const mongoose = require('mongoose');
const database = require('../config/database');
const repos = require('../db/dynamo');
const { USER_SECRETS_SELECT } = require('../db/sensitive');

const dryRun = process.argv.includes('--dry-run');

/** ObjectId | string | null → plain 24-hex string | undefined */
const id = (v) => (v == null ? undefined : String(v));

/** Dates become ISO strings: DynamoDB has no date type, and ISO sorts
    lexicographically, which is what the createdAt sort keys rely on. */
const iso = (v) => (v ? new Date(v).toISOString() : undefined);

/** Mongo documents carry _id, __v and nested ObjectIds; none belong in Dynamo. */
function clean(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id' || k === '__v') continue;
    if (v === undefined || v === null) continue;
    if (v instanceof Date) { out[k] = v.toISOString(); continue; }
    if (v instanceof mongoose.Types.ObjectId) { out[k] = String(v); continue; }
    if (Buffer.isBuffer(v)) continue;                  // never migrate bytes
    if (Array.isArray(v)) { out[k] = v.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? clean(x) : (x instanceof mongoose.Types.ObjectId ? String(x) : x))); continue; }
    if (typeof v === 'object') { out[k] = clean(v); continue; }
    out[k] = v;
  }
  return out;
}

const PLAN = [
  {
    label: 'users',
    model: () => require('../models/user.model'),
    /* The password hash, the token version and the lockout counters are all
       `select: false`. A plain find() silently omits them, and the accounts
       arrive in DynamoDB with no password at all — every one of them locked
       out, with nothing in the output to say so. Ask for them by name. */
    select: USER_SECRETS_SELECT,
    to: (d) => ({ ...clean(d), id: id(d._id), email: String(d.email || '').toLowerCase().trim(), createdAt: iso(d.createdAt) || new Date().toISOString() }),
    write: (rows) => repos.users.raw.batchPut(rows),
    /* Nothing else in this job can tell a migrated password from a missing
       one, so check it here rather than discovering it at the first login. */
    check: (docs, rows) => {
      const want = docs.filter((d) => d.password).length;
      const got = rows.filter((r) => /^\$2[aby]\$\d{2}\$/.test(String(r.password || ''))).length;
      return want === got ? null
        : `${want} account(s) have a password in MongoDB but only ${got} carried a bcrypt hash across`;
    },
  },
  {
    label: 'properties',
    model: () => require('../models/property.model'),
    to: (d) => {
      const base = { ...clean(d), id: id(d._id), owner: id(d.owner), createdAt: iso(d.createdAt) || new Date().toISOString() };
      /* Recompute what property.repo derives on write, so rows migrated here
         behave identically to rows created through the API. */
      base.cityLower = d.city ? String(d.city).trim().toLowerCase() : undefined;
      base.searchText = [d.name, d.description, d.city, d.locality, d.type, d.grade]
        .filter(Boolean).join(' ').toLowerCase() || undefined;
      return base;
    },
    write: (rows) => repos.properties.raw.batchPut(rows),
  },
  {
    label: 'favorites',
    model: () => require('../models/favorite.model'),
    to: (d) => ({ user: id(d.user), property: id(d.property), createdAt: iso(d.createdAt) || new Date().toISOString() }),
    write: (rows) => repos.favorites.raw.batchPut(rows.filter((r) => r.user && r.property)),
  },
  {
    label: 'enquiries',
    model: () => require('../models/enquiry.model'),
    /* `feed` is the synthetic partition the admin inbox index reads. It used
       to be written into `entity`, which the index no longer uses. */
    to: (d) => ({ ...clean(d), id: id(d._id), user: id(d.user), property: id(d.property), feed: 'ENQUIRY', createdAt: iso(d.createdAt) || new Date().toISOString() }),
    write: (rows) => repos.enquiries.raw.batchPut(rows),
  },
  {
    label: 'reviews',
    model: () => require('../models/review.model'),
    to: (d) => ({ ...clean(d), id: id(d._id), property: id(d.property), author: id(d.author), status: d.status || 'pending', createdAt: iso(d.createdAt) || new Date().toISOString() }),
    write: (rows) => repos.reviews.raw.batchPut(rows.filter((r) => r.property && r.author)),
  },
  {
    label: 'auditlogs',
    model: () => require('../models/auditlog.model'),
    /* `feed` carries the partition; `entity` keeps its own meaning — what the
       entry is about. Writing the partition constant over it made every row
       in the admin trail claim the same subject. */
    to: (d) => ({ ...clean(d), id: id(d._id), feed: 'AUDIT', entity: d.entity || 'property',
                  createdAt: iso(d.createdAt) || new Date().toISOString(),
                  expiresAt: Math.floor(Date.now() / 1000) + 365 * 86400 }),
    write: (rows) => repos.auditlogs.raw.batchPut(rows),
  },
  {
    label: 'images',
    model: () => require('../models/image.model'),
    to: (d) => {
      const c = clean(d);                      // clean() already drops Buffers
      if (c.renditions) c.renditions = c.renditions.map((r) => { const { data, ...rest } = r; return rest; });
      return { ...c, id: id(d._id), property: id(d.property), storage: d.storage || 's3', createdAt: iso(d.createdAt) || new Date().toISOString() };
    },
    write: (rows) => repos.images.raw.batchPut(rows),
  },
];

(async () => {
  await database.connect();
  console.log(`  mode: ${dryRun ? 'DRY RUN — nothing will be written' : 'WRITE'}`);
  console.log(`  target: ${repos.client.endpoint || 'aws ' + repos.client.region}\n`);

  let grand = 0;
  const warnings = [];

  for (const step of PLAN) {
    const Model = step.model();
    const docs = await (step.select ? Model.find({}).select(step.select) : Model.find({})).lean();
    const rows = docs.map(step.to);

    if (step.check) {
      const failure = step.check(docs, rows);
      if (failure) {
        console.error(`\n  ABORTED on ${step.label}: ${failure}`);
        process.exit(1);
      }
    }

    /* A row missing its key cannot be written, and finding that out mid-batch
       is worse than finding it out now. */
    const bad = rows.filter((r) => Object.values(r).some((v) => v === undefined && false) === false && !r.id && !(r.user && r.property));
    if (step.label === 'images') {
      const withBytes = docs.filter((d) => d.data).length;
      if (withBytes) warnings.push(`${withBytes} image(s) still hold bytes in MongoDB — run \`npm run migrate:images\` with MEDIA_DRIVER=s3 first, or they will reach DynamoDB with no file behind them.`);
    }

    if (!dryRun && rows.length) await step.write(rows);
    grand += rows.length;
    console.log(`  ${step.label.padEnd(12)} ${String(rows.length).padStart(5)} row(s)${bad.length ? `   ⚠ ${bad.length} without a key` : ''}`);
  }

  console.log(`\n  ${grand} row(s) ${dryRun ? 'would be migrated' : 'migrated'}`);
  warnings.forEach((w) => console.log(`\n  ⚠ ${w}`));
  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => { console.error('  FAILED:', e.message); process.exit(1); });
