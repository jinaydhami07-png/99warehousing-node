/**
 * User service — all business logic for users lives here.
 *
 * The layering rule this file exists to enforce:
 *   • Services know nothing about HTTP. No `req`, no `res`, no status codes
 *     beyond throwing ApiError. They take plain arguments and return plain
 *     data, which is what makes them unit-testable and reusable from a CLI
 *     script, a queue worker, or a GraphQL resolver later.
 *   • Controllers know nothing about the database.
 *   • Services know nothing about WHICH database. Everything goes through
 *     the repository layer, so the store is a configuration choice.
 *
 * If you find yourself importing `express` here, the logic belongs in a
 * controller instead.
 */
'use strict';

const db = require('../db');
const { comparePassword } = require('../db/password');
const { isLocked, lockMinutesRemaining } = require('./account');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Creates a user.
 * @throws {ApiError} 409 if the email is taken.
 */
async function createUser({ name, email, password, mobile, company, accountType }) {
  const existing = await db.users.findByEmail(email);
  if (existing) throw ApiError.conflict('An account with that email already exists');

  // `role` is derived from a constrained input, never taken from the caller
  // verbatim — otherwise a crafted body could self-assign 'admin'.
  const role = ['buyer', 'owner', 'agency'].includes(accountType) ? accountType : 'buyer';

  /* The password arrives in plaintext and is hashed at the repository
     boundary, which is the one place every write passes through. */
  const user = await db.users.create({ name, email, password, mobile, company, role });
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
  const user = await db.users.findByEmail(email, { secrets: true });

  if (!user) {
    // Note: this returns faster than the password branch below, which is a
    // theoretical timing oracle. Mitigated at the route level by rate
    // limiting; a constant-time dummy compare can be added if the threat
    // model warrants it.
    throw ApiError.unauthorized('Incorrect email or password');
  }

  if (isLocked(user)) {
    throw ApiError.tooMany(
      `Account temporarily locked. Try again in ${lockMinutesRemaining(user)} minute(s).`,
    );
  }

  if (!(await comparePassword(password, user.password))) {
    await registerFailedAttempt(user);
    throw ApiError.unauthorized('Incorrect email or password');
  }

  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  // Atomic reset so a successful login cannot race with a concurrent failure.
  await db.users.clearLoginFailures(user.id);

  return user;
}

/**
 * Increments the failure counter and locks the account at the threshold.
 *
 * The increment is atomic in the store and the result is read back, rather
 * than computing `stored + 1` in application code. Parallel login attempts
 * would otherwise each read the same starting value and write back the same
 * number, so an attacker running requests concurrently could exceed the
 * threshold without the counter ever reaching it.
 */
async function registerFailedAttempt(user) {
  const updated = await db.users.recordFailedLogin(user.id);

  if (updated && updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    /* ISO rather than a Date: DynamoDB has no date type, and the lock check
       parses either. Storing a Date here would arrive as an object DynamoDB
       cannot marshal. */
    await db.users.update(user.id, {
      failedLoginAttempts: 0,
      lockedUntil: new Date(Date.now() + LOCK_DURATION_MS).toISOString(),
    });
    logger.warn({ userId: String(user.id) }, 'Account locked after repeated failed logins');
  }
}

async function getUserById(id) {
  const user = await db.users.getById(id);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** Paginated list for the admin console. */
async function listUsers({ page, limit, skip, role, search }) {
  const { items, total } = await db.users.page({ role, search, skip, limit });
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

  const user = await db.users.update(id, updates);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** Bumping tokenVersion invalidates every refresh token already issued. */
async function revokeSessions(userId) {
  await db.users.bumpTokenVersion(userId);
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
