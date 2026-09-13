/**
 * Enquiry — a message from a visitor, either about a specific listing or a
 * general contact-form submission.
 *
 * Deliberately stores the contact details typed into the form rather than
 * only linking to a User: most enquiries come from signed-out visitors, and
 * even a signed-in user may want a reply on a different address.
 */
'use strict';

const mongoose = require('mongoose');

const ENQUIRY_STATUSES = ['new', 'contacted', 'closed'];

const enquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 120 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    mobile: { type: String, trim: true, maxlength: 20 },
    company: { type: String, trim: true, maxlength: 160 },

    subject: { type: String, trim: true, maxlength: 160, default: 'General enquiry' },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
      maxlength: 4000,
    },

    /* Set when the enquiry came from a listing page; absent for the general
       contact form. */
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    propertyName: { type: String, trim: true },

    /* Set only if the sender happened to be signed in — never required. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    status: { type: String, enum: ENQUIRY_STATUSES, default: 'new' },
    adminNote: { type: String, trim: true, maxlength: 2000 },

    /* Captured for abuse triage, not shown in the UI. */
    ip: { type: String, select: false },
    userAgent: { type: String, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/* The admin inbox: unhandled enquiries first, newest first within that. */
enquirySchema.index({ status: 1, createdAt: -1 });

/* "My enquiries" for a signed-in user. Partial, because most enquiries have
   no user at all and indexing those nulls would waste space. */
enquirySchema.index(
  { user: 1, createdAt: -1 },
  { partialFilterExpression: { user: { $exists: true } } }
);

/* All enquiries against one listing, for the owner/admin view. */
enquirySchema.index({ property: 1, createdAt: -1 });

module.exports = mongoose.model('Enquiry', enquirySchema);
module.exports.ENQUIRY_STATUSES = ENQUIRY_STATUSES;
