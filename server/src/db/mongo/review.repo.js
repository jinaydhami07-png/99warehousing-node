'use strict';
const Review = require('../../models/review.model');
const { toPlain, toPlainList } = require('./shared');

module.exports = {
  get: async (propertyId, authorId) =>
    toPlain(await Review.findOne({ property: propertyId, author: authorId }).lean()),
  getById: async (id) => toPlain(await Review.findById(id).lean()),

  async upsert(doc) {
    const existing = await Review.findOne({ property: doc.property, author: doc.author });
    if (existing) {
      return toPlain(await Review.findByIdAndUpdate(existing._id, { $set: doc }, { new: true }).lean());
    }
    return toPlain(await Review.create(doc));
  },

  listForProperty: async (propertyId, { status } = {}) =>
    toPlainList(await Review.find({ property: propertyId, ...(status ? { status } : {}) }).lean()),

  /* Paged variants return `total` as the count of MATCHING rows, not the
     page length, so a pager can tell a last page from a full one. */
  async pageForProperty(propertyId, { status, skip = 0, limit = 0 } = {}) {
    const filter = { property: propertyId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Review.countDocuments(filter),
    ]);
    return { items: toPlainList(items), total };
  },

  listByStatus: async (status, { limit } = {}) =>
    toPlainList(await Review.find({ status }).sort({ createdAt: -1 }).limit(limit || 0).lean()),

  async pageByStatus(status, { skip = 0, limit = 0 } = {}) {
    const [items, total] = await Promise.all([
      Review.find({ status }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Review.countDocuments({ status }),
    ]);
    return { items: toPlainList(items), total };
  },

  /* A rejection reason belongs only to a rejected review. Carrying a stale
     one onto an approval would show the author why it was turned down right
     next to the news that it was published. */
  moderate: async (id, status, rejectionReason) => {
    const update = status === 'rejected'
      ? { $set: { status, rejectionReason } }
      : { $set: { status }, $unset: { rejectionReason: 1 } };
    return toPlain(await Review.findByIdAndUpdate(id, update, { new: true }).lean());
  },
  removeById: async (id) => Boolean(await Review.findByIdAndDelete(id)),

  async ratingFor(propertyId) {
    const rows = await Review.find({ property: propertyId, status: 'published' }).lean();
    if (!rows.length) return { average: null, count: 0 };
    const sum = rows.reduce((a, r) => a + Number(r.rating || 0), 0);
    return { average: Math.round((sum / rows.length) * 10) / 10, count: rows.length };
  },
};
