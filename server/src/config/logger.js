/**
 * Structured logging.
 *
 * JSON in production so log aggregators (CloudWatch, Datadog, Loki) can index
 * fields; pretty-printed in development for humans. Secrets are redacted at
 * the logger level so a careless `logger.info(req.body)` cannot leak a
 * password into permanent storage.
 */
'use strict';

const pino = require('pino');
const env = require('./env');

const logger = pino({
  level: env.logLevel,

  // Redaction is defence-in-depth: it applies no matter who calls the logger.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'passwordConfirm',
      '*.passwordConfirm',
      'token',
      '*.token',
      'accessToken',
      'refreshToken',
      '*.refreshToken',
      'passkey',
      '*.passkey',
      'MONGODB_URI',
    ],
    censor: '[redacted]',
  },

  transport: env.isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

module.exports = logger;
