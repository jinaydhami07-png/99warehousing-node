/**
 * Favourites — the entity DynamoDB models best.
 *
 * user + property IS the key, so adding a favourite is an idempotent Put,
 * removing one is a Delete, and a duplicate row is impossible by construction.
 * The old code needed an upsert with $setOnInsert to get the same guarantee.
 */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES } = require('./tables');
const repo = makeRepo(TABLES.favorites);

module.exports = {
  raw: repo,
  add: (userId, propertyId) =>
    repo.put({ user: String(userId), property: String(propertyId), createdAt: repo.nowIso() }),
  remove: (userId, propertyId) => repo.delete(String(userId), String(propertyId)),
  listForUser: (userId) => repo.query(String(userId)),
  async has(userId, propertyId) {
    return Boolean(await repo.get(String(userId), String(propertyId)));
  },
};
