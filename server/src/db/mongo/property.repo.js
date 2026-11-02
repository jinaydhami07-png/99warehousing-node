'use strict';
const Property = require('../../models/property.model');
const { toPlain, toPlainList } = require('./shared');
const { ensureSlug } = require('../slug');
const mongoose = require('mongoose');

const SORTS = {
  'rate-asc': { rate: 1 }, 'rate-desc': { rate: -1 },
  'area-asc': { area: 1 }, 'area-desc': { area: -1 },
  newest: { createdAt: -1 }, oldest: { createdAt: 1 },
};

/** Same filter inputs the DynamoDB repo accepts, expressed as a Mongo query. */
function toQuery(f = {}) {
  const q = {};
  if (f.type) q.type = f.type;
  if (f.grade) q.grade = f.grade;
  if (f.city) q.city = new RegExp(`^${String(f.city).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (f.minRate != null || f.maxRate != null) {
    q.rate = {};
    if (f.minRate != null) q.rate.$gte = Number(f.minRate);
    if (f.maxRate != null) q.rate.$lte = Number(f.maxRate);
  }
  if (f.minArea != null || f.maxArea != null) {
    q.area = {};
    if (f.minArea != null) q.area.$gte = Number(f.minArea);
    if (f.maxArea != null) q.area.$lte = Number(f.maxArea);
  }
  /* Substring rather than $text, so both drivers answer a search the same
     way. $text would match on stemmed whole words only, and the two drivers
     returning different result sets for one query is worse than either
     behaviour on its own. */
  if (f.q) {
    const rx = new RegExp(String(f.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: rx }, { description: rx }, { city: rx }, { locality: rx }];
  }
  return q;
}

module.exports = {
  getById: async (id) => toPlain(await Property.findById(id).lean()),
  /* The id is minted here rather than left to Mongoose so the slug can be
     derived from it — the model's hook would otherwise invent a separate
     random suffix, and the two drivers would disagree on the shape of a URL. */
  create: async (doc) => {
    const id = doc.id || doc._id || new mongoose.Types.ObjectId();
    return toPlain(await Property.create({ ...doc, _id: id, slug: ensureSlug(doc, id) }));
  },
  /* `remove` clears fields outright. Setting them to undefined does not:
     Mongoose drops undefined keys from $set, so a rejection reason would
     stay attached to a listing that is no longer rejected. */
  update: async (id, changes, { remove = [] } = {}) => {
    const update = { $set: changes };
    if (remove.length) update.$unset = Object.fromEntries(remove.map((f) => [f, 1]));
    return toPlain(await Property.findByIdAndUpdate(id, update, { new: true }).lean());
  },
  remove: async (id) => { await Property.findByIdAndDelete(id); },
  increment: async (id, field, by = 1) =>
    toPlain(await Property.findByIdAndUpdate(id, { $inc: { [field]: by } }, { new: true }).lean()),

  async listByStatus(status, { filters = {}, sort = 'newest', skip = 0, limit = 24 } = {}) {
    const q = { ...toQuery(filters), status };
    const [items, total] = await Promise.all([
      Property.find(q).sort(SORTS[sort] || SORTS.newest).skip(skip).limit(limit).lean(),
      Property.countDocuments(q),
    ]);
    return { items: toPlainList(items), total };
  },

  async listAll({ filters = {}, sort = 'newest', skip = 0, limit = 24, status } = {}) {
    const q = { ...toQuery(filters), ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      Property.find(q).sort(SORTS[sort] || SORTS.newest).skip(skip).limit(limit).lean(),
      Property.countDocuments(q),
    ]);
    return { items: toPlainList(items), total };
  },

  listByOwner: async (ownerId, { limit } = {}) =>
    toPlainList(await Property.find({ owner: ownerId }).sort({ createdAt: -1 }).limit(limit || 0).lean()),
  countByStatus: (status) => Property.countDocuments({ status }),

  async stats() {
    const statuses = ['approved', 'pending', 'rejected', 'draft'];
    const counts = await Promise.all(statuses.map((s) => Property.countDocuments({ status: s })));
    const out = Object.fromEntries(statuses.map((s, i) => [s, counts[i]]));
    out.total = counts.reduce((a, b) => a + b, 0);
    return out;
  },
};
