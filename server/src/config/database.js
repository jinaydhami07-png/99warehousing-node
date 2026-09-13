/**
 * MongoDB connection management.
 *
 * Responsibilities:
 *   • Connect asynchronously, with an explicit timeout instead of hanging
 *   • Configure the connection pool (Mongoose reuses one pool per process —
 *     do NOT open a connection per request)
 *   • Surface connection lifecycle events so outages are visible in logs
 *   • Expose a clean shutdown path so in-flight queries finish on SIGTERM
 *
 * The connection string comes exclusively from validated config — there is
 * no credential anywhere in this file.
 */
'use strict';

const dns = require('dns');
const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

/**
 * `mongodb+srv://` URIs require a DNS SRV lookup before any connection can
 * even begin. On some Windows networks (certain ISP/router DNS servers —
 * common in India), Node's own resolver has been observed to refuse that
 * specific query type with ECONNREFUSED, even though the OS resolver
 * handles it fine (nslookup / Resolve-DnsName succeed). It is a resolver
 * quirk, not a bad connection string or bad credentials.
 *
 * Public resolvers (Google, Cloudflare) do not exhibit this problem, so on
 * SRV failure we retry once against them. This changes DNS only for this
 * Node process, not the OS.
 */
const FALLBACK_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

const isSrvUri = (uri) => uri.startsWith('mongodb+srv://');

const isSrvLookupFailure = (err) =>
  /querySrv|ECONNREFUSED|ENOTFOUND|EREFUSED|ETIMEOUT/i.test(err?.message || '') ||
  err?.code === 'ECONNREFUSED';

/* Reject queries against fields absent from the schema rather than silently
   ignoring them — a filter typo becomes a loud error, not a full scan. */
mongoose.set('strictQuery', true);

/* Index building is convenient in development but a foot-gun in production,
   where it can block a collection. Build them in a migration instead. */
mongoose.set('autoIndex', !env.isProd);

let isConnected = false;

const CONNECT_OPTIONS = {
  /* Pooling: the driver multiplexes all queries over these sockets. */
  maxPoolSize: env.mongo.maxPoolSize,
  minPoolSize: env.mongo.minPoolSize,
  maxIdleTimeMS: 30_000,
  waitQueueTimeoutMS: 10_000,

  /* Fail fast with a clear error instead of hanging a request forever. */
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  connectTimeoutMS: 10_000,

  /* Only acknowledge a write once a majority of nodes have it. Prevents
     silent data loss during a replica-set failover. */
  retryWrites: true,
  w: 'majority',

  family: 4, // skip IPv6 lookup; avoids slow DNS on some hosts
};

function bindConnectionEvents() {
  const conn = mongoose.connection;

  conn.on('connected', () => {
    isConnected = true;
    logger.info({ db: conn.name, host: conn.host }, 'MongoDB connected');
  });

  conn.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected — driver will retry automatically');
  });

  conn.on('reconnected', () => {
    isConnected = true;
    logger.info('MongoDB reconnected');
  });

  /* Runtime errors after the initial handshake. The driver keeps retrying,
     so log loudly but never exit here — that would turn a blip into an outage. */
  conn.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });
}

/**
 * Establishes the initial connection. Awaited during boot so the server
 * never starts accepting traffic it cannot serve.
 */
async function connect() {
  if (isConnected) return mongoose.connection;

  bindConnectionEvents();

  try {
    await mongoose.connect(env.mongo.uri, CONNECT_OPTIONS);
    return mongoose.connection;
  } catch (err) {
    // Targeted fallback: only for +srv URIs, and only when the failure looks
    // like a DNS problem rather than bad auth or an unreachable cluster —
    // switching resolvers cannot fix wrong credentials, so we do not mask
    // those errors by retrying them too.
    if (isSrvUri(env.mongo.uri) && isSrvLookupFailure(err)) {
      logger.warn(
        { err: err.message },
        'SRV lookup failed via the system DNS resolver — retrying via 8.8.8.8 / 1.1.1.1'
      );
      dns.setServers(FALLBACK_DNS_SERVERS);

      try {
        await mongoose.connect(env.mongo.uri, CONNECT_OPTIONS);
        logger.info('Connected after falling back to public DNS resolvers');
        return mongoose.connection;
      } catch (retryErr) {
        logger.fatal({ err: retryErr.message }, 'MongoDB connection failed even via fallback DNS');
        logger.fatal(
          'This points to bad credentials, an unreachable cluster, or an IP not allowed under Atlas Network Access — not DNS.'
        );
        throw retryErr;
      }
    }

    logger.fatal({ err: err.message }, 'Initial MongoDB connection failed');
    logger.fatal(
      'Check MONGODB_URI in server/.env. On Atlas, confirm this IP is allowed under Network Access.'
    );
    throw err;
  }
}

/** Closes the pool. Called on SIGTERM/SIGINT so shutdown is graceful. */
async function disconnect() {
  if (!isConnected) return;
  await mongoose.connection.close(false); // false = wait for in-flight ops
  isConnected = false;
  logger.info('MongoDB connection closed');
}

/** Used by the health endpoint. 1 === connected in the Mongoose readyState enum. */
function health() {
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  return {
    status: states[mongoose.connection.readyState] || 'unknown',
    ready: mongoose.connection.readyState === 1,
  };
}

module.exports = { connect, disconnect, health, mongoose };
