'use strict';
const Enquiry = require('../../models/enquiry.model');
const { toPlain, toPlainList } = require('./shared');

module.exports = {
  getById: async (id) => toPlain(await Enquiry.findById(id).lean()),
  create: async (doc) => toPlain(await Enquiry.create(doc)),
  update: async (id, changes) =>
    toPlain(await Enquiry.findByIdAndUpdate(id, { $set: changes }, { new: true }).lean()),
  listForUser: async (userId) =>
    toPlainList(await Enquiry.find({ user: userId }).sort({ createdAt: -1 }).lean()),
  listForProperty: async (propertyId) =>
    toPlainList(await Enquiry.find({ property: propertyId }).sort({ createdAt: -1 }).lean()),
  /* The admin inbox filters by status and searches the contact fields, and
     it pages. `total` is the count of rows MATCHING the filter, not the page
     length — a pager built on the page length cannot tell a last page from a
     full one. */
  async listAll({ status, q, skip = 0, limit = 0 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { company: rx }, { subject: rx }];
    }
    const [items, total] = await Promise.all([
      Enquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Enquiry.countDocuments(filter),
    ]);
    return { items: toPlainList(items), total };
  },
  count: () => Enquiry.countDocuments(),
};
