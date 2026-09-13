/**
 * Review model — a rating and comment left by a signed-in user against one
 * property.
 *
 * The detail page previously carried two reviews written into the HTML,
 * attributed by name and job title to staff at named logistics companies.
 * They appeared on every property, said the same thing about all of them,
 * and named businesses that never wrote them. Reviews are now rows, or they
 * are not shown.
 */
'use strict';

const mongoose = require('mongoose');

const STATUSES = ['pending', 'published', 'rejected'];

const reviewSchema = new mongoose.Schema(
  {
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /* Denormalised at write time. A review outlives the reviewer's profile
       edits, and re-populating the author on every read of a public feed is
       a join this page does not need. */
    authorName: { type: String, trim: true, required: true },
    authorRole: { type: String, trim: true, maxlength: 120 },

    rating: {
      type: Number,
      required: [true, 'A rating is required'],
      min: [1, 'Rating must be between 1 and 5'],
      max: [5, 'Rating must be between 1 and 5'],
    },
    comment: {
      type: String,
      trim: true,
      required: [true, 'Please write a few words'],
      minlength: [10, 'Please write at least 10 characters'],
      maxlength: [1500, 'Reviews are limited to 1500 characters'],
    },

    /* Same moderation path as a listing: nothing a stranger typed appears on
       a public page until an admin has looked at it. */
    status: { type: String, enum: STATUSES, default: 'pending' },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        /* The reviewer's account id has no use in the browser and would tie
           a public opinion to a real user record. */
        delete ret.author;
        return ret;
      },
    },
  }
);

/* One review per person per property. Editing yours replaces it rather than
   stacking a second opinion under the same name. */
reviewSchema.index({ property: 1, author: 1 }, { unique: true });
reviewSchema.index({ property: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
module.exports.STATUSES = STATUSES;
