/**
 * Audit service — read side of the audit trail.
 *
 * Append and read, and nothing else. There is no update and no delete: an
 * audit trail you can edit is not an audit trail. `record` is called at the
 * point of the action being audited (see property.service.js).
 */
'use strict';

const db = require('../db');
const logger = require('../config/logger');

/* A dashboard feed, not a data export. Capped so a UI bug asking for
   limit=100000 can't pull the whole collection into memory. */
const MAX_LIMIT = 200;

/**
 * Most recent entries first.
 *
 * The repository returns plain rows keyed by `id` with ISO timestamps on
 * either driver, so the shaping below is about what the dashboard needs, not
 * about which database answered.
 */
async function list({ limit = 50, entityId, action } = {}) {
  const capped = Math.min(Number(limit) || 50, MAX_LIMIT);

  const items = await db.auditlogs.list({ limit: capped, entityId, action });

  return items.map((entry) => ({
    id: entry.id,
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

/**
 * Writes a trail entry.
 *
 * This was `AuditLog.record()`, a Mongoose static, so it existed on exactly
 * one driver. Two behaviours came with it and both matter:
 *
 * The actor is flattened to email and role at write time rather than left as
 * a reference. An audit trail has to stay readable after the account it
 * names is renamed or deleted — a dangling reference tells you nothing about
 * who did the thing.
 *
 * A failed write is logged and swallowed. Auditing is a record of an action,
 * not part of it: failing the user's approval because the trail could not be
 * appended turns a bookkeeping problem into an outage.
 */
async function record({ actor, action, entity = 'property', entityId, before, after, ip, userAgent }) {
  try {
    await db.auditlogs.record({
      actor: actor?.id || actor?._id,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action,
      entity,
      entityId,
      before,
      after,
      ip,
      userAgent,
    });
  } catch (err) {
    logger.warn({ err: err.message, action }, 'Audit log write failed');
  }
}

module.exports = { list, record };
