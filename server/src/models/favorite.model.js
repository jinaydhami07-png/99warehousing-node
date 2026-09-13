/**
 * Favourite — a saved listing, one document per (user, property) pair.
 *
 * Kept as its own collection rather than an array on the User document
 * because a keen buyer's list is unbounded: Mongo's 16 MB document limit and
 * the cost of rewriting a growing array on every toggle both argue against
 * embedding. A separate collection also makes "who saved this listing?"
 * answerable, which an embedded array cannot do without a full scan.
 */
'use strict';

const mongoose = require('mongoose');

const favoriteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
    },
  },
  {
    // createdAt doubles as "favouritedAt"; a favourite is never edited.
    timestamps: { createdAt: true, updatedAt: false },
  }
);

/* Unique so a double-tap on the heart (or a retried request) cannot create a
   second row. The service relies on this: it upserts and treats the duplicate
   as success rather than checking-then-inserting, which would race. */
favoriteSchema.index({ user: 1, property: 1 }, { unique: true });

/* The list query is always "this user's favourites, newest first". */
favoriteSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Favorite', favoriteSchema);
