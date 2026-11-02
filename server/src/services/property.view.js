/**
 * Presentation of a listing, shared by everything that returns one.
 *
 * These were Mongoose constructs on the property model: `location` was a
 * virtual, and the card projection called `doc.toJSON()`. Both only exist
 * when a Mongoose document is in hand, which stopped being true once the
 * services started reading through the repository layer — the repositories
 * return plain rows, and a `.lean()` query has no virtuals either.
 *
 * So the derivation moves here, where it works on a plain row from either
 * driver. It stays computed rather than stored: a listing that moves city
 * must not keep an old location string on it.
 */
'use strict';

/** "Bhiwandi" + "Mumbai" → "Bhiwandi, Mumbai". Was a Mongoose virtual. */
const locationOf = (row) => [row?.locality, row?.city].filter(Boolean).join(', ');

/**
 * Shapes a stored row into what goes on the wire.
 *
 * `owner` is dropped. It has no use in the browser and appeared on the
 * public feed, where it links a listing to an account and hands an attacker
 * a real user id to aim at other endpoints. Ownership decisions are made
 * server-side from the stored row, which still has it — this strips it on
 * the way out, exactly as the model's toJSON transform used to.
 */
function decorate(row) {
  if (!row) return row;
  const { owner, ...rest } = row;
  return { ...rest, location: locationOf(row) };
}

/**
 * Trims a listing down to what a CARD needs.
 *
 * The feed page pulls the whole approved catalogue in one request and
 * filters it in the browser, so every byte here is multiplied by hundreds of
 * listings. A card draws exactly one photo — the cover — yet the untrimmed
 * row carries all twelve, each with its renditions and its inline
 * placeholder. On a 600-listing catalogue that is several megabytes of JSON
 * describing photos that will never be rendered.
 *
 * So: the cover keeps everything it needs to render well, the rest collapse
 * to a count, and the floor plan (only ever shown on the detail page) drops
 * out entirely. Fetching one listing still returns the whole row, which is
 * what the detail page and both edit forms read — this is a projection for
 * one response, not a change to what is stored.
 */
function toCard(row) {
  const p = decorate(row);
  const images = p.images || [];

  /* The cover is whichever image is flagged primary, falling back to the
     first — the same rule the cards themselves used to apply client-side. */
  const cover = images.find((i) => i && i.isPrimary && i.url) || images.find((i) => i && i.url);

  p.images = cover ? [cover] : [];
  p.imageCount = images.length;
  delete p.floorPlan;
  delete p.distances;

  return p;
}

module.exports = { locationOf, decorate, toCard };
