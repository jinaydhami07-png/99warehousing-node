/**
 * Image — the record of a property photo or floor plan.
 *
 * The bytes live in S3. This document holds only text: the content type,
 * the dimensions, who uploaded it, which listing it belongs to, and the
 * keys and URLs that point at the objects. That split is the whole reason
 * this collection exists — MongoDB stores what MongoDB is good at, and an
 * object store with a CDN in front of it serves the pixels.
 *
 * ── Why `data` is still here ──────────────────────────────────────────
 * Every image uploaded before the move to S3 is a Buffer in this
 * collection, and the URLs saved onto those listings point at
 * /api/v1/images/:id. Deleting the field would 404 every one of them.
 *
 * So `storage` records where a given image actually lives, `data` stays as
 * an optional, `select: false` field for the ones that predate the move,
 * and the serve route reads `storage` to decide whether to redirect to the
 * CDN or stream the bytes. `npm run migrate:images` moves the stragglers
 * across and clears their buffers; once it reports zero remaining, this
 * field can be dropped.
 * ─────────────────────────────────────────────────────────────────────
 */
'use strict';

const mongoose = require('mongoose');

/* Raster formats a browser can display. SVG is deliberately excluded: it is
   an executable document (it can carry <script>), and serving user-supplied
   SVG from our own origin would be a stored-XSS hole. */
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/* The cap on the ORIGINAL upload. Twice what it used to be, because the
   server now downscales and re-encodes before anything is stored — a 9 MB
   phone photo becomes roughly 150 KB of WebP. The old 5 MB limit existed to
   protect the database that no longer holds these bytes.

   It is also the memory bound: multer buffers a whole request before the
   handler runs, so a full batch is MAX_FILES x this figure in RSS. */
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/* What a listing is actually allowed to reference. Each variant is one
   rendition of the same photo at one width, so the browser can pick the
   smallest file that still fills the space it has. */
const variantSchema = new mongoose.Schema(
  {
    w: { type: Number, required: true }, // rendered width in pixels
    h: Number,
    key: String, // S3 object key, for deletion
    url: { type: String, required: true },
    size: Number,
  },
  { _id: false }
);

/* One stored rendition, for the MongoDB path. The S3 path keeps the bytes
   in the bucket and only records `variantSchema` above; this is the same
   set of sizes with the pixels attached. */
const renditionSchema = new mongoose.Schema(
  {
    w: { type: Number, required: true },
    h: Number,
    size: Number,
    contentType: { type: String, default: 'image/webp' },
    data: { type: Buffer, required: true },
  },
  { _id: false }
);

const imageSchema = new mongoose.Schema(
  {
    /* 's3' — bytes in the bucket, `key`/`url` are authoritative.
       'mongo' — the bytes are in `data`.

       Deliberately no default. Documents written before this field existed
       have no value for it, and a default of 's3' would make every one of
       them *read back* as S3-backed — hydration fills a missing path with
       its default — which is a lie about where the bytes actually are. Both
       upload paths set it explicitly, so the only documents that reach here
       without one are the old ones, and for those "unset" is the truth.
       `isStored('s3')` below is what code should ask, rather than comparing
       this string directly. */
    storage: { type: String, enum: ['s3', 'mongo'], index: true },

    /* The single full-size buffer, as images were stored before any of this
       existed. Nothing writes it any more — new MongoDB-backed uploads fill
       `renditions` instead — but documents from before the change still have
       it, and the serve route falls back to it when there are no
       renditions. */
    data: { type: Buffer, select: false },

    /* MongoDB-backed storage, the full set.
       One entry per width, exactly mirroring what would have gone to S3, so
       the browser gets a real `srcset` either way and a phone still fetches
       the 320px file rather than the full-size one. Four renditions of a
       photo come to a few hundred kilobytes — far inside the 16 MB document
       ceiling, and far less than the single original used to cost.

       `select: false`: the bytes are fetched only by the route that streams
       them, and never travel with a metadata query. */
    renditions: { type: [renditionSchema], select: false, default: undefined },

    /* Where the full-size object lives. Empty for legacy Mongo images,
       whose URL is the API route instead. */
    key: { type: String, trim: true },
    bucket: { type: String, trim: true },
    url: { type: String, trim: true },

    /* Downscaled WebP renditions, smallest first. */
    variants: [variantSchema],

    /* A ~20px WebP inlined as a data URI, about half a kilobyte of text.
       It is what the browser paints in the fraction of a second before the
       real photo arrives, instead of an empty grey box — and because it
       ships inside the JSON that already had to be fetched, it costs no
       extra request. */
    blur: { type: String, maxlength: 4000 },

    contentType: {
      type: String,
      required: true,
      enum: { values: ALLOWED_MIME, message: '{VALUE} is not a supported image type' },
    },
    size: { type: Number, required: true },
    width: Number,
    height: Number,
    originalName: { type: String, trim: true, maxlength: 260 },

    /* Photos and floor plans are stored under different prefixes and shown
       in different places, so the record says which it is. */
    kind: { type: String, enum: ['photo', 'floorplan'], default: 'photo' },

    /* Who uploaded it — so an owner cannot delete someone else's image. */
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /* Set once the image is attached to a listing. Images that are never
       attached are orphans and can be swept up later. */
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
  },
  { timestamps: true }
);

/* Finding a user's uploads, and finding orphans to clean up. */
imageSchema.index({ uploadedBy: 1, createdAt: -1 });
imageSchema.index({ property: 1 });

/**
 * The shape the API hands back and a listing stores — text only, no bytes.
 * One method so the uploader, the migration and the property service all
 * produce identical descriptors; three near-identical object literals in
 * three files is how the two halves of a record drift apart.
 */
imageSchema.methods.toDescriptor = function toDescriptor() {
  return {
    url: this.url || `/api/v1/images/${this._id}`,
    publicId: String(this._id),
    variants: (this.variants || []).map((v) => ({ w: v.w, h: v.h, url: v.url })),
    blur: this.blur || undefined,
    width: this.width,
    height: this.height,
    contentType: this.contentType,
    size: this.size,
    originalName: this.originalName,
  };
};

/**
 * Where the bytes really are.
 *
 * Derived from `url` rather than trusted from `storage` alone: an object in
 * the bucket always has one and a MongoDB-stored image never does, so this
 * gives the right answer for the documents written before `storage` existed
 * as well as the ones written since.
 */
imageSchema.methods.isStored = function isStored(where) {
  const actual = this.url ? 's3' : 'mongo';
  return actual === where;
};

/** Every S3 key belonging to this image — the full size and every variant. */
imageSchema.methods.allKeys = function allKeys() {
  return [this.key, ...(this.variants || []).map((v) => v.key)].filter(Boolean);
};

module.exports = mongoose.model('Image', imageSchema);
module.exports.ALLOWED_MIME = ALLOWED_MIME;
module.exports.MAX_BYTES = MAX_BYTES;
