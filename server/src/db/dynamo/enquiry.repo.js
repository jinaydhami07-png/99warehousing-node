/**
 * Enquiries.
 *
 * The admin inbox needs every enquiry in date order, which has no natural
 * partition. Each row carries the literal string "ENQUIRY" in `entity` so one
 * Query returns them all, already sorted, instead of a Scan that reads the
 * table and sorts in memory.
 *
 * The cost is that all writes land on one partition. DynamoDB allows 1,000
 * writes/second to a single partition, which is far beyond this inbox. If it
 * ever approaches that, shard the value — "ENQUIRY#2026-10" — and query the
 * months you need.
 */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES, PARTITION } = require('./tables');
const repo = makeRepo(TABLES.enquiries);

/* `feed` is this driver's partition marker for the admin inbox index. It is
   not part of an enquiry and must not reach the browser — the same reason
   cityLower and searchText are stripped from listings. */
const strip = (row) => { if (!row) return row; const { feed, ...rest } = row; return rest; };
const stripAll = (rows) => (rows || []).map(strip);

module.exports = {
  raw: repo,
  getById: async (id) => strip(await repo.get(id)),

  async create(doc) {
    const now = repo.nowIso();
    const created = await repo.put({
      ...doc,
      id: doc.id || repo.newId(),
      /* `feed` rather than `entity`: a synthetic partition key, kept out of
         the way of the row's own fields so a DynamoDB row and a Mongo row
         carry the same attributes. */
      feed: PARTITION.ENQUIRY,
      status: doc.status || 'new',
      createdAt: doc.createdAt || now,
      updatedAt: now,
    });
    return strip(created);
  },

  update: async (id, changes) => strip(await repo.update(id, undefined, { set: { ...changes, updatedAt: repo.nowIso() } })),
  listForUser: async (userId) => stripAll(await repo.query(String(userId), { index: 'user-createdAt-index', descending: true })),
  listForProperty: async (propertyId) => stripAll(await repo.query(String(propertyId), { index: 'property-createdAt-index', descending: true })),
  /* Read the whole date-ordered partition, then filter, page and count in
     memory. DynamoDB cannot do a case-insensitive OR across four attributes,
     and `total` has to reflect the filter rather than the page — so the
     filtering has to happen somewhere the count can see all of it. The inbox
     is small; revisit if it ever approaches DynamoDB's 1MB page. */
  async listAll({ status, q, skip = 0, limit = 0 } = {}) {
    const all = await repo.query(PARTITION.ENQUIRY, { index: 'feed-createdAt-index', descending: true });
    const needle = q ? String(q).toLowerCase() : null;
    const matched = all.filter((e) => {
      if (status && e.status !== status) return false;
      if (!needle) return true;
      return [e.name, e.email, e.company, e.subject]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    });
    const page = limit ? matched.slice(skip, skip + limit) : matched.slice(skip);
    return { items: stripAll(page), total: matched.length };
  },
  async count() { return (await repo.query(PARTITION.ENQUIRY, { index: 'feed-createdAt-index' })).length; },
};
