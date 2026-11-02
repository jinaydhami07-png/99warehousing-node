/**
 * Image helpers, as plain functions over a plain row.
 *
 * These were Mongoose instance methods on the image model, which only exist
 * on a hydrated document. The repository layer returns plain objects, so
 * they move here — same logic, same comments, no `this`.
 */
'use strict';

/**
 * What a property document stores about one of its photos.
 *
 * Kept in one place because three different callers embed it, and copying
 * the shape into three files is how the two halves of a record drift apart.
 */
function toDescriptor(row) {
  return {
    url: row.url || `/api/v1/images/${row.id}`,
    publicId: String(row.id),
    variants: (row.variants || []).map((v) => ({ w: v.w, h: v.h, url: v.url })),
    blur: row.blur || undefined,
    width: row.width,
    height: row.height,
    contentType: row.contentType,
    size: row.size,
    originalName: row.originalName,
  };
}

/**
 * Where the bytes really are.
 *
 * Derived from `url` rather than trusted from `storage` alone: an object in
 * the bucket always has one and a database-stored image never does, so this
 * gives the right answer for the rows written before `storage` existed as
 * well as the ones written since.
 */
const isStored = (row, where) => (row.url ? 's3' : 'mongo') === where;

/** Every S3 key belonging to this image — the full size and every variant. */
const allKeys = (row) => [row.key, ...(row.variants || []).map((v) => v.key)].filter(Boolean);

module.exports = { toDescriptor, isStored, allKeys };
