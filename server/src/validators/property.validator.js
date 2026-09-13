'use strict';

const { z } = require('zod');
const { PROPERTY_TYPES, GRADES, STATUSES } = require('../models/property.model');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid property id');

/* Every one of these is optional. A plot of land has no clear height and a
   small shed has no column grid — requiring them would force whoever is
   listing to invent a number, which is how the detail page ended up showing
   the same nine specifications for every property in the first place. */
/* `.nullish()` rather than `.optional()`: the admin form sends every field on
   every save, using null for a number the admin has cleared and '' for text.
   Without null in the type, clearing a value would fail the whole request —
   and omitting the key instead would leave the old value in place, which
   reads as the edit being silently ignored. */
const optNum = z.coerce.number().nonnegative().nullish();

const specs = z
  .object({
    clearHeight: optNum,
    loadingDocks: z.coerce.number().int().nonnegative().nullish(),
    power: optNum,
    floorStrength: optNum,
    officeArea: optNum,
    columnSpacing: z.string().trim().max(40).nullish(),
    truckTurning: optNum,
    fireSystem: z.string().trim().max(80).nullish(),
    features: z.array(z.string().trim().max(80)).max(30).nullish(),
  })
  .partial()
  .optional();

/* The sizes the upload endpoint generated for one photo. Echoed back by the
   form exactly as the server produced them — they are not user input in any
   meaningful sense, but they arrive over the wire like everything else, so
   they are bounded here rather than trusted. */
const variants = z
  .array(
    z.object({
      w: z.coerce.number().int().positive().max(8192),
      h: z.coerce.number().int().positive().max(8192).optional(),
      url: z.string().trim().min(1).max(500),
    })
  )
  .max(8)
  .optional();

/* The inline placeholder. Restricted to a WebP/PNG/JPEG data URI: this
   string is written straight into a style attribute on the page, and any
   other scheme there — `javascript:` above all — would be an injection
   point dressed up as a picture. */
const blur = z
  .string()
  .trim()
  .max(4000)
  .refine(
    (v) => !v || /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v),
    'Placeholder must be a base64 image data URI'
  )
  .optional();

const dimension = z.coerce.number().int().positive().max(8192).optional();

const image = z.object({
  url: z.string().trim().min(1, 'Image url is required'),
  publicId: z.string().optional(),
  caption: z.string().trim().max(200).optional(),
  isPrimary: z.boolean().optional(),
  variants,
  blur,
  width: dimension,
  height: dimension,
});

/* Optional in the strongest sense: an empty object clears it. Most listings
   will never have a floor plan and the page simply omits the section. */
const floorPlan = z
  .object({
    url: z.string().trim().min(1).optional(),
    publicId: z.string().trim().optional(),
    variants,
    blur,
    width: dimension,
    height: dimension,
  })
  .optional();

const distances = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(60),
      km: z.coerce.number().nonnegative(),
    })
  )
  .max(8)
  .optional();

/* Shared by every schema below, so a field added here reaches the public
   form, the admin form and both update paths at once — the admin form losing
   fields because one schema was updated and another was not is a bug this
   project has already had. */
const detailFields = {
  specs,
  images: z.array(image).max(12).optional(),
  floorPlan,
  distances,
  availableFrom: z.coerce.date().nullish(),
  address: z.string().trim().max(300).nullish(),
  pincode: z.string().trim().max(10).nullish(),
  /* Only http(s). A javascript: or data: URL here would end up in an href on
     the detail page. Empty passes — that is how the field is cleared. */
  mapsUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https?:\/\//i.test(v), 'Map link must start with http:// or https://')
    .nullish(),
};

/* Fields anyone may set when submitting a listing. Deliberately excludes
   ownerName, status and isVerified: a submitter must not be able to name a
   different owner or approve their own listing. */
const createFields = {
  name: z.string().trim().min(3, 'Title must be at least 3 characters').max(160),
  description: z.string().trim().max(5000).optional(),
  type: z.enum(PROPERTY_TYPES).optional(),
  grade: z.enum(GRADES).optional(),
  city: z.string().trim().min(1, 'City is required').max(80),
  locality: z.string().trim().max(120).optional(),
  rate: z.coerce.number().positive('Rate must be greater than zero'),
  area: z.coerce.number().positive('Area must be greater than zero'),
  depositMonths: z.coerce.number().min(0).max(24).optional(),
  ...detailFields,
};

/* .strict() so an unknown key is rejected with a message naming it, rather
   than silently stripped. Silent stripping is how the admin form lost the
   Owner and Status fields for so long: the request succeeded, and the values
   simply never arrived. */
const create = z.object({
  body: z.object(createFields).strict(),
});

/* Admins additionally set who owns the listing and what state it goes into —
   they are entering listings on behalf of real owners, and moderating. */
const adminCreate = z.object({
  body: z
    .object({
      ...createFields,
      ownerName: z.string().trim().max(160).optional(),
      status: z.enum(STATUSES).optional(),
      isVerified: z.boolean().optional(),
    })
    .strict(),
});

/* Owners may not set status/isVerified — those are moderation decisions.
   `.strict()` rejects them outright rather than silently dropping them, so a
   client attempting it gets a clear 422 instead of a surprising no-op. */
const update = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().trim().min(3).max(160).optional(),
      description: z.string().trim().max(5000).optional(),
      type: z.enum(PROPERTY_TYPES).optional(),
      grade: z.enum(GRADES).optional(),
      city: z.string().trim().min(1).max(80).optional(),
      locality: z.string().trim().max(120).optional(),
      rate: z.coerce.number().positive().optional(),
      area: z.coerce.number().positive().optional(),
      depositMonths: z.coerce.number().min(0).max(24).optional(),
      ...detailFields,
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update'),
});

/* Admins may additionally change status directly. */
const adminUpdate = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().trim().min(3).max(160).optional(),
      description: z.string().trim().max(5000).optional(),
      type: z.enum(PROPERTY_TYPES).optional(),
      grade: z.enum(GRADES).optional(),
      city: z.string().trim().min(1).max(80).optional(),
      locality: z.string().trim().max(120).optional(),
      rate: z.coerce.number().positive().optional(),
      area: z.coerce.number().positive().optional(),
      depositMonths: z.coerce.number().min(0).max(24).optional(),
      status: z.enum(STATUSES).optional(),
      isVerified: z.boolean().optional(),
      /* The admin edit form has an Owner field, so the schema has to accept
         it — otherwise .strict() rejects the whole request and no edit saves
         at all. */
      ownerName: z.string().trim().max(160).optional(),
      ...detailFields,
    })
    .strict(),
});

const byId = z.object({ params: z.object({ id: objectId }) });

const reject = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
  }),
});

const listQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    city: z.string().trim().max(80).optional(),
    type: z.enum(PROPERTY_TYPES).optional(),
    grade: z.enum(GRADES).optional(),
    status: z.enum(STATUSES).optional(),
    minRate: z.coerce.number().nonnegative().optional(),
    maxRate: z.coerce.number().nonnegative().optional(),
    minArea: z.coerce.number().nonnegative().optional(),
    maxArea: z.coerce.number().nonnegative().optional(),
    q: z.string().trim().max(120).optional(),
    sort: z.enum(['rate-asc', 'rate-desc', 'area-asc', 'area-desc', 'newest', 'oldest']).optional(),
  }),
});

module.exports = { create, adminCreate, update, adminUpdate, byId, reject, listQuery, objectId };
