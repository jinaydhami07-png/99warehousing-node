/**
 * User service — all business logic for users lives here.
 *
 * The layering rule this file exists to enforce:
 *   • Services know nothing about HTTP. No `req`, no `res`, no status codes
 *     beyond throwing ApiError. They take plain arguments and return plain
 *     data, which is what makes them unit-testable and reusable from a CLI
 *     script, a queue worker, or a GraphQL resolver later.
 *   • Controllers know nothing about the database.
 *
 * If you find yourself importing `express` here, the logic belongs in a
 * controller instead.
 */
'use strict';

const User = require('../models/user.model');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Creates a user.
 * @throws {ApiError} 409 if the email is taken.
 */
async function createUser({ name, email, password, mobile, company, accountType }) {
  const existing = await User.findOne({ email: email.toLowerCase().trim() }).lean();
  if (existing) throw ApiError.conflict('An account with that email already exists');

  // `role` is derived from a constrained input, never taken from the caller
  // verbatim — otherwise a crafted body could self-assign 'admin'.
  const role = ['buyer', 'owner', 'agency'].includes(accountType) ? accountType : 'buyer';

  const user = await User.create({ name, email, password, mobile, company, role });
  logger.info({ userId: user.id, role }, 'User created');
  return user;
}

/**
 * Verifies credentials, applying lockout.
 *
 * Returns the same error for "no such user" and "wrong password" so the
 * endpoint cannot be used to discover which emails are registered.
 */
async function verifyCredentials(email, password) {
  const user = await User.findForAuth(email);

  if (!user) {
    // Note: this returns faster than the password branch below, which is a
    // theoretical timing oracle. Mitigated at the route level by rate
    // limiting; a constant-time dummy compare can be added if the threat
    // model warrants it.
    throw ApiError.unauthorized('Incorrect email or password');
  }

  if (user.isLocked()) {
    const minutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw ApiError.tooMany(`Account temporarily locked. Try again in ${minutes} minute(s).`);
  }

  if (!(await user.comparePassword(password))) {
    await registerFailedAttempt(user);
    throw ApiError.unauthorized('Incorrect email or password');
  }

  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  // Atomic reset so a successful login cannot race with a concurrent failure.
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } }
  );

  return user;
}

/**
 * Increments the failure counter and locks the account at the threshold.
 *
 * Uses an atomic $inc and reads the result, rather than computing
 * `stored + 1` in application code. Parallel login attempts would otherwise
 * each read the same starting value and write back the same number, so an
 * attacker running requests concurrently could exceed the threshold without
 * the counter ever reaching it.
 */
async function registerFailedAttempt(user) {
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { failedLoginAttempts: 1 } },
    { new: true, select: '+failedLoginAttempts' }
  );

  if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_DURATION_MS) } }
    );
    logger.warn({ userId: String(user._id) }, 'Account locked after repeated failed logins');
  }
}

async function getUserById(id) {
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/**
 * Paginated list for the admin console.
 *
 * `.lean()` returns plain objects instead of hydrated documents — noticeably
 * faster for read-only lists. The trade-off is that lean documents skip the
 * schema's toJSON transform and virtuals, so the `id` field and the field
 * deletions do not happen automatically. An explicit projection does that
 * job here instead: it is both faster and safer than relying on a transform
 * that lean bypasses.
 *
 * (`.lean({ virtuals: true })` only works with the mongoose-lean-virtuals
 * plugin — without it the option is silently ignored, which is exactly the
 * kind of quiet mismatch that ships broken payloads.)
 */
const LIST_PROJECTION = 'name email mobile company role authProvider isEmailVerified isActive lastLoginAt createdAt';

async function listUsers({ page, limit, skip, role, search }) {
  const filter = {};
  if (role) filter.role = role;
  if (search) {
    // Escaped so a user-supplied "." or "*" cannot become a wildcard that
    // scans the whole collection.
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: new RegExp(safe, 'i') }, { email: new RegExp(safe, 'i') }];
  }

  const [docs, total] = await Promise.all([
    User.find(filter).select(LIST_PROJECTION).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  // Normalise _id → id by hand, since the toJSON transform does not run on
  // lean results.
  const items = docs.map(({ _id, ...rest }) => ({ id: _id.toString(), ...rest }));

  return { items, total, page, limit };
}

/** Only fields an admin may change; role/status changes are audited upstream. */
async function updateUser(id, { name, mobile, company, role, isActive }) {
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (mobile !== undefined) updates.mobile = mobile;
  if (company !== undefined) updates.company = company;
  if (role !== undefined) updates.role = role;
  if (isActive !== undefined) updates.isActive = isActive;

  const user = await User.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true, // findByIdAndUpdate skips schema validators by default
  });

  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** Bumping tokenVersion invalidates every refresh token already issued. */
async function revokeSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

module.exports = {
  createUser,
  verifyCredentials,
  getUserById,
  listUsers,
  updateUser,
  revokeSessions,
  MAX_FAILED_ATTEMPTS,
};
