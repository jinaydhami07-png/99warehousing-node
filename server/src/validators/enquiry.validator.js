'use strict';

const { z } = require('zod');
const { ENQUIRY_STATUSES } = require('../models/enquiry.model');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/* Public endpoint, so the shape is strict: unknown keys are rejected rather
   than quietly stored, and `status` is absent by design — a sender must not
   be able to file their own enquiry as "closed". */
const create = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, 'Please enter your name').max(120),
      email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
      mobile: z.string().trim().max(20).optional(),
      company: z.string().trim().max(160).optional(),
      subject: z.string().trim().max(160).optional(),
      message: z.string().trim().min(5, 'Please tell us how we can help').max(4000),
      property: objectId.optional(),
    })
    .strict(),
});

const byId = z.object({
  params: z.object({ id: objectId }),
});

const updateStatus = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      status: z.enum(ENQUIRY_STATUSES).optional(),
      adminNote: z.string().trim().max(2000).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update'),
});

const listQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    status: z.enum(ENQUIRY_STATUSES).optional(),
    q: z.string().trim().max(120).optional(),
  }),
});

module.exports = { create, byId, updateStatus, listQuery, objectId };
