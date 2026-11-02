/**
 * Reviews.
 *
 * property + author as the composite key makes "one review per person per
 * property" a property of the data model rather than a rule the application
 * has to remember to enforce — writing twice simply overwrites.
 *
 * Moderation works from a review id, which is not the key, so `id-index`
 * exists for that path.
 */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES } = require('./tables');
const repo = makeRepo(TABLES.reviews);

module.exports = {
  raw: repo,

  get: (propertyId, authorId) => repo.get(String(propertyId), String(authorId)),

  async getById(id) {
    const rows = await repo.query(String(id), { index: 'id-index', limit: 1 });
    return rows[0] || null;
  },

  async upsert(doc) {
    const now = repo.nowIso();
    const existing = await repo.get(String(doc.property), String(doc.author));
    return repo.put({
      ...existing,
      ...doc,
      property: String(doc.property),
      author: String(doc.author),
      id: existing?.id || doc.id || repo.newId(),
      status: doc.status || existing?.status || 'pending',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  },

  listForProperty: (propertyId, { status } = {}) =>
    repo.query(String(propertyId), { filter: status ? { status } : undefined }),

  listByStatus: (status, { limit } = {}) =>
    repo.query(status, { index: 'status-createdAt-index', descending: true, limit }),

  /* Paged variants return `total` as the count of MATCHING rows, not the
     page length. Both read the partition and slice in memory: a review set
     for one property, or one moderation queue, is small, and DynamoDB
     cannot report a filtered count without reading the rows anyway. */
  async pageForProperty(propertyId, { status, skip = 0, limit = 0 } = {}) {
    const all = await repo.query(String(propertyId), { filter: status ? { status } : undefined });
    all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { items: limit ? all.slice(skip, skip + limit) : all.slice(skip), total: all.length };
  },

  async pageByStatus(status, { skip = 0, limit = 0 } = {}) {
    const all = await repo.query(status, { index: 'status-createdAt-index', descending: true });
    return { items: limit ? all.slice(skip, skip + limit) : all.slice(skip), total: all.length };
  },

  /* A rejection reason belongs only to a rejected review — carrying a stale
     one onto an approval would show the author why it was turned down right
     next to the news that it was published. */
  async moderate(id, status, rejectionReason) {
    const row = await this.getById(id);
    if (!row) return null;
    return repo.update(row.property, row.author, {
      set: { status, updatedAt: repo.nowIso(), ...(status === 'rejected' ? { rejectionReason } : {}) },
      ...(status === 'rejected' ? {} : { remove: ['rejectionReason'] }),
    });
  },

  async removeById(id) {
    const row = await this.getById(id);
    if (!row) return false;
    await repo.delete(row.property, row.author);
    return true;
  },

  /**
   * Average rating — the one aggregation pipeline in the old code.
   * Published reviews for a property are a single partition, so this is one
   * Query and a reduce, not a Scan.
   */
  async ratingFor(propertyId) {
    const rows = await this.listForProperty(propertyId, { status: 'published' });
    if (!rows.length) return { average: null, count: 0 };
    const sum = rows.reduce((a, r) => a + Number(r.rating || 0), 0);
    return { average: Math.round((sum / rows.length) * 10) / 10, count: rows.length };
  },
};
