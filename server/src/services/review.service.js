/**
 * Review service — ratings left against a property.
 */
'use strict';

const db = require('../db');
const auditService = require('./audit.service');
const ApiError = require('../utils/ApiError');

/**
 * Shapes a stored review for the wire.
 *
 * `author` is dropped. It has no use in the browser and would tie a public
 * opinion to a real account record — the model's toJSON transform removed it
 * for exactly that reason, and that transform stops running once these rows
 * come from the repository layer instead of Mongoose.
 */
function toWire(review) {
  if (!review) return review;
  const { author, ...rest } = review;
  return rest;
}

/**
 * Creates a review, or replaces the author's existing one.
 *
 * Upsert rather than insert because one review per person per property is a
 * uniqueness rule in the store; a second insert would otherwise be rejected
 * with a duplicate-key error — which reads to the visitor as "something went
 * wrong" when what they meant was "I want to change what I said".
 */
async function create(propertyId, payload, author) {
  const property = await db.properties.getById(propertyId);
  if (!property) throw ApiError.notFound('Property not found');

  /* Only listings the public can actually see may be reviewed. Without this
     an unapproved or rejected listing could quietly collect ratings that
     appear the moment it goes live. */
  if (property.status !== 'approved') {
    throw ApiError.badRequest('This listing is not open for reviews yet');
  }

  const authorId = author.id || author._id;

  /* An owner rating their own listing is not a review, it is advertising. */
  if (String(property.owner) === String(authorId)) {
    throw ApiError.forbidden('You cannot review your own listing');
  }

  const existing = await db.reviews.get(property.id, authorId);

  const review = await db.reviews.upsert({
    property: property.id,
    author: authorId,
    authorName: author.name || 'Verified user',
    authorRole: payload.authorRole,
    rating: payload.rating,
    comment: payload.comment,
    /* Edits go back through moderation — otherwise a published review could
       be swapped for anything after the fact. */
    status: 'pending',
    rejectionReason: undefined,
  });

  return { review: toWire(review), replaced: !!existing };
}

/**
 * Published reviews for one property, newest first, plus the average.
 *
 * The average is computed over the same published set that is returned, so
 * the star summary can never disagree with the reviews under it.
 */
async function listForProperty(propertyId, { page = 1, limit = 10 } = {}) {
  const skip = (page - 1) * limit;

  const [{ items, total }, summary] = await Promise.all([
    db.reviews.pageForProperty(propertyId, { status: 'published', skip, limit }),
    db.reviews.ratingFor(propertyId),
  ]);

  return {
    items: items.map(toWire),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    average: summary.count ? summary.average : null,
    count: summary.count,
  };
}

/** The signed-in user's own review of a property, whatever its status. */
async function mineFor(propertyId, author) {
  return toWire(await db.reviews.get(propertyId, author.id || author._id));
}

/**
 * Everything awaiting a decision, for the admin queue.
 *
 * The listing's name and city used to arrive by populate(). They are fetched
 * explicitly now — in parallel, and only for the page being shown, so the
 * queue costs one round trip rather than one per review.
 */
async function listPending({ page = 1, limit = 50 } = {}) {
  const skip = (page - 1) * limit;
  const { items, total } = await db.reviews.pageByStatus('pending', { skip, limit });

  const properties = await Promise.all(
    items.map((r) => db.properties.getById(r.property).catch(() => null)),
  );

  const withProperty = items.map((review, i) => ({
    ...toWire(review),
    property: properties[i]
      ? { id: properties[i].id, name: properties[i].name, city: properties[i].city }
      : null,
  }));

  return { items: withProperty, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function moderate(id, { status, rejectionReason }, actor) {
  const existing = await db.reviews.getById(id);
  if (!existing) throw ApiError.notFound('Review not found');

  const review = await db.reviews.moderate(id, status, rejectionReason);

  /* audit.record swallows its own failures by design — a logging problem
     must not roll back a moderation decision. */
  await auditService.record({
    actor,
    action: `review.${status}`,
    entity: 'review',
    entityId: review.id,
    after: { rating: review.rating, property: String(review.property) },
  });

  return toWire(review);
}

async function remove(id, actor) {
  const review = await db.reviews.getById(id);
  if (!review) throw ApiError.notFound('Review not found');

  const actorId = actor.id || actor._id;
  const isOwnReview = String(review.author) === String(actorId);
  if (actor.role !== 'admin' && !isOwnReview) {
    throw ApiError.forbidden('You can only delete your own review');
  }

  await db.reviews.removeById(id);
  return { id };
}

module.exports = { create, listForProperty, mineFor, listPending, moderate, remove };
