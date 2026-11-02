/**
 * The DynamoDB data layer.
 *
 * Services import from here rather than reaching for a client directly, so the
 * set of queries the application can make stays visible in one place — and so
 * the next storage change touches this directory and nothing else.
 */
'use strict';

const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { base } = require('./client');
const { TABLES } = require('./tables');

/**
 * Is the store actually reachable?
 *
 * DescribeTable rather than a read: it costs nothing, and it proves the
 * three things that can be wrong here at once — network, credentials, and
 * whether the table exists in the region we are pointed at.
 */
async function health() {
  try {
    await base.send(new DescribeTableCommand({ TableName: TABLES.users.name }));
    return { status: 'connected', ready: true };
  } catch (err) {
    return { status: 'disconnected', ready: false, detail: err.name };
  }
}

module.exports = {
  health,
  users: require('./user.repo'),
  properties: require('./property.repo'),
  favorites: require('./favorite.repo'),
  enquiries: require('./enquiry.repo'),
  reviews: require('./review.repo'),
  auditlogs: require('./auditlog.repo'),
  images: require('./image.repo'),
  tables: require('./tables').TABLES,
  client: require('./client'),
};
