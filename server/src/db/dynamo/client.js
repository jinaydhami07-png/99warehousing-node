/**
 * DynamoDB client.
 *
 * ── Credentials ───────────────────────────────────────────────────────────
 * Preferred: no key at all. Where the host can attach a role, the SDK's
 * default provider chain picks up temporary, rotating credentials on its own,
 * and that is what should be used. Long-lived AWS keys leak, do not rotate,
 * and this project has already had one settings file served over the web.
 *
 * But the host this actually runs on is cPanel shared hosting, which has no
 * instance role of any kind, so the key has to come from `server/env`. That
 * is why `config/env` is required below *before* anything reads
 * `process.env`: it is the module that loads that file. Without it a job run
 * straight from a checkout sees an empty environment and fails with
 * "Could not load credentials from any providers", which reads like an IAM
 * problem and is not one.
 *
 * ── Local development ─────────────────────────────────────────────────────
 * Set DYNAMO_ENDPOINT (e.g. http://localhost:8000) to point at DynamoDB Local.
 * Dummy credentials are supplied in that case because the SDK insists on
 * having some, and DynamoDB Local ignores them entirely.
 */
'use strict';

/* Loaded for its side effect: it reads server/env into process.env. The app
   requires it early anyway, but a job requires this module directly. */
require('../../config/env');

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const endpoint = process.env.DYNAMO_ENDPOINT || undefined;
const region = process.env.AWS_REGION || process.env.DYNAMO_REGION || undefined;

/* No default region, deliberately.
 *
 * This used to fall back to a hard-coded region, and that is worse than
 * failing: every table name exists independently in every region, so a
 * missing AWS_REGION did not error — it pointed the whole application at an
 * empty copy of the database in a region nobody had looked at, and
 * `dynamo:tables` would have cheerfully created a second set of tables there.
 * An unset region is a configuration mistake and has to say so. */
if (!region && !endpoint) {
  throw new Error(
    'AWS_REGION is not set, so there is no way to know which region the ' +
      'tables are in. Set AWS_REGION in server/env (the tables for this ' +
      'project are in ap-southeast-2). Guessing a region would silently read ' +
      'an empty database rather than fail.'
  );
}

/* Explicit rather than left to the provider chain, so that a key present in
   server/env is used even when the chain would not look there. Undefined when
   absent, which is what lets a real instance role take over. */
const credentials =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
      }
    : undefined;

const base = new DynamoDBClient({
  region: region || 'local',
  ...(endpoint
    ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : credentials
      ? { credentials }
      : {}),
  maxAttempts: 3,
});

const doc = DynamoDBDocumentClient.from(base, {
  marshallOptions: {
    /* Mongoose documents are full of optional fields. Dropping undefined keeps
       DynamoDB from rejecting the write, and matches how the old schema
       behaved — an absent field and an undefined one were the same thing. */
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
  unmarshallOptions: { wrapNumbers: false },
});

module.exports = { doc, base, region, endpoint, isLocal: Boolean(endpoint) };
