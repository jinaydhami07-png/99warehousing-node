/**
 * User model.
 *
 * Demonstrates the conventions every model in this codebase follows:
 *   • validation declared at the schema level (the last line of defence —
 *     it holds even if a controller forgets to validate)
 *   • timestamps enabled
 *   • indexes on the fields actually queried
 *   • password never selectable by default
 *   • a toJSON transform so secrets cannot leak through res.json(user)
 */
'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

const ROLES = ['buyer', 'owner', 'agency', 'admin'];

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,          // creates a unique index (see note below)
      lowercase: true,
      trim: true,
      maxlength: [254, 'Email cannot exceed 254 characters'], // RFC 5321
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address'],
    },

    password: {
      type: String,
      required: [
        function () {
          // Not required for OAuth accounts, which never set one.
          return this.authProvider === 'local';
        },
        'Password is required',
      ],
      minlength: [8, 'Password must be at least 8 characters'],
      // Excluded from every query result unless explicitly re-selected with
      // .select('+password'). Prevents accidental exposure via res.json().
      select: false,
    },

    mobile: {
      type: String,
      trim: true,
      match: [/^[+]?[\d\s()-]{7,20}$/, 'Please provide a valid phone number'],
    },

    company: { type: String, trim: true, maxlength: 160 },

    /* Profile picture URL, currently only ever supplied by Google.
       Stored as a URL rather than downloaded: it is Google's own CDN, it
       changes when the user changes their photo, and copying it here would
       mean holding a stale image plus someone else's likeness. Never
       accepted from a user-submitted form — see updateMe's strict schema. */
    avatar: { type: String, trim: true, maxlength: 500 },

    role: {
      type: String,
      enum: { values: ROLES, message: '{VALUE} is not a supported role' },
      default: 'buyer',
      index: true,
    },

    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    /* No index options here on purpose. In Mongoose, setting `sparse` (or
       `unique`/`index`) on the path creates an index — which would collide
       with the explicit partial index declared below and trigger the
       "duplicate schema index" warning in Mongoose 8. */
    googleId: { type: String },

    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    /* ── Brute-force state ── */
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    lastLoginAt: Date,

    /* Incremented on logout / password change; every refresh token issued
       before the bump stops validating. This is how "log out everywhere"
       works without a token blacklist. */
    tokenVersion: { type: Number, default: 0, select: false },

    passwordChangedAt: { type: Date, select: false },
  },
  {
    timestamps: true, // adds createdAt / updatedAt, maintained by Mongoose
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        // Belt and braces: even if something re-selects these, they never
        // survive serialisation.
        delete ret.password;
        delete ret.__v;
        delete ret.failedLoginAttempts;
        delete ret.lockedUntil;
        delete ret.tokenVersion;
        delete ret.passwordChangedAt;
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* ─────────────────────────────────────────────────────────────
   Indexes
   ─────────────────────────────────────────────────────────────
   `unique: true` on email already creates a unique index, so declaring
   `userSchema.index({ email: 1 })` as well would create a redundant
   duplicate — Mongoose 8 warns about exactly that. It is listed here as a
   comment rather than code so the intent is documented without the dupe.

     email  → unique index, created by the field definition above.
              This is the hot path: every login does findOne({ email }).
              Without it, each sign-in is a full collection scan.
*/

// Compound index for the admin user list: filter by role, sort by newest.
// Field order matters — equality field first, then the sort field.
userSchema.index({ role: 1, createdAt: -1 });

// Partial index: only documents that actually have a googleId are indexed,
// which keeps it small since most users sign up with a password.
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } }
);

// Lets Mongo expire lock records automatically instead of a cleanup job.
userSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0, sparse: true });

/* ─────────────────────────────────────────────────────────────
   Hooks
   ───────────────────────────────────────────────────────────── */

/** Hash on save — never in a controller, so no code path can store plaintext. */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();

  this.password = await bcrypt.hash(this.password, env.bcryptRounds);

  // Backdate by a second: JWT `iat` has second precision, so a token issued
  // in the same second as the change would otherwise appear to predate it
  // and survive a "log out everywhere".
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);

  next();
});

/* ─────────────────────────────────────────────────────────────
   Instance methods
   ───────────────────────────────────────────────────────────── */

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false); // OAuth-only account
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > Date.now());
};

/** True if the password changed after this token was issued. */
userSchema.methods.passwordChangedAfter = function passwordChangedAfter(jwtIssuedAtSeconds) {
  if (!this.passwordChangedAt) return false;
  return Math.floor(this.passwordChangedAt.getTime() / 1000) > jwtIssuedAtSeconds;
};

/* ─────────────────────────────────────────────────────────────
   Statics
   ───────────────────────────────────────────────────────────── */

/** Login lookup — pulls the fields the auth flow needs but queries omit. */
userSchema.statics.findForAuth = function findForAuth(email) {
  return this.findOne({ email: String(email).toLowerCase().trim() }).select(
    '+password +failedLoginAttempts +lockedUntil +tokenVersion'
  );
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
