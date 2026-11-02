/**
 * Shared helpers for the MongoDB repositories.
 *
 * These exist so both drivers hand the services the SAME shape. Mongo returns
 * documents keyed by `_id`; DynamoDB rows carry `id`. If that difference
 * reached the services, every caller would have to know which driver is
 * active, which defeats the point of having a driver switch at all.
 */
'use strict';

/** Mongo document → plain object with `id`, matching the DynamoDB shape. */
function toPlain(doc) {
  if (!doc) return null;
  const o = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };

  /* Two shapes arrive here. A lean query gives a raw document keyed by _id.
     A Mongoose document gives whatever its toJSON transform produced — and
     several models already do `ret.id = ret._id`, which assigns the ObjectId
     itself, not a string. Normalising only _id left those with an ObjectId
     `id`, which compares unequal to the string every other path returns.
     Both are coerced here so `id` is always a plain string. */
  if (o._id !== undefined) { o.id = o._id; delete o._id; }
  if (o.id !== undefined && o.id !== null) o.id = String(o.id);
  delete o.__v;

  /* Nested ObjectId references (owner, property, author, user) for the same
     reason: DynamoDB stores them as strings, so Mongo must hand back strings
     too or a caller comparing ids gets different answers per driver. */
  for (const k of ['owner', 'property', 'author', 'user', 'uploadedBy', 'actor']) {
    if (o[k] && typeof o[k] === 'object' && o[k]._bsontype === 'ObjectId') o[k] = String(o[k]);
    else if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'object') o[k] = String(o[k]);
  }
  /* Dates → ISO strings, again to match DynamoDB, where there is no date
     type and createdAt is a lexicographically sortable string. */
  for (const [k, v] of Object.entries(o)) if (v instanceof Date) o[k] = v.toISOString();
  return o;
}

const toPlainList = (docs) => (docs || []).map(toPlain);

module.exports = { toPlain, toPlainList };
