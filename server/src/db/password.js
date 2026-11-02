/**
 * Password hashing, written once for every driver.
 *
 * This used to live in a Mongoose `pre('save')` hook, which covered exactly
 * one of the three ways a password reaches the database:
 *
 *   • `User.create()` / `doc.save()` — the hook ran, the value was hashed
 *   • `findByIdAndUpdate()`          — `pre('save')` does not fire, so a
 *                                      password change wrote plaintext
 *   • the DynamoDB driver            — no Mongoose at all, so every account
 *                                      was created with a plaintext password
 *
 * The rule belongs where all of them pass: the repository boundary. A value
 * going into the store is hashed unless it already is a hash.
 *
 * `isHash` is what makes that safe to apply more than once. Hashing an
 * already-hashed value is not a harmless no-op — it produces a different
 * digest that no password will ever match again, locking the account out
 * permanently and silently.
 */
'use strict';

const bcrypt = require('bcryptjs');
const env = require('../config/env');

/* bcrypt's modular crypt format: $2a$, $2b$ or $2y$, then the cost. */
const BCRYPT = /^\$2[aby]\$\d{2}\$/;

const isHash = (value) => typeof value === 'string' && BCRYPT.test(value);

/** Hashes a plaintext password; returns anything already hashed untouched. */
async function hashIfPlain(value) {
  if (!value || isHash(value)) return value;
  return bcrypt.hash(value, env.bcryptRounds);
}

/**
 * An account created through Google OAuth has no password at all. Comparing
 * against an absent hash must be false, never an exception, or sign-in
 * errors for those accounts instead of simply refusing.
 */
function comparePassword(candidate, hash) {
  if (!hash || !candidate) return Promise.resolve(false);
  return bcrypt.compare(candidate, hash);
}

/**
 * JWT `iat` has one-second precision, so a token issued in the same second
 * as a password change would otherwise look as though it predated it and
 * survive a "sign out everywhere". Backdating by a second closes that.
 */
const passwordChangedStamp = () => new Date(Date.now() - 1000);

module.exports = { isHash, hashIfPlain, comparePassword, passwordChangedStamp };
