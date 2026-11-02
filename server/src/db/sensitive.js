/**
 * Fields the User schema marks `select: false`.
 *
 * MongoDB omits these from every query unless they are explicitly asked for,
 * which is what keeps password hashes and session metadata out of API
 * responses. DynamoDB has no equivalent — an item comes back whole — so
 * without this list the two drivers would differ in a way that leaks
 * credentials rather than merely behaving oddly.
 *
 * Both drivers therefore honour the same rule: hidden by default, returned
 * only when a caller passes { secrets: true }, which the authentication paths
 * do deliberately.
 */
'use strict';

const USER_SECRETS = [
  'password',
  'failedLoginAttempts',
  'lockedUntil',
  'tokenVersion',
  'passwordChangedAt',
];

/** Mongoose projection string: '+password +tokenVersion ...' */
const USER_SECRETS_SELECT = USER_SECRETS.map((f) => `+${f}`).join(' ');

/** Removes the hidden fields from a plain object (the DynamoDB side). */
function stripSecrets(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of USER_SECRETS) delete out[f];
  return out;
}

module.exports = { USER_SECRETS, USER_SECRETS_SELECT, stripSecrets };
