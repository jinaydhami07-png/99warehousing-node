/**
 * Listing slugs, generated once per driver-neutral write.
 *
 * This was a Mongoose `pre('save')` hook on the property model, which means
 * the DynamoDB driver produced listings with no slug at all — and a slug is
 * not decoration here, it is what a shareable listing URL is built from.
 *
 * Same reasoning as src/db/password.js: a rule that every write has to obey
 * belongs at the repository boundary, not in one driver's ORM.
 */
'use strict';

/** "Bhiwandi Logistics Hub" → "bhiwandi-logistics-hub", capped at 60 chars. */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Appends a short suffix drawn from the row's own id.
 *
 * Two listings can legitimately share a name — "Warehouse, Bhiwandi" is not
 * distinctive — and the slug column is unique, so the second insert would be
 * rejected without one. Taking it from the id rather than fresh randomness
 * makes the slug reproducible: regenerating it for the same row twice gives
 * the same answer, so a repair script cannot quietly change live URLs.
 */
function makeSlug(name, id) {
  const base = slugify(name);
  if (!base) return undefined;
  const suffix = String(id || '').slice(-6);
  return suffix ? `${base}-${suffix}` : base;
}

/** Fills in a slug only when one is absent — never rewrites a live URL. */
function ensureSlug(doc, id) {
  if (doc.slug || !doc.name) return doc.slug;
  return makeSlug(doc.name, id);
}

module.exports = { slugify, makeSlug, ensureSlug };
