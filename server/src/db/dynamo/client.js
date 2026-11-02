/**
 * DynamoDB client.
 *
 * ── Credentials ───────────────────────────────────────────────────────────
 * Nothing here reads an access key. In production the task role attached to
 * the App Runner service supplies temporary, rotating credentials, which the
 * SDK's default provider chain picks up on its own. Long-lived AWS keys in
 * environment variables are the thing this avoids: they leak, they do not
 * rotate, and this project has already had one settings file served over the
 * web. The only time a key is used is a developer's own `aws configure`.
 *
 * ── Local development ─────────────────────────────────────────────────────
 * Set DYNAMO_ENDPOINT (e.g. http://localhost:8000) to point at DynamoDB Local.
 * Dummy credentials are supplied in that case because the SDK insists on
 * having some, and DynamoDB Local ignores them entirely.
 */
'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const endpoint = process.env.DYNAMO_ENDPOINT || undefined;
const region = process.env.AWS_REGION || process.env.DYNAMO_REGION || 'ap-south-1';

const base = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
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
