/**
 * Property service — all listing and moderation business logic.
 *
 * Same layering contract as user.service.js: no `req`, no `res`, no Express.
 * Takes plain arguments, returns plain data, throws ApiError. That is what
 * lets the same logic run from a route, a seed script, or a queue worker.
 *
 * Nothing here knows which database is underneath. Filtering and sorting are
 * expressed as plain options and the repository translates them — a Mongo
 * query on one driver, an indexed read and an in-memory sort on the other.
 */
'use strict';

const db = require('../db');
const imageService = require('./image.service');
const auditService = require('./audit.service');
const { decorate, toCard } = require('./property.view');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

/** The caller's id, whichever shape the caller arrived in. */
const idOf = (actor) => String(actor?.id || actor?._id || '');

/**
 * Public listing feed.
 *
 * Hard-codes status:'approved' at the repository call, so a query string of
 * ?status=pending cannot expose unapproved listings.
 */
async function listPublic({ page, limit, skip, sort, ...filters }) {
  const { items, total } = await db.properties.listByStatus('approved', {
    filters, sort, skip, limit,
  });
  return { items: items.map(toCard), total, page, limit };
}

/** Admin list — every status visible, filterable by any of them. */
async function listAll({ page, limit, skip, sort, status, ...filters }) {
  const { items, total } = await db.properties.listAll({ filters, sort, skip, limit, status });
  return { items: items.map(decorate), total, page, limit };
}

/**
 * Fetches one listing.
 *
 * Unapproved listings are visible only to their owner and to admins, and
 * return 404 rather than 403 so their existence is not disclosed.
 */
async function getById(id, viewer) {
  const property = await db.properties.getById(id);
  if (!property) throw ApiError.notFound('Property not found');

  if (property.status !== 'approved') {
    const isOwner = viewer && String(property.owner) === idOf(viewer);
    const isAdmin = viewer?.role === 'admin';
    if (!isOwner && !isAdmin) throw ApiError.notFound('Property not found');
  }

  // Fire-and-forget: a failed counter must never fail the page load.
  db.properties.increment(property.id, 'views', 1).catch((err) =>
    logger.warn({ err: err.message, id }, 'View counter increment failed'));

  return decorate(property);
}

/**
 * The owner's contact details for one listing.
 *
 * Deliberately its own endpoint rather than a field on the property: the
 * listing feed is public, and anything returned there is readable by anyone
 * with curl. Keeping contact behind a separate authenticated call means a
 * signed-out visitor cannot obtain a phone number at all, and every reveal
 * is attributable to an account.
 *
 * Only approved listings expose contact, so a pending or rejected
 * submission cannot be used as a back door to an owner's number.
 */
async function getContact(id, viewer) {
  const property = await db.properties.getById(id);
  if (!property) throw ApiError.notFound('Property not found');

  const isStaff = viewer.role === 'admin';
  const isOwner = String(property.owner) === idOf(viewer);
  if (property.status !== 'approved' && !isStaff && !isOwner) {
    throw ApiError.notFound('Property not found');
  }

  const owner = property.owner ? await db.users.getById(property.owner) : null;

  await auditService.record({
    actor: viewer,
    action: 'property.contact_viewed',
    entityId: property.id,
    after: { property: property.name },
  });

  return {
    name: owner?.name || property.ownerName || 'Listing owner',
    company: owner?.company || null,
    /* Null rather than a placeholder when the owner has not supplied a
       number — the panel shows what it has rather than inventing a line. */
    mobile: owner?.mobile || null,
    email: owner?.email || null,
  };
}

/** Owner submits a listing. Always lands as pending — never self-approved. */
async function create(payload, owner) {
  /* Derived from the caller's role, never from the payload, and applied
     after the spread — so a crafted body containing status/isVerified is
     overwritten rather than honoured. */
  const isAdmin = owner.role === 'admin';

  const property = await db.properties.create({
    ...payload,
    owner: idOf(owner),

    /* An admin enters listings on behalf of real owners, so the name they
       type in the form is the one to keep. For everyone else the account
       name wins, so a submitter cannot attribute a listing to someone else.
       Note this is gated on isAdmin, not merely on the field being present —
       the public schema rejects the key outright, and this is the second
       lock on the same door. */
    ownerName: isAdmin && payload.ownerName ? payload.ownerName : owner.name,

    /* An admin IS the moderation queue, so holding their listing for review
       would leave it waiting on themselves — default them to approved, but
       honour an explicit choice (e.g. entering a listing that still needs
       checking). Everyone else always starts pending, regardless of what the
       payload asked for. */
    status: isAdmin ? payload.status || 'approved' : 'pending',
    isVerified: isAdmin ? payload.isVerified !== false : false,
  });

  /* Tie the uploaded images to this listing so they stop counting as
     orphans, and so every photo in the collection knows which property it
     belongs to. The floor plan goes in the same call — it is uploaded
     through the same endpoint and was previously left untagged, which meant
     deleting the listing never cleaned it up.
     Best-effort: the listing is already saved, and losing the tag is a
     housekeeping problem, not a reason to fail the submission. */
  await imageService.attachToProperty(property.images, property.id, [property.floorPlan]);

  await auditService.record({
    actor: owner,
    action: isAdmin ? 'property.created' : 'property.submitted',
    entityId: property.id,
    after: { name: property.name, rate: property.rate, status: property.status },
  });

  logger.info({ propertyId: property.id, ownerId: idOf(owner) }, 'Property submitted');
  return decorate(property);
}

/**
 * Updates a listing.
 *
 * An owner's edit sends it back to pending for re-review; an admin's does
 * not. Without that, an owner could get a listing approved and then quietly
 * change the price.
 */
async function update(id, patch, actor) {
  const existing = await db.properties.getById(id);
  if (!existing) throw ApiError.notFound('Property not found');

  if (actor.role !== 'admin' && String(existing.owner) !== idOf(actor)) {
    throw ApiError.forbidden('You can only edit your own listings');
  }

  const before = { name: existing.name, rate: existing.rate, status: existing.status };

  const changes = { ...patch };
  if (actor.role !== 'admin') {
    changes.status = 'pending';
    changes.isVerified = false;
  }

  /* A rejection reason only makes sense while the listing is rejected.
     Without this, an owner who fixes the problem and resubmits — or an admin
     who flips the status back — leaves the old "documents incomplete" note
     attached to a listing that is no longer rejected, and the detail page
     shows it. Cleared explicitly, because assigning undefined is a no-op in
     both drivers' update paths. */
  const status = changes.status ?? existing.status;
  const remove = status !== 'rejected' ? ['rejectionReason'] : [];
  if (remove.length) delete changes.rejectionReason;

  const property = await db.properties.update(id, changes, { remove });

  /* An edit can add photos or a floor plan, so tag anything newly attached. */
  if (patch.images || patch.floorPlan) {
    await imageService.attachToProperty(property.images, property.id, [property.floorPlan]);
  }

  await auditService.record({
    actor,
    action: 'property.edited',
    entityId: property.id,
    before,
    after: { name: property.name, rate: property.rate, status: property.status },
  });

  return decorate(property);
}

async function remove(id, actor) {
  const property = await db.properties.getById(id);
  if (!property) throw ApiError.notFound('Property not found');

  if (actor.role !== 'admin' && String(property.owner) !== idOf(actor)) {
    throw ApiError.forbidden('You can only delete your own listings');
  }

  await db.properties.remove(id);

  /* The listing is gone, so its photos have nothing left to belong to.
     Without this they stay in the bucket and in the images collection
     forever, billed monthly and attached to nothing.
     After the delete, and unawaited failures are swallowed inside the
     service, so a slow S3 call cannot hold up the response. */
  imageService
    .removeForProperty(id)
    .catch((err) => logger.warn({ err: err.message, id }, 'Could not clean up listing images'));

  await auditService.record({
    actor,
    action: 'property.deleted',
    entityId: id,
    before: { name: property.name },
  });

  return { deleted: true };
}

/** Publishes a pending listing. */
async function approve(id, admin) {
  const existing = await db.properties.getById(id);
  if (!existing) throw ApiError.notFound('Property not found');

  const before = { status: existing.status };

  const property = await db.properties.update(
    id,
    { status: 'approved', isVerified: true },
    { remove: ['rejectionReason'] },
  );

  await auditService.record({
    actor: admin,
    action: 'property.approved',
    entityId: property.id,
    before,
    after: { status: 'approved' },
  });

  logger.info({ propertyId: property.id }, 'Property approved');
  return decorate(property);
}

/** Rejects a listing. A reason is mandatory — the owner has to know why. */
async function reject(id, reason, admin) {
  const existing = await db.properties.getById(id);
  if (!existing) throw ApiError.notFound('Property not found');

  const before = { status: existing.status };

  const property = await db.properties.update(id, {
    status: 'rejected',
    isVerified: false,
    rejectionReason: reason,
  });

  await auditService.record({
    actor: admin,
    action: 'property.rejected',
    entityId: property.id,
    before,
    after: { status: 'rejected', reason },
  });

  logger.info({ propertyId: property.id }, 'Property rejected');
  return decorate(property);
}

/** The signed-in owner's own submissions, including review status. */
async function listMine(ownerId) {
  const items = await db.properties.listByOwner(ownerId);
  return items.map(decorate);
}

/** Counters for the admin dashboard. */
async function stats() {
  const s = await db.properties.stats();
  return {
    total: s.total,
    pending: s.pending,
    approved: s.approved,
    rejected: s.rejected,
  };
}

module.exports = {
  listPublic,
  listAll,
  getById,
  create,
  update,
  remove,
  approve,
  reject,
  listMine,
  stats,
  getContact,
};
