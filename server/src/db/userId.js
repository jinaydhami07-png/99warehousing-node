/**
 * The signed-in user's id, whichever driver produced them.
 *
 * `req.user` comes from the repositories, and db/mongo/shared.js's toPlain()
 * deliberately deletes `_id` and replaces it with a string `id` so Mongo and
 * DynamoDB hand the services the same shape. Code written before that
 * refactor still reached for `req.user._id`, which is now undefined — and
 * undefined fails quietly in every direction:
 *
 *   find({ owner: undefined })        matches nothing, so "my listings",
 *                                     favourites and enquiries all came back
 *                                     empty with a cheerful 200
 *   String(undefined) === 'undefined' never equals a real id, so ownership
 *                                     checks deny the actual owner
 *   `u:${undefined}`                  collapses every signed-in user onto one
 *                                     rate-limit bucket
 *
 * property.service.js had already grown a private idOf() for this. This is
 * that helper, in one place, so the next caller does not have to rediscover
 * the problem.
 */
'use strict';

const userId = (user) => String(user?.id || user?._id || '');

module.exports = { userId };
