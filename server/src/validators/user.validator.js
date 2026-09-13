/**
 * Request schemas.
 *
 * Validation lives at the edge so a controller can trust its input, and is
 * declared separately from the route so it is readable and testable on its
 * own. Schema-level validation in the model still runs as a second layer —
 * this one produces friendlier, field-level messages.
 */
'use strict';

const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Please provide a valid email address')
  .max(254);

/* Enforces length rather than character-class rules: NIST guidance favours
   longer passphrases over forced symbol mixes, which push users toward
   predictable substitutions. */
const password = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password cannot exceed 128 characters');

const register = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    email,
    password,
    mobile: z.string().trim().regex(/^[+]?[\d\s()-]{7,20}$/, 'Invalid phone number').optional(),
    company: z.string().trim().max(160).optional(),
    // `accountType`, never `role` — the service maps it to a safe subset.
    accountType: z.enum(['buyer', 'owner', 'agency']).optional(),
  }),
});

const login = z.object({
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
});

const updateMe = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      mobile: z.string().trim().regex(/^[+]?[\d\s()-]{7,20}$/, 'Invalid phone number').optional(),
      company: z.string().trim().max(160).optional(),
    })
    .strict() // reject unknown keys outright rather than ignoring them
    .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update'),
});

const adminUpdateUser = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      mobile: z.string().trim().optional(),
      company: z.string().trim().max(160).optional(),
      role: z.enum(['buyer', 'owner', 'agency', 'admin']).optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const adminLogin = z.object({
  body: z.object({
    passkey: z.string({ required_error: 'Passkey is required' }).min(1, 'Passkey is required').max(200),
  }),
});

const byId = z.object({ params: z.object({ id: objectId }) });

const listQuery = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    role: z.enum(['buyer', 'owner', 'agency', 'admin']).optional(),
    search: z.string().trim().max(120).optional(),
  }),
});

module.exports = { register, login, adminLogin, updateMe, adminUpdateUser, byId, listQuery, objectId };
