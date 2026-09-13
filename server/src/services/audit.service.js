/**
 * Audit service — read side of the audit trail.
 *
 * Writes happen through `AuditLog.record()` at the point of the action being
 * audited (see property.service.js). This module only reads, which is why it
 * exposes no create/update/delete: an audit trail you can edit is not an
 * audit trail.
 */
'use strict';

const AuditLog = require('../models/auditlog.model');

/* A dashboard feed, not a data export. Capped so a UI bug asking for
   limit=100000 can't pull the whole collection into memory. */
const MAX_LIMIT = 200;

/**
 * Most recent entries first.
 *
 * `.lean()` is safe here because these documents are plain data — no
 * virtuals or toJSON transform to lose — so we skip hydrating full Mongoose
 * documents for a list we only serialise.
 */
async function list({ limit = 50, entityId, action } = {}) {
  const filter = {};
  if (entityId) filter.entityId = entityId;
  if (action) filter.action = action;

  const capped = Math.min(Number(limit) || 50, MAX_LIMIT);

  const items = await AuditLog.find(filter)
    .sort({ createdAt: -1 }) // matches the { createdAt: -1 } index
    .limit(capped)
    .lean();

  return items.map((entry) => ({
    id: String(entry._id),
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ? String(entry.entityId) : null,
    actorEmail: entry.actorEmail || null,
    actorRole: entry.actorRole || null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    createdAt: entry.createdAt,
  }));
}

module.exports = { list };
