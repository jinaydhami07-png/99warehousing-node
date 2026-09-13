/**
 * Favourite service — business logic for saved listings.
 */
'use strict';

const Favorite = require('../models/favorite.model');
const Property = require('../models/property.model');
const ApiError = require('../utils/ApiError');

/**
 * The user's saved listings, newest first.
 *
 * Returns full property objects (not just ids) because the client renders a
 * card per favourite; making it fetch each one separately would be N+1 over
 * the network.
 *
 * A listing that was deleted, or has since been pulled from public view,
 * populates as null / non-approved and is filtered out — a stale favourite
 * should quietly disappear, not render as a broken card.
 */
async function list(userId) {
  const rows = await Favorite.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate('property');

  return rows
    .filter((row) => row.property && row.property.status === 'approved')
    .map((row) => ({
      ...row.property.toJSON(),
      favoritedAt: row.createdAt,
    }));
}

/**
 * Saves a listing. Idempotent: favouriting twice is success, not an error,
 * so an impatient double-click doesn't surface a failure to the user.
 */
async function add(userId, propertyId) {
  const property = await Property.findById(propertyId).select('_id status');
  if (!property) throw ApiError.notFound('Property not found');

  /* upsert rather than find-then-create: two rapid taps would both pass the
     existence check and race to insert. The unique index would reject the
     loser with a confusing 500; an upsert simply returns the existing row. */
  await Favorite.updateOne(
    { user: userId, property: property._id },
    { $setOnInsert: { user: userId, property: property._id } },
    { upsert: true }
  );

  return { propertyId: String(property._id) };
}

/** Removes a saved listing. Also idempotent — removing a non-favourite is fine. */
async function remove(userId, propertyId) {
  await Favorite.deleteOne({ user: userId, property: propertyId });
  return { propertyId: String(propertyId) };
}

module.exports = { list, add, remove };
