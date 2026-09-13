/**
 * Enquiry service — business logic for contact and listing enquiries.
 */
'use strict';

const Enquiry = require('../models/enquiry.model');
const Property = require('../models/property.model');
const AuditLog = require('../models/auditlog.model');
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
     would leave a dangling reference that populates as null forever. The
     name is denormalised so the admin inbox still reads correctly if the
     listing is later deleted. */
  if (payload.property) {
    const property = await Property.findById(payload.property).select('_id name');
    if (!property) throw ApiError.notFound('Property not found');
    doc.property = property._id;
    doc.propertyName = property.name;
  }

  if (actor?._id) doc.user = actor._id;

  const enquiry = await Enquiry.create(doc);

  /* Bump the counter shown on the listing. Best-effort: a failed increment
     is a cosmetic problem and must not fail the visitor's enquiry. */
  if (doc.property) {
    Property.updateOne({ _id: doc.property }, { $inc: { enquiryCount: 1 } }).catch((err) =>
      logger.warn({ err: err.message }, 'Enquiry count increment failed')
    );
  }

  logger.info({ enquiryId: enquiry.id, property: doc.property }, 'Enquiry received');
  return enquiry.toJSON();
}

/** The signed-in user's own enquiries, newest first. */
async function listMine(userId) {
  const items = await Enquiry.find({ user: userId }).sort({ createdAt: -1 });
  return items.map((e) => e.toJSON());
}

/** Admin inbox. */
async function listAll({ page, limit, skip, status, q }) {
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { company: rx }, { subject: rx }];
  }

  const [items, total] = await Promise.all([
    Enquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Enquiry.countDocuments(filter),
  ]);

  return { items: items.map((e) => e.toJSON()), total, page, limit };
}

/** Admin: mark contacted/closed, or attach an internal note. */
async function update(id, patch, admin) {
  const enquiry = await Enquiry.findById(id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');

  const before = { status: enquiry.status };
  Object.assign(enquiry, patch);
  await enquiry.save();

  await AuditLog.record({
    actor: admin,
    action: 'enquiry.updated',
    entity: 'enquiry',
    entityId: enquiry._id,
    before,
    after: { status: enquiry.status },
  });

  return enquiry.toJSON();
}

module.exports = { create, listMine, listAll, update };
