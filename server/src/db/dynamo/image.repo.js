/**
 * Image METADATA. The bytes are in S3.
 *
 * A DynamoDB item is capped at 400KB. One property photo stored at four widths
 * exceeds that by itself, so image data cannot live here at any size worth
 * serving — this table holds dimensions, content type and the S3 keys that
 * point at the actual files.
 *
 * Run `npm run migrate:images` with MEDIA_DRIVER=s3 before migrating to
 * DynamoDB; it moves existing Buffers out of MongoDB and into S3.
 */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES } = require('./tables');
const repo = makeRepo(TABLES.images);

module.exports = {
  raw: repo,
  getById: (id) => repo.get(id),

  async create(doc) {
    if (doc.data) throw new Error('Image bytes belong in S3, not DynamoDB (400KB item limit)');
    const now = repo.nowIso();
    return repo.put({
      ...doc,
      id: doc.id || repo.newId(),
      storage: doc.storage || 's3',
      createdAt: doc.createdAt || now,
      updatedAt: now,
    });
  },

  listForProperty: (propertyId) =>
    repo.query(String(propertyId), { index: 'property-createdAt-index', descending: true }),

  update: (id, changes) => repo.update(id, undefined, { set: { ...changes, updatedAt: repo.nowIso() } }),
  remove: (id) => repo.delete(id),
  async removeMany(ids) { for (const id of ids) await repo.delete(id); return ids.length; },
};
