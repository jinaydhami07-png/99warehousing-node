/**
 * Audit log — an append-only record of who changed what.
 *
 * Exists so moderation decisions are reviewable after the fact: which admin
 * approved a listing, what the values were before and after, and when.
 * Writes here must never break the operation being audited, which is why
 * `record()` swallows its own errors rather than throwing.
 */
'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');

const auditSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorEmail: String,
    actorRole: String,

    action: { type: String, required: true, index: true }, // e.g. 'property.approved'
    entity: { type: String, default: 'property' },
    entityId: { type: mongoose.Schema.Types.ObjectId, index: true },

    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,

    ip: String,
    userAgent: String,
  },
  {
    // Only createdAt: an audit record is never updated, by definition.
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// The dashboard reads this newest-first; the index makes that a scan-free sort.
auditSchema.index({ createdAt: -1 });

/**
 * Writes an entry. Deliberately never throws — a logging failure must not
 * roll back or fail the business operation that triggered it.
 */
auditSchema.statics.record = async function record({
  actor,
  action,
  entity = 'property',
  entityId,
  before,
  after,
  ip,
  userAgent,
}) {
  try {
    await this.create({
      actor: actor?._id,
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
};

module.exports = mongoose.model('AuditLog', auditSchema);
