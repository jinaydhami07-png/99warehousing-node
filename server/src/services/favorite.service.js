/**
 * Favourite service — business logic for saved listings.
 */
'use strict';

const db = require('../db');
const { decorate } = require('./property.view');
const ApiError = require('../utils/ApiError');

/**
 * The user's saved listings, newest first.
 *
 * Returns full property objects (not just ids) because the client renders a
 * card per favourite; making it fetch each one separately would be N+1 over
 * the network.
 *
 * A listing that was deleted, or has since been pulled from public view,
 * resolves to null / non-approved and is filtered out — a stale favourite
 * should quietly disappear, not render as a broken card.
 *
 * This used to be one `populate('property')`. DynamoDB has no joins, so the
 * fetch is explicit now. It is a handful of rows per user and they are read
 * in parallel, so the cost is one round trip, not one per favourite.
 */
async function list(userId) {
  const rows = await db.favorites.listForUser(userId);

  const properties = await Promise.all(
    rows.map((row) => db.properties.getById(row.property).catch(() => null)),
  );

  return rows
    .map((row, i) => ({ row, property: properties[i] }))
    .filter(({ property }) => property && property.status === 'approved')
    .map(({ row, property }) => ({
      ...decorate(property),
      favoritedAt: row.createdAt,
    }));
}

/**
 * Saves a listing. Idempotent: favouriting twice is success, not an error,
 * so an impatient double-click doesn't surface a failure to the user.
 */
async function add(userId, propertyId) {
  const property = await db.properties.getById(propertyId);
  if (!property) throw ApiError.notFound('Property not found');

  /* The repository upserts rather than find-then-create: two rapid taps
     would both pass an existence check and race to insert, and the unique
     index would reject the loser with a confusing 500. */
  await db.favorites.add(userId, property.id);

  return { propertyId: String(property.id) };
}

/** Removes a saved listing. Also idempotent — removing a non-favourite is fine. */
async function remove(userId, propertyId) {
  await db.favorites.remove(userId, propertyId);
  return { propertyId: String(propertyId) };
}

module.exports = { list, add, remove };
