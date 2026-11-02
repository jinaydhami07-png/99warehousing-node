/**
 * Enquiry service — business logic for contact and listing enquiries.
 */
'use strict';

const db = require('../db');
const auditService = require('./audit.service');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

/**
 * Files an enquiry.
 *
 * `actor` is optional: the contact form is public, and an enquiry from a
 * signed-out visitor is the common case rather than an edge case.
 */
async function create(payload, actor, meta = {}) {
  const doc = {
    name: payload.name,
    email: payload.email,
    mobile: payload.mobile,
    company: payload.company,
    subject: payload.subject || 'General enquiry',
    message: payload.message,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };

  /* Link the listing only if it genuinely exists — otherwise a typo'd id
     would leave a dangling reference that resolves to null forever. The
     name is denormalised so the admin inbox still reads correctly if the
     listing is later deleted. */
  if (payload.property) {
    const property = await db.properties.getById(payload.property);
    if (!property) throw ApiError.notFound('Property not found');
    doc.property = property.id;
    doc.propertyName = property.name;
  }

  const actorId = actor?.id || actor?._id;
  if (actorId) doc.user = actorId;

  const enquiry = await db.enquiries.create(doc);

  /* Bump the counter shown on the listing. Best-effort: a failed increment
     is a cosmetic problem and must not fail the visitor's enquiry. */
  if (doc.property) {
    db.properties.increment(doc.property, 'enquiryCount', 1).catch((err) =>
      logger.warn({ err: err.message }, 'Enquiry count increment failed'));
  }

  logger.info({ enquiryId: enquiry.id, property: doc.property }, 'Enquiry received');
  return enquiry;
}

/** The signed-in user's own enquiries, newest first. */
async function listMine(userId) {
  return db.enquiries.listForUser(userId);
}

/** Admin inbox. */
async function listAll({ page, limit, skip, status, q }) {
  const { items, total } = await db.enquiries.listAll({ status, q, skip, limit });
  return { items, total, page, limit };
}

/** Admin: mark contacted/closed, or attach an internal note. */
async function update(id, patch, admin) {
  const existing = await db.enquiries.getById(id);
  if (!existing) throw ApiError.notFound('Enquiry not found');

  const before = { status: existing.status };
  const enquiry = await db.enquiries.update(id, patch);

  await auditService.record({
    actor: admin,
    action: 'enquiry.updated',
    entity: 'enquiry',
    entityId: enquiry.id,
    before,
    after: { status: enquiry.status },
  });

  return enquiry;
}

module.exports = { create, listMine, listAll, update };
