'use strict';
const Favorite = require('../../models/favorite.model');
const { toPlainList } = require('./shared');

module.exports = {
  add: async (userId, propertyId) => {
    await Favorite.updateOne(
      { user: userId, property: propertyId },
      { $setOnInsert: { user: userId, property: propertyId, createdAt: new Date() } },
      { upsert: true },
    );
    return { user: String(userId), property: String(propertyId) };
  },
  remove: async (userId, propertyId) => { await Favorite.deleteOne({ user: userId, property: propertyId }); },
  listForUser: async (userId) =>
    toPlainList(await Favorite.find({ user: userId }).sort({ createdAt: -1 }).lean()),
  has: async (userId, propertyId) =>
    Boolean(await Favorite.exists({ user: userId, property: propertyId })),
};
