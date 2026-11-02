/**
 * Database driver selection.
 *
 *   DB_DRIVER=mongo    (default) Mongoose against MongoDB
 *   DB_DRIVER=dynamo             DynamoDB
 *
 * Both directories export the same seven repositories with the same method
 * signatures, and both return plain objects keyed by `id` with ISO date
 * strings. Services import from here and never learn which one is active,
 * which is what makes the switch a configuration change rather than a
 * deployment.
 *
 * The default stays `mongo` deliberately: a missing or mistyped environment
 * variable should leave the site on the database that currently holds the
 * data, not silently point it at an empty one.
 */
'use strict';

const driver = (process.env.DB_DRIVER || 'mongo').toLowerCase();

if (!['mongo', 'dynamo'].includes(driver)) {
  throw new Error(`DB_DRIVER must be "mongo" or "dynamo", received "${driver}"`);
}

const repos = driver === 'dynamo' ? require('./dynamo') : require('./mongo');

module.exports = { ...repos, driver };
