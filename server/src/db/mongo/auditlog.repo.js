'use strict';
const AuditLog = require('../../models/auditlog.model');
const { toPlain, toPlainList } = require('./shared');

module.exports = {
  record: async (doc) => toPlain(await AuditLog.create(doc)),

  /* entityId and action narrow the feed. They are filtered in the query
     rather than by the caller afterwards, because `limit` has to apply to
     the matching rows — filtering a page of 50 down to 3 would look like
     there were only 3 matches in the whole trail. */
  list: async ({ limit = 100, entityId, action } = {}) => {
    const filter = {};
    if (entityId) filter.entityId = entityId;
    if (action) filter.action = action;
    return toPlainList(
      await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    );
  },
};
