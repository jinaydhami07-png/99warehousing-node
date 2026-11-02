'use strict';
const Image = require('../../models/image.model');
const { toPlain, toPlainList } = require('./shared');

module.exports = {
  getById: async (id) => toPlain(await Image.findById(id).lean()),
  create: async (doc) => toPlain(await Image.create(doc)),
  listForProperty: async (propertyId) =>
    toPlainList(await Image.find({ property: propertyId }).sort({ createdAt: -1 }).lean()),
  update: async (id, changes) =>
    toPlain(await Image.findByIdAndUpdate(id, { $set: changes }, { new: true }).lean()),
  remove: async (id) => { await Image.findByIdAndDelete(id); },
  removeMany: async (ids) => (await Image.deleteMany({ _id: { $in: ids } })).deletedCount,
};
