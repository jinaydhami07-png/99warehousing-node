'use strict';

/* The connection-level check already lives in config/database.js; the
   driver just exposes it under the same name the other driver uses, so the
   health route never has to know which one is active. */
const health = () => require('../../config/database').health();

module.exports = {
  health,
  users: require('./user.repo'),
  properties: require('./property.repo'),
  favorites: require('./favorite.repo'),
  enquiries: require('./enquiry.repo'),
  reviews: require('./review.repo'),
  auditlogs: require('./auditlog.repo'),
  images: require('./image.repo'),
};
