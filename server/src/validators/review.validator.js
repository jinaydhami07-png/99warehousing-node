'use strict';

const { z } = require('zod');
const { STATUSES } = require('../models/review.model');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/* The author is taken from the session, never from the body — otherwise
   anyone could post a review under someone else's name, which is exactly the
   problem the hard-coded testimonials had. `.strict()` so an attempt to send
   authorName or status is a loud 422 rather than a silent strip. */
const create = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      rating: z.coerce.number().int().min(1, 'Rating must be 1–5').max(5, 'Rating must be 1–5'),
      comment: z
        .string()
        .trim()
        .min(10, 'Please write at least 10 characters')
        .max(1500, 'Reviews are limited to 1500 characters'),
      authorRole: z.string().trim().max(120).optional(),
    })
    .strict(),
});

const listForProperty = z.object({
  params: z.object({ id: objectId }),
  query: z
    .object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(50).optional(),
    })
    .optional(),
});

const byId = z.object({ params: z.object({ id: objectId }) });

const moderate = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      status: z.enum(STATUSES),
      rejectionReason: z.string().trim().max(500).optional(),
    })
    .strict()
    /* A rejection with no reason gives the author nothing to act on, and
       leaves the admin log without a record of why. */
    .refine((v) => v.status !== 'rejected' || !!v.rejectionReason, {
      message: 'A reason is required when rejecting a review',
      path: ['rejectionReason'],
    }),
});

module.exports = { create, listForProperty, byId, moderate, objectId };
