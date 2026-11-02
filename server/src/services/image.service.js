/**
 * Image service — turns an uploaded file into something a page can load fast.
 *
 * The pipeline, in order:
 *
 *   sniff → the format is read from the bytes, never from the client's claim
 *   normalise → EXIF rotation applied, then all metadata stripped
 *   resize → one WebP per configured width, never upscaled past the original
 *   blur → a ~20px WebP inlined as a data URI, for the first paint
 *   store → objects to S3, text to MongoDB
 *
 * Why it is worth doing all of that on the way in rather than serving the
 * original: a phone photo is typically 4000px wide and several megabytes,
 * and a listing card displays it at about 400px. Sending the original wastes
 * roughly 95% of the bytes on every card in the feed. Re-encoding once at
 * upload turns that into ~30 KB per card, permanently, for every visitor.
 *
 * Stripping metadata is not only a size win — phone photos carry GPS
 * coordinates in EXIF, and a warehouse owner uploading from site would
 * otherwise publish their exact location in a file anyone can download.
 */
'use strict';

const Image = require('../models/image.model');   // bytes only, MongoDB media driver
const db = require('../db');
const { toDescriptor, isStored, allKeys } = require('./image.view');

/**
 * Storing or reading image bytes from the database is a MongoDB-only
 * ability — DynamoDB caps an item at 400KB. env.js refuses to start a
 * DynamoDB deployment without MEDIA_DRIVER=s3, so this is the second lock
 * on the same door: it turns a confusing failure deep inside the driver
 * into a sentence that says what is wrong.
 */
function requireMongoMedia(context) {
  if (db.driver === 'mongo') return;
  throw new ApiError(503, `${context || 'Image storage is not available'} — this deployment stores images in object storage, not the database.`);
}
const storage = require('./storage.service');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

/* sharp carries a native binary. If a host cannot build or download it the
   server must still run — uploads then store the original bytes untouched
   instead of failing outright. Resolved once at load, not per request. */
let sharp = null;
try {
  sharp = require('sharp');
  /* Bound the decoder's own cache. The default lets libvips hold tens of
     megabytes of decoded pixels between requests, which on a small
     Passenger instance reads as a memory leak. */
  sharp.cache({ memory: 64, files: 0, items: 64 });
  sharp.concurrency(2);
} catch (err) {
  logger.warn(
    { err: err.message },
    'sharp is unavailable — images will be stored at their original size. ' +
      'Run `npm install` in server/ to enable resizing.'
  );
}

/* Never generate anything wider than this. Beyond it the file grows faster
   than any screen can use it; floor plans get more headroom because they are
   opened full-screen and read, not glanced at. */
const MAX_WIDTH = { photo: 1920, floorplan: 2560 };

/* ── Content sniffing ──────────────────────────────────────────
   `file.mimetype` comes from the Content-Type the CLIENT put in the
   multipart body. It is a claim, not a fact — anything can be uploaded as
   "image/jpeg". Since these bytes are later served back under our own
   domain, trusting that claim would let someone store HTML or SVG here and
   have it execute as if we had written it.

   So the format is determined from the leading bytes instead, and the
   sniffed type — never the claimed one — is what gets persisted.
   ───────────────────────────────────────────────────────────── */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // GIF: "GIF87a" / "GIF89a"
  if (buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif';

  // WEBP: "RIFF" .... "WEBP"
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  // AVIF (ISO-BMFF): bytes 4-8 are "ftyp", brand at 8-12 is "avif"/"avis"
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return null;
}

/**
 * Which widths to render for a source image.
 *
 * Only widths below the original are generated — upscaling invents detail
 * that was never there and costs bytes to transmit it. The original width
 * (capped) is always included so there is a full-size rendition to open.
 */
function targetWidths(srcWidth, kind) {
  const cap = MAX_WIDTH[kind] || MAX_WIDTH.photo;
  const full = Math.min(srcWidth || cap, cap);
  const set = new Set(env.media.widths.filter((w) => w < full));
  set.add(full);
  return [...set].sort((a, b) => a - b);
}

/**
 * Renders one image into every size the front end will ask for.
 *
 * Returns `null` when sharp is missing, which tells the caller to fall back
 * to storing the file as it arrived.
 */
async function renderVariants(buffer, kind) {
  if (!sharp) return null;

  const pipeline = sharp(buffer, { failOn: 'none' });
  const meta = await pipeline.metadata();

  /* EXIF orientation is a flag, not a transform: a portrait phone photo is
     stored landscape with "rotate me" attached. Metadata is stripped below,
     which would take that flag with it and leave the photo on its side — so
     the rotation is baked into the pixels first. */
  const upright = meta.orientation && meta.orientation >= 5;
  const srcWidth = upright ? meta.height : meta.width;
  const srcHeight = upright ? meta.width : meta.height;

  const widths = targetWidths(srcWidth, kind);
  const quality = env.media.webpQuality;

  const renditions = [];
  for (const w of widths) {
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate() // applies EXIF orientation
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    renditions.push({
      w: out.info.width,
      h: out.info.height,
      body: out.data,
      size: out.data.length,
    });
  }

  /* The placeholder. Twenty pixels wide, so it is a few hundred bytes of
     colour rather than a picture — enough for the eye to read the shape of
     what is coming while the real file is still in flight. */
  let blur;
  try {
    const tiny = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 20 })
      .webp({ quality: 28, alphaQuality: 40 })
      .toBuffer();
    if (tiny.length <= 2800) blur = `data:image/webp;base64,${tiny.toString('base64')}`;
  } catch {
    /* A placeholder is a nicety. Losing it costs a grey box for one frame,
       so it must never cost the upload. */
  }

  return { renditions, blur, srcWidth, srcHeight };
}

/**
 * Stores one file and returns the descriptor a listing keeps.
 *
 * Both storage paths end at the same shape, so nothing downstream — not the
 * property model, not the browser — has to know or care whether the bytes
 * ended up in S3 or in MongoDB.
 */
async function storeOne(file, user, kind) {
  const contentType = sniffImageType(file.buffer);
  if (!contentType) {
    throw ApiError.unprocessable(
      `"${file.originalname}" is not a readable image (JPEG, PNG, WebP, GIF or AVIF only)`
    );
  }

  let rendered = null;
  try {
    rendered = await renderVariants(file.buffer, kind);
  } catch (err) {
    /* A file that sniffed as an image but will not decode is corrupt or
       truncated. Say that plainly rather than letting it fail later as a
       broken <img> on someone's listing. */
    throw ApiError.unprocessable(
      `"${file.originalname}" could not be read as an image — it may be damaged or incomplete.`
    );
  }

  const useS3 = storage.available();

  /* ── S3: text here, pixels in the bucket ── */
  if (useS3 && rendered) {
    const folder = storage.newFolder(kind === 'floorplan' ? 'floorplans' : 'photos');

    const uploaded = await Promise.all(
      rendered.renditions.map(async (r) => {
        const { key, url } = await storage.put({
          key: `${folder}/w${r.w}.webp`,
          body: r.body,
          contentType: 'image/webp',
        });
        return { w: r.w, h: r.h, key, url, size: r.size };
      })
    );

    const full = uploaded[uploaded.length - 1];

    const doc = await db.images.create({
      storage: 's3',
      key: full.key,
      bucket: env.media.s3.bucket,
      url: full.url,
      variants: uploaded,
      blur: rendered.blur,
      contentType: 'image/webp',
      size: uploaded.reduce((n, v) => n + (v.size || 0), 0),
      width: full.w,
      height: full.h,
      originalName: storage.basename(file.originalname),
      kind,
      uploadedBy: String(user.id || user._id),
    });

    return toDescriptor(doc);
  }

  /* ── MongoDB storage ──
     No bucket configured. Everything above this point is identical — the
     same sniffing, the same rotation, the same WebP renditions — only the
     destination differs. All of the sizes are kept, not just the largest,
     so the pages get a real `srcset` here too and a phone still downloads
     the 320px file. The only thing MongoDB does not give us is a CDN.

     A whole set is a few hundred KB against a single original of several
     MB, so this is smaller in the database than what it replaces. */
  if (rendered) {
    requireMongoMedia();
    const doc = new Image({
      storage: 'mongo',
      renditions: rendered.renditions.map((r) => ({
        w: r.w,
        h: r.h,
        size: r.size,
        contentType: 'image/webp',
        data: r.body,
      })),
      blur: rendered.blur,
      contentType: 'image/webp',
      size: rendered.renditions.reduce((n, r) => n + r.size, 0),
      width: rendered.renditions[rendered.renditions.length - 1].w,
      height: rendered.renditions[rendered.renditions.length - 1].h,
      originalName: storage.basename(file.originalname),
      kind,
      uploadedBy: String(user.id || user._id),
    });

    /* The URLs can only be built once the document has an id, and every
       rendition is addressed through the same route with a width. */
    doc.variants = rendered.renditions.map((r) => ({
      w: r.w,
      h: r.h,
      url: `/api/v1/images/${doc._id}?w=${r.w}`,
      size: r.size,
    }));

    await doc.save();
    return toDescriptor({ ...doc.toObject(), id: doc._id });
  }

  /* ── Last resort: no sharp on this host ──
     Store the file as it arrived. Bigger and slower, but a working upload
     beats a failed one, and the startup log already said resizing is off. */
  requireMongoMedia();
  const doc = await Image.create({
    storage: 'mongo',
    data: file.buffer,
    contentType,
    size: file.buffer.length,
    originalName: storage.basename(file.originalname),
    kind,
    uploadedBy: String(user.id || user._id),
  });

  return toDescriptor({ ...doc.toObject(), id: doc._id });
}

/**
 * Persists uploaded files and returns descriptors ready to drop straight
 * into `Property.images[]` or `Property.floorPlan`.
 *
 * Sequential on purpose: each file can hold a decoded bitmap several times
 * its own size in memory, and a parallel loop over a dozen 10 MB photos is
 * how a small instance runs out of RAM mid-upload.
 */
async function saveMany(files, user, kind = 'photo') {
  if (!files || !files.length) throw ApiError.badRequest('No files were uploaded');

  const saved = [];
  for (const file of files) {
    saved.push(await storeOne(file, user, kind === 'floorplan' ? 'floorplan' : 'photo'));
  }

  logger.info(
    { count: saved.length, userId: user.id, kind, driver: storage.available() ? 's3' : 'mongo' },
    'Images uploaded'
  );
  return saved;
}

/**
 * The rendition to serve for a requested width.
 *
 * The smallest one that still covers what was asked for, so a card asking
 * for 320 gets the 320px file rather than a 1920px file the browser then
 * scales down. With nothing asked for it is the largest, because a bare
 * /images/:id has always meant "the full-size one" and links to it predate
 * every rendition.
 *
 * Returns the variant itself rather than just a width: the S3 path needs its
 * key, and looking the variant up twice is how the two paths drift apart.
 */
function pickVariant(variants, requestedWidth) {
  const sorted = (variants || []).filter((v) => v && v.w).sort((a, b) => a.w - b.w);
  if (!sorted.length) return null;

  const want = Number(requestedWidth);
  if (Number.isFinite(want) && want > 0) {
    const covering = sorted.find((v) => v.w >= want);
    if (covering) return covering;
  }
  return sorted[sorted.length - 1];
}

/**
 * Resolves an image id (and an optional requested width) to something the
 * route can send: either a redirect to the CDN, or bytes.
 *
 * Kept here rather than in the controller so the three storage generations
 * this app now has — S3, MongoDB renditions, and a single pre-resize buffer
 * — are reconciled in one place, and the route stays a route.
 *
 * The bytes are fetched in a second query with an `$elemMatch` projection so
 * only the rendition actually being served comes back. Selecting the whole
 * array would pull every size out of the database to send one of them.
 */
async function resolve(id, requestedWidth) {
  /* Metadata only. `renditions` and `data` are both select:false, so this
     query carries no pixels — just the widths, which is what picking needs. */
  const image = await db.images.getById(id);
  if (!image) throw ApiError.notFound('Image not found');

  if (isStored(image, 's3')) {
    /* A world-readable bucket (or a CDN in front of one) can answer the
       browser directly, which is one less hop and no bytes through here.
       301, because the mapping from id to object never changes. */
    if (env.media.s3.publicRead) return { redirect: image.url };

    /* Otherwise the bucket is private and this process is the only thing
       holding credentials for it, so it fetches the object and sends it on.
       Same rendition-picking rule as the database path below, so `?w=`
       means the same thing whichever store the bytes are in. */
    const chosen = pickVariant(image.variants, requestedWidth);
    const key = (chosen && chosen.key) || image.key;
    if (!key) throw ApiError.notFound('Image not found');

    const object = await storage.get(key);
    return {
      body: object.body,
      contentType: object.contentType || chosen?.contentType || image.contentType,
      size: object.size,
      /* Keyed on the object, not the row: two renditions of one image are
         different bytes under different keys, and an ETag that ignored that
         would let the browser answer a request for the 320px file out of its
         cached 1920px one. */
      etag: `"img-${image.id}-${chosen ? chosen.w : 'full'}"`,
    };
  }

  /* Past this point the bytes are in MongoDB, which only exists on that
     driver. On DynamoDB the startup guard already refused to run without
     MEDIA_DRIVER=s3, so reaching here means a row that predates the move. */
  requireMongoMedia('This image predates the move to object storage');

  const picked = pickVariant(image.variants, requestedWidth);

  if (picked) {
    const chosen = picked.w;
    const slice = await Image.findById(id).select({ renditions: { $elemMatch: { w: chosen } } });
    const rendition = slice && slice.renditions && slice.renditions[0];

    if (rendition && rendition.data) {
      return {
        body: rendition.data,
        contentType: rendition.contentType || 'image/webp',
        size: rendition.size || rendition.data.length,
        /* The width is part of the identity: without it every size of one
           image would share an ETag and the browser would answer a request
           for the 320px file from its cached 1920px one. */
        etag: `"img-${image.id}-${chosen}"`,
      };
    }
  }

  /* Uploaded before any of this — one buffer, no renditions. */
  const legacy = await Image.findById(id).select('+data');
  if (!legacy || !legacy.data) throw ApiError.notFound('Image not found');

  return {
    body: legacy.data,
    contentType: legacy.contentType,
    size: legacy.size || legacy.data.length,
    etag: `"img-${legacy._id}-${legacy.size}"`,
  };
}

/**
 * Marks images as belonging to a listing, so they are no longer orphans and
 * so the detail page can be trusted to show only that listing's photos.
 *
 * Best-effort by design: failing to tag an image must not fail the listing
 * it was attached to.
 */
async function attachToProperty(images, propertyId, extra = []) {
  const ids = [...(images || []), ...(extra || [])]
    .map((i) => i && i.publicId)
    .filter((v) => /^[a-f0-9]{24}$/i.test(String(v)));
  if (!ids.length) return;

  try {
    /* One update per image rather than an updateMany: DynamoDB has no
       multi-row update, and a handful of photos per listing makes the
       difference immaterial. */
    await Promise.all(ids.map((imageId) => db.images.update(imageId, { property: String(propertyId) })));
  } catch (err) {
    logger.warn({ err: err.message, propertyId }, 'Could not tag images with their property');
  }
}

/**
 * Deletes an image and the objects behind it. Owner-or-admin only — checked
 * here rather than in the controller so the rule holds for every caller.
 */
async function remove(id, user) {
  const image = await db.images.getById(id);
  if (!image) throw ApiError.notFound('Image not found');

  const isOwner = String(image.uploadedBy) === String(user.id || user._id);
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('You can only delete your own uploads');
  }

  /* Detach from any listing still referencing it, so the property is not
     left pointing at a URL that now 404s. Both the gallery and the floor
     plan can hold it, and clearing only one would leave a dead image on the
     page it was not removed from.

     Read-filter-write rather than $pull: DynamoDB has no operator that
     removes a matching element from a list. The window between the read and
     the write is a photo someone else attached in the same instant, which
     is a far smaller problem than a listing showing a dead image. */
  if (image.property) {
    try {
      const property = await db.properties.getById(image.property);
      if (property) {
        const publicId = String(image.id);
        const images = (property.images || []).filter((i) => String(i?.publicId) !== publicId);
        const dropFloorPlan = String(property.floorPlan?.publicId) === publicId;
        if (images.length !== (property.images || []).length || dropFloorPlan) {
          await db.properties.update(
            property.id,
            { images },
            { remove: dropFloorPlan ? ['floorPlan'] : [] },
          );
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, id }, 'Could not detach image from its listing');
    }
  }

  /* Database first. An orphaned S3 object is a rounding error on the bill;
     a listing pointing at a deleted object is a broken page. */
  await db.images.remove(id);
  await storage.remove(allKeys(image));

  return { id: String(id) };
}

/**
 * Removes every image belonging to a property — called when the listing
 * itself is deleted, so its photos do not sit in the bucket forever.
 */
async function removeForProperty(propertyId) {
  const images = await db.images.listForProperty(propertyId);
  if (!images.length) return { removed: 0 };

  const keys = images.flatMap((img) => allKeys(img));
  await db.images.removeMany(images.map((i) => i.id));
  await storage.remove(keys);

  logger.info({ propertyId, removed: images.length }, 'Removed images for deleted property');
  return { removed: images.length };
}

module.exports = {
  saveMany,
  resolve,
  attachToProperty,
  remove,
  removeForProperty,
  sniffImageType,
  renderVariants,
  targetWidths,
  hasSharp: () => Boolean(sharp),
};
