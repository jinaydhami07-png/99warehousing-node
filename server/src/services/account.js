/**
 * Rules about the state of an account, as plain functions over a plain row.
 *
 * These were Mongoose instance methods — `user.isLocked()`,
 * `user.passwordChangedAfter(iat)` — which only exist on a hydrated
 * document. The repository layer returns plain objects, so they move here.
 *
 * ── Why the date handling looks defensive ─────────────────────────────────
 * MongoDB stores a date and hands back a `Date`. DynamoDB has no date type,
 * so the same field comes back as an ISO string. The old code compared
 * `user.lockedUntil > Date.now()` — a `Date` compares correctly against a
 * number, a string does not, and the comparison is silently `false`. That
 * failure mode is the dangerous direction: the lockout simply stops
 * existing, and brute-force protection disappears without an error anywhere.
 *
 * So every comparison goes through an explicit parse.
 */
'use strict';

/** Date | ISO string | epoch ms | null → epoch ms, or NaN if unusable. */
function toMillis(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/** True while the account is inside its lockout window. */
function isLocked(user) {
  const until = toMillis(user?.lockedUntil);
  return Number.isFinite(until) && until > Date.now();
}

/** Whole minutes remaining on the lockout, at least 1 while still locked. */
function lockMinutesRemaining(user) {
  const until = toMillis(user?.lockedUntil);
  if (!Number.isFinite(until)) return 0;
  return Math.max(1, Math.ceil((until - Date.now()) / 60000));
}

/**
 * True if the password changed after this token was issued.
 *
 * `iat` has one-second precision, so the stored timestamp is deliberately
 * backdated by a second when the password changes (see db/password.js).
 */
function passwordChangedAfter(user, jwtIssuedAtSeconds) {
  const changed = toMillis(user?.passwordChangedAt);
  if (!Number.isFinite(changed)) return false;
  return Math.floor(changed / 1000) > jwtIssuedAtSeconds;
}

module.exports = { isLocked, lockMinutesRemaining, passwordChangedAfter, toMillis };
