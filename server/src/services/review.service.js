/**
 * Review service — ratings left against a property.
 */
'use strict';

const mongoose = require('mongoose');
const Review = require('../models/review.model');
const Property = require('../models/property.model');
const AuditLog = require('../models/auditlog.model');
const ApiError = require('../utils/ApiError');

/**
 * Creates a review, or replaces the author's existing one.
 *
 * Upsert rather than insert because the unique (property, author) index
 * would otherwise reject a second attempt with a duplicate-key error — which
 * reads to the visitor as "something went wrong" when what they meant was
 * "I want to change what I said".
 */
async function create(propertyId, payload, author) {
  const property = await Property.findById(propertyId).select('_id status owner');
  if (!property) throw ApiError.notFound('Property not found');

  /* Only listings the public can actually see may be reviewed. Without this
     an unapproved or rejected listing could quietly collect ratings that
     appear the moment it goes live. */
  if (property.status !== 'approved') {
    throw ApiError.badRequest('This listing is not open for reviews yet');
  }

  /* An owner rating their own listing is not a review, it is advertising. */
  if (String(property.owner) === String(author._id)) {
    throw ApiError.forbidden('You cannot review your own listing');
  }

  const existing = await Review.findOne({ property: property._id, author: author._id });

  const doc = {
    property: property._id,
    author: author._id,
    authorName: author.name || 'Verified user',
    authorRole: payload.authorRole,
    rating: payload.rating,
    comment: payload.comment,
    /* Edits go back through moderation — otherwise a published review could
       be swapped for anything after the fact. */
    status: 'pending',
    rejectionReason: undefined,
  };

  const review = existing
    ? await Review.findOneAndUpdate({ _id: existing._id }, doc, { new: true, runValidators: true })
    : await Review.create(doc);

  return { review, replaced: !!existing };
}

/**
 * Published reviews for one property, newest first, plus the average.
 *
 * The average is computed over the same published set that is returned, so
 * the star summary can never disagree with the reviews under it.
 */
async function listForProperty(propertyId, { page = 1, limit = 10 } = {}) {
  const filter = { property: propertyId, status: 'published' };
  const skip = (page - 1) * limit;

  const [items, total, agg] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Review.countDocuments(filter),
    Review.aggregate([
      /* $match in an aggregation does no schema casting, so the id has to be
         a real ObjectId here — a string would silently match nothing and the
         average would read as null against a list of visible reviews. */
      { $match: { property: new mongoose.Types.ObjectId(String(propertyId)), status: 'published' } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]),
  ]);

  const summary = agg[0] || { average: 0, count: 0 };

  return {
    items,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    average: summary.count ? Math.round(summary.average * 10) / 10 : null,
    count: summary.count,
  };
}

/** The signed-in user's own review of a property, whatever its status. */
async function mineFor(propertyId, author) {
  return Review.findOne({ property: propertyId, author: author._id });
}

/** Everything awaiting a decision, for the admin queue. */
async function listPending({ page = 1, limit = 50 } = {}) {
  const filter = { status: 'pending' };
  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('property', 'name city'),
    Review.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function moderate(id, { status, rejectionReason }, actor) {
  const review = await Review.findById(id);
  if (!review) throw ApiError.notFound('Review not found');

  review.status = status;
  review.rejectionReason = status === 'rejected' ? rejectionReason : undefined;
  await review.save();

  /* AuditLog.record swallows its own failures by design — a logging problem
     must not roll back a moderation decision. */
  await AuditLog.record({
    actor,
    action: `review.${status}`,
    entity: 'review',
    entityId: review._id,
    after: { rating: review.rating, property: String(review.property) },
  });

  return review;
}

async function remove(id, actor) {
  const review = await Review.findById(id);
  if (!review) throw ApiError.notFound('Review not found');

  const isOwnReview = String(review.author) === String(actor._id);
  if (actor.role !== 'admin' && !isOwnReview) {
    throw ApiError.forbidden('You can only delete your own review');
  }

  await review.deleteOne();
  return { id };
}

module.exports = { create, listForProperty, mineFor, listPending, moderate, remove };
