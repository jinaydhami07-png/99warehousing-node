/**
 * Image routes.
 *
 * Two mounts, because the halves have opposite access rules:
 *   /api/v1/upload     write — authenticated, rate-limited
 *   /api/v1/images/:id read  — public, heavily cached
 */
'use strict';

const express = require('express');
const multer = require('multer');
const controller = require('../controllers/image.controller');
const validate = require('../middleware/validate.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { writeLimiter } = require('../middleware/security');
const { byId } = require('../validators/property.validator');
const { ALLOWED_MIME, MAX_BYTES } = require('../models/image.model');
const ApiError = require('../utils/ApiError');

const MAX_FILES = 12; // matches the images[] cap in the property validator

/* Memory storage, not disk: the bytes go straight into MongoDB, so writing
   them to a temp file first would only add I/O and litter the filesystem
   with orphans whenever a request failed midway.

   This does mean a request holds up to MAX_FILES × MAX_BYTES in RAM, which
   is the reason both limits below are enforced by multer itself rather than
   after the fact — multer aborts the stream as soon as a limit is exceeded,
   so an oversized upload is never fully buffered. */
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: MAX_FILES,
    fields: 10,
    parts: MAX_FILES + 10,
  },
  /* A cheap first gate. The authoritative check is the magic-byte sniff in
     image.service.js — this only avoids buffering something obviously wrong. */
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(ApiError.unprocessable(`${file.mimetype} is not a supported image type`));
    }
    cb(null, true);
  },
}).array('files', MAX_FILES);

/* multer reports its own failures (file too large, too many files) as
   MulterError, which would otherwise surface as an opaque 500. Translate
   them into the same envelope every other error uses. */
const handleUpload = (req, res, next) =>
  uploadMiddleware(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: `Each image must be ${Math.round(MAX_BYTES / 1024 / 1024)} MB or smaller`,
        LIMIT_FILE_COUNT: `You can upload at most ${MAX_FILES} images at once`,
        LIMIT_UNEXPECTED_FILE: 'Unexpected file field — use the field name "files"',
      };
      return next(ApiError.unprocessable(messages[err.code] || 'Upload failed'));
    }
    return next(err);
  });

const uploadRouter = express.Router();
uploadRouter.post('/', authenticate, writeLimiter, handleUpload, controller.upload);

const imageRouter = express.Router();
imageRouter.get('/:id', validate(byId), controller.serve);
imageRouter.delete('/:id', authenticate, validate(byId), controller.remove);

module.exports = { uploadRouter, imageRouter };
