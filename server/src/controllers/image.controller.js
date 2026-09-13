/**
 * Image controller — HTTP layer only.
 */
'use strict';

const catchAsync = require('../utils/catchAsync');
const { success, created } = require('../utils/ApiResponse');
const imageService = require('../services/image.service');

/**
 * POST /api/v1/upload — multipart, field name "files"
 *
 * `kind=floorplan` puts the file under the floor-plan prefix and allows a
 * larger full-size rendition, because a floor plan is opened and read
 * rather than glanced at in a card.
 */
const upload = catchAsync(async (req, res) => {
  const kind = req.query.kind === 'floorplan' || req.body?.kind === 'floorplan' ? 'floorplan' : 'photo';
  const files = await imageService.saveMany(req.files, req.user, kind);
  created(res, { message: 'Upload complete', data: { files } });
});

/**
 * GET /api/v1/images/:id[?w=320] — streams a stored image.
 *
 * Public: these are photos on public listings, and requiring a token would
 * break plain <img src> tags, which cannot send an Authorization header.
 *
 * `?w=` asks for a size, and the service answers with the smallest rendition
 * that still covers it. That is what lets this one route serve a whole
 * `srcset` while S3 is switched off: a card asking for 320 gets a 320px
 * file, not the full-size one scaled down after the fact in the browser.
 *
 * Without `?w=` it means what it has always meant — the full-size image — so
 * every URL saved on a listing before any of this existed still resolves to
 * the same picture.
 *
 * An S3-backed image redirects to the CDN instead. Those listings store the
 * object URL directly, so nothing routes through here in normal use; this
 * only catches links copied or bookmarked from an older page.
 */
const serve = catchAsync(async (req, res) => {
  const resolved = await imageService.resolve(req.params.id, req.query.w);

  if (resolved.redirect) {
    /* 301, not 302: the mapping from id to object is permanent, so the
       browser can stop asking. Cached for a day rather than a year — long
       enough to cost nothing, short enough that a bucket or CDN change is
       not baked into visitors' browsers forever. */
    res.set('Cache-Control', 'public, max-age=86400');
    return res.redirect(301, resolved.redirect);
  }

  /* Content is immutable — a rendition is never rewritten, only replaced by
     a new upload under a new id. So it can be cached hard, and a matching
     ETag can be answered with 304 and no body at all. The ETag includes the
     width: without it every size of one image would share a tag and the
     browser would answer a request for the 320px file from its cached
     1920px one. */
  if (req.headers['if-none-match'] === resolved.etag) return res.status(304).end();

  res.set({
    'Content-Type': resolved.contentType,
    'Content-Length': resolved.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: resolved.etag,
    /* Belt and braces alongside the magic-byte sniffing on the way in:
       stop a browser content-sniffing this into something executable. */
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  res.send(resolved.body);
});

/** DELETE /api/v1/images/:id */
const remove = catchAsync(async (req, res) => {
  const data = await imageService.remove(req.params.id, req.user);
  success(res, { message: 'Image deleted', data });
});

module.exports = { upload, serve, remove };
