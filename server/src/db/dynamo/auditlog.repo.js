/**
 * Audit log — append-only, and only the recent entries are ever read.
 *
 * Rows carry `expiresAt`, a unix timestamp DynamoDB uses to delete them for
 * free once they age out. Without it an audit table grows forever and is
 * eventually the largest thing in the account.
 */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES, PARTITION } = require('./tables');
const repo = makeRepo(TABLES.auditlogs);

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 365);

/* `feed` is the partition marker for the trail index, not a field of the
   entry. Stripped on the way out so both drivers return the same shape. */
const strip = (row) => { if (!row) return row; const { feed, ...rest } = row; return rest; };

module.exports = {
  raw: repo,
  async record(doc) {
    const now = repo.nowIso();
    const written = await repo.put({
      ...doc,
      id: doc.id || repo.newId(),
      /* `feed`, not `entity`. The index needs every row in one partition,
         but `entity` is a real field — it records what was acted on
         ('property', 'review'). Putting the partition constant there
         overwrote it, and the admin trail showed "AUDIT" as the subject of
         every entry. They are two different things and now have two
         different attributes. */
      feed: PARTITION.AUDIT,
      entity: doc.entity || 'property',
      createdAt: doc.createdAt || now,
      expiresAt: Math.floor(Date.now() / 1000) + RETENTION_DAYS * 86400,
    });
    return strip(written);
  },
  /* entityId and action narrow the feed. Applied as a DynamoDB
     FilterExpression, which runs before `limit` is handed back, so a capped
     page still reflects the matching rows rather than a page of everything
     cut down afterwards. */
  list: ({ limit = 100, entityId, action } = {}) =>
    repo.query(PARTITION.AUDIT, {
      index: 'feed-createdAt-index',
      descending: true,
      limit,
      filter: { ...(entityId ? { entityId } : {}), ...(action ? { action } : {}) },
    }).then((rows) => rows.map(strip)),
};
