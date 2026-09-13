/**
 * Property model — warehouses, land, logistics parks, cold storage, etc.
 *
 * Follows the same conventions as user.model.js: schema-level validation,
 * timestamps, indexes matched to real queries, and a toJSON transform so
 * internal fields never leak through res.json().
 */
'use strict';

const mongoose = require('mongoose');

const PROPERTY_TYPES = [
  'Warehouse',
  'Cold Storage',
  'Industrial Shed',
  'Logistics Park',
  'Dark Store',
  'Industrial Land',
];

const GRADES = ['Grade A', 'Grade B', 'Grade C', 'Cold Chain', 'Land'];
const STATUSES = ['draft', 'pending', 'approved', 'rejected'];

/* One rendition of a photo. The browser is handed the whole set and picks
   the smallest file that still fills the space it has, so a phone on a card
   grid downloads the 320px file and never sees the 1920px one. */
const variantSchema = new mongoose.Schema(
  {
    w: { type: Number, required: true },
    h: Number,
    url: { type: String, required: true },
  },
  { _id: false }
);

/* A photo as a listing stores it — text only. The bytes are in S3; this is
   the address, the shape and the caption.

   `width`/`height` are here so a card can reserve the right box before the
   file arrives. Without them every image that loads shoves the page down as
   it appears, which is the single most annoying thing a slow gallery does. */
const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: String,
    caption: { type: String, trim: true, maxlength: 200 },
    isPrimary: { type: Boolean, default: false },
    variants: [variantSchema],
    /* ~20px WebP as a data URI. Painted instantly, replaced by the real
       photo the moment it decodes. Capped so a malformed value cannot
       bloat the listing feed. */
    blur: { type: String, maxlength: 4000 },
    width: Number,
    height: Number,
  },
  { _id: true }
);

const propertySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Property title is required'],
      trim: true,
      maxlength: [160, 'Title cannot exceed 160 characters'],
    },
    slug: { type: String, unique: true, sparse: true },
    description: { type: String, trim: true, maxlength: 5000 },

    type: {
      type: String,
      enum: { values: PROPERTY_TYPES, message: '{VALUE} is not a supported property type' },
      default: 'Warehouse',
    },
    grade: { type: String, enum: GRADES, default: 'Grade B' },

    city: { type: String, trim: true, required: [true, 'City is required'] },
    locality: { type: String, trim: true },

    /* The listing form asked for all three of these and then dropped them on
       the floor — nothing read them and no field existed to hold them. They
       are stored now, and shown only where they belong: the full address and
       map link go to a signed-in enquirer, not onto the public card. */
    address: { type: String, trim: true, maxlength: 300 },
    pincode: { type: String, trim: true, maxlength: 10 },
    mapsUrl: { type: String, trim: true, maxlength: 500 },

    rate: {
      type: Number,
      required: [true, 'Rate is required'],
      min: [1, 'Rate must be greater than zero'],
    },
    area: {
      type: Number,
      required: [true, 'Area is required'],
      min: [1, 'Area must be greater than zero'],
    },
    depositMonths: { type: Number, default: 3, min: 0, max: 24 },

    /* Everything the detail page shows under "Property Specifications".
       It used to show nine cards of which only two were fed from here — the
       other seven were written into the HTML and were the same numbers for
       every listing in the database. A field that is not collected cannot be
       displayed, so the ones the page needs are collected. All optional: a
       small shed has no column grid, and a plot has no clear height. */
    specs: {
      clearHeight: Number, // metres, floor to truss
      loadingDocks: Number,
      power: Number, // kVA
      floorStrength: Number, // tonnes per m²
      officeArea: Number, // sq ft
      columnSpacing: { type: String, trim: true, maxlength: 40 }, // e.g. "12 × 24 m"
      truckTurning: Number, // metres of yard radius
      fireSystem: { type: String, trim: true, maxlength: 80 },
      features: [{ type: String, trim: true }],
    },

    images: [mediaSchema],

    /* Optional, and genuinely so — most listings will never have one. The
       page hides the whole section when it is absent rather than drawing the
       generic block diagram that used to stand in for every property. */
    floorPlan: {
      url: { type: String, trim: true },
      publicId: { type: String, trim: true },
      /* Same renditions as a photo, so the plan loads at a sensible size
         inline and still opens full-resolution when clicked. */
      variants: [variantSchema],
      blur: { type: String, maxlength: 4000 },
      width: Number,
      height: Number,
    },

    /* "NH-48: 3.2 km" and friends. Free-form because what matters differs by
       property — a port for one, an airport for another. */
    distances: [
      {
        _id: false,
        label: { type: String, trim: true, maxlength: 60 },
        km: Number,
      },
    ],

    availableFrom: Date,

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, trim: true },

    status: { type: String, enum: STATUSES, default: 'pending' },
    isVerified: { type: Boolean, default: false },
    rejectionReason: { type: String, trim: true, maxlength: 500 },

    views: { type: Number, default: 0 },
    enquiryCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        /* The owner's user id has no use in the browser and appears on the
           public feed, where it links a listing to an account and gives an
           attacker a real id to aim at other endpoints. Ownership decisions
           are made server-side from the document itself, so nothing needs
           this on the wire. */
        delete ret.owner;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* ── Indexes, matched to how the app actually queries ──
   status+city+rate → the public listing feed's default filter+sort path.
   status+createdAt → the admin approval queue, newest-first. */
propertySchema.index({ status: 1, city: 1, rate: 1 });
propertySchema.index({ status: 1, createdAt: -1 });
propertySchema.index({ name: 'text', city: 'text', locality: 'text', description: 'text' });

propertySchema.virtual('location').get(function () {
  return [this.locality, this.city].filter(Boolean).join(', ');
});

propertySchema.pre('save', function (next) {
  if (!this.slug && this.name) {
    const base = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    this.slug = `${base}-${new mongoose.Types.ObjectId().toString().slice(-6)}`;
  }
  next();
});

module.exports = mongoose.model('Property', propertySchema);
module.exports.PROPERTY_TYPES = PROPERTY_TYPES;
module.exports.GRADES = GRADES;
module.exports.STATUSES = STATUSES;
