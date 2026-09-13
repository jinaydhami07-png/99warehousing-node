/**
 * Moves images that predate S3 out of MongoDB and into the bucket.
 *
 *   node src/jobs/migrate-images-to-s3.js            # migrate everything
 *   node src/jobs/migrate-images-to-s3.js --dry-run  # report, change nothing
 *   node src/jobs/migrate-images-to-s3.js --limit=25 # a first batch
 *   node src/jobs/migrate-images-to-s3.js --only=<imageId>   # exactly one
 *   node src/jobs/migrate-images-to-s3.js --keep-bytes
 *
 * For each image still stored as a Buffer it re-renders the WebP variants,
 * uploads them, rewrites the document to point at S3, and updates every
 * listing that referenced it so the photo appears on its property with the
 * new URL. The old `/api/v1/images/:id` links keep working regardless — the
 * serve route redirects them — so this can be run at any time, in batches,
 * with the site up.
 *
 * Order matters and is deliberate: upload, then repoint the listings, then
 * drop the bytes. If the process dies at any point the worst case is an
 * unused object in the bucket. The bytes are the only irreplaceable thing
 * here, so they are the last to go — and `--keep-bytes` holds them back
 * entirely until you have seen the photos load from the CDN.
 *
 * Requires AWS_S3_BUCKET and AWS_REGION in .env; it refuses to run without
 * them rather than pretending to succeed.
 *
 * NOTE: run it from inside server/ — it uses this project's database config
 * (which carries the DNS fallback) rather than connecting on its own.
 */
'use strict';

const mongoose = require('mongoose');

const database = require('../config/database');
const env = require('../config/env');
const logger = require('../config/logger');
const storage = require('../services/storage.service');
const imageService = require('../services/image.service');
const Image = require('../models/image.model');
const Property = require('../models/property.model');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const KEEP_BYTES = args.includes('--keep-bytes');
const LIMIT = (() => {
  const found = args.find((a) => a.startsWith('--limit='));
  const n = found ? parseInt(found.split('=')[1], 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

/* One specific image. For retrying a single failure, and for trying the
   whole thing on one photo you have picked yourself before turning it
   loose on the collection. */
const ONLY = (() => {
  const found = args.find((a) => a.startsWith('--only='));
  const id = found ? found.split('=')[1].trim() : '';
  if (!id) return null;
  if (!/^[a-f0-9]{24}$/i.test(id)) {
    console.error(`\n  ✖ --only expects a 24-character image id, got "${id}"\n`);
    process.exit(1);
  }
  return id;
})();

/** Repoints every listing that shows this image at its new home. */
async function repointListings(image, descriptor) {
  const publicId = String(image._id);
  const legacyUrl = `/api/v1/images/${publicId}`;

  const fields = {
    url: descriptor.url,
    variants: descriptor.variants,
    blur: descriptor.blur,
    width: descriptor.width,
    height: descriptor.height,
  };

  /* Matched on publicId OR the old URL: some listings were saved before
     publicId was recorded on the subdocument and carry only the URL. */
  const gallery = await Property.updateMany(
    { images: { $elemMatch: { $or: [{ publicId }, { url: legacyUrl }] } } },
    { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`images.$[img].${k}`, v])) },
    { arrayFilters: [{ $or: [{ 'img.publicId': publicId }, { 'img.url': legacyUrl }] }] }
  );

  const plan = await Property.updateMany(
    { $or: [{ 'floorPlan.publicId': publicId }, { 'floorPlan.url': legacyUrl }] },
    { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`floorPlan.${k}`, v])) }
  );

  return gallery.modifiedCount + plan.modifiedCount;
}

async function migrateOne(image) {
  /* The bytes are select:false, so they have to be asked for explicitly —
     the caller's query deliberately does not carry them for every candidate
     at once, which would load the entire old image collection into memory. */
  const withData = await Image.findById(image._id).select('+data +renditions');
  if (!withData) return { skipped: true, reason: 'not found' };

  /* Two shapes to read from. Images stored while S3 was switched off hold a
     set of renditions and no `data`; images from before any of that hold a
     single buffer. Take the largest available either way — it is the closest
     thing left to the original, and everything smaller is re-derived from it
     below rather than upscaled from a thumbnail. */
  const largest = (withData.renditions || [])
    .slice()
    .sort((a, b) => (a.w || 0) - (b.w || 0))
    .pop();

  const source = largest && largest.data && largest.data.length ? largest.data : withData.data;

  if (!source || !source.length) return { skipped: true, reason: 'no bytes stored' };

  const rendered = await imageService.renderVariants(source, withData.kind || 'photo');
  if (!rendered) throw new Error('sharp is unavailable — cannot render variants');

  const folder = storage.newFolder(withData.kind === 'floorplan' ? 'floorplans' : 'photos');

  const uploaded = [];
  for (const r of rendered.renditions) {
    const { key, url } = await storage.put({
      key: `${folder}/w${r.w}.webp`,
      body: r.body,
      contentType: 'image/webp',
    });
    uploaded.push({ w: r.w, h: r.h, key, url, size: r.size });
  }

  const full = uploaded[uploaded.length - 1];

  withData.storage = 's3';
  withData.key = full.key;
  withData.bucket = env.media.s3.bucket;
  withData.url = full.url;
  withData.variants = uploaded;
  withData.blur = rendered.blur;
  withData.contentType = 'image/webp';
  withData.size = uploaded.reduce((n, v) => n + (v.size || 0), 0);
  withData.width = full.w;
  withData.height = full.h;
  if (!KEEP_BYTES) {
    withData.data = undefined;
    withData.renditions = undefined;
  }

  await withData.save();

  /* Dropping a field on a Mongoose document does not always issue an $unset
     — this makes sure the Buffers are actually gone from the collection,
     which is the entire point of the exercise. Both shapes are cleared: a
     document can only have had one of them, and unsetting an absent field
     is a no-op. */
  if (!KEEP_BYTES) {
    await Image.collection.updateOne(
      { _id: withData._id },
      { $unset: { data: '', renditions: '' } }
    );
  }

  const listings = await repointListings(withData, withData.toDescriptor());

  return { skipped: false, listings, bytes: full.size, widths: uploaded.map((u) => u.w) };
}

async function main() {
  if (env.media.driver !== 's3') {
    console.error(
      '\n  ✖ S3 is not configured. Set AWS_S3_BUCKET and AWS_REGION in server/.env\n' +
        '    before running this — there is nowhere to migrate the images to.\n'
    );
    process.exit(1);
  }

  const reachable = await storage.check();
  if (!reachable.ok) {
    console.error(`\n  ✖ Cannot reach the bucket "${env.media.s3.bucket}": ${reachable.reason}\n`);
    process.exit(1);
  }

  await database.connect();

  /* Anything not already on S3. `storage` did not exist before this change,
     so documents written by the old code have no such field at all. */
  const query = { $or: [{ storage: 'mongo' }, { storage: { $exists: false } }] };
  if (ONLY) query._id = new mongoose.Types.ObjectId(ONLY);
  const total = await Image.countDocuments(query);

  console.log(
    ONLY
      ? `\n  ${total} matching image (--only=${ONLY}).`
      : `\n  ${total} image(s) still stored in MongoDB.`
  );
  console.log(`  Target: s3://${env.media.s3.bucket} (${env.media.s3.region})`);
  if (env.media.s3.publicBaseUrl) console.log(`  Served from: ${env.media.s3.publicBaseUrl}`);
  if (DRY_RUN) console.log('  DRY RUN — nothing will be written.');
  if (KEEP_BYTES) console.log('  --keep-bytes — the MongoDB copies will be left in place.');
  console.log('');

  if (!total || DRY_RUN) {
    await mongoose.connection.close();
    return;
  }

  /* Ids only, then one document at a time. A find() over the whole
     collection would be fine for the metadata but this collection is
     exactly the one holding megabytes per row. */
  const ids = await Image.find(query).select('_id kind').limit(LIMIT || 0).lean();

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let repointed = 0;

  for (const [i, ref] of ids.entries()) {
    const label = `[${i + 1}/${ids.length}] ${ref._id}`;
    try {
      const result = await migrateOne(ref);
      if (result.skipped) {
        skipped++;
        console.log(`  ${label} — skipped (${result.reason})`);
      } else {
        done++;
        repointed += result.listings;
        console.log(
          `  ${label} — ${result.widths.join('/')}px, ${Math.round(result.bytes / 1024)} KB, ` +
            `${result.listings} listing(s) updated`
        );
      }
    } catch (err) {
      failed++;
      console.error(`  ${label} — FAILED: ${err.message}`);
      logger.error({ err: err.message, imageId: String(ref._id) }, 'Image migration failed');
    }
  }

  /* Counted without the --only filter: "0 left" must mean the collection is
     clear, not merely that the single image asked for was dealt with. */
  const remaining = await Image.countDocuments({
    $or: [{ storage: 'mongo' }, { storage: { $exists: false } }],
  });

  console.log(
    `\n  Migrated ${done}, skipped ${skipped}, failed ${failed}. ` +
      `${repointed} listing reference(s) repointed.`
  );
  console.log(`  ${remaining} image(s) still in MongoDB.\n`);

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('\n  ✖ Migration aborted:', err.message, '\n');
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
