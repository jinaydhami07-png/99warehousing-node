/** Users: sign-in by email, Google OAuth by subject id, and the staff lookup. */
'use strict';
const { makeRepo } = require('./base.repo');
const { TABLES } = require('./tables');
const { stripSecrets } = require('../sensitive');
const { hashIfPlain, passwordChangedStamp } = require('../password');
const repo = makeRepo(TABLES.users);

/**
 * DynamoDB returns an item whole — it has no equivalent of Mongo's
 * `select: false`. Without stripping here, a password hash and the session
 * counters would travel wherever a user object goes, including API
 * responses. `secrets: true` is what the authentication paths pass.
 */
const view = (row, secrets) => (secrets ? row : stripSecrets(row));

const norm = (e) => String(e || '').toLowerCase().trim();

module.exports = {
  raw: repo,

  getById: async (id, { secrets } = {}) => view(await repo.get(id), secrets),

  /**
   * Sign-in lookup.
   * Email is stored already normalised so the index is matched exactly —
   * DynamoDB has no case-insensitive comparison, and normalising on read
   * would mean scanning the table on every login attempt.
   */
  async findByEmail(email, { secrets } = {}) {
    const rows = await repo.query(norm(email), { index: 'email-index', limit: 1 });
    return view(rows[0] || null, secrets);
  },

  async findByGoogleId(googleId, { secrets } = {}) {
    const rows = await repo.query(String(googleId), { index: 'googleId-index', limit: 1 });
    return view(rows[0] || null, secrets);
  },

  async findFirstAdmin({ secrets } = {}) {
    const rows = await repo.query('admin', { index: 'role-createdAt-index', limit: 1 });
    return view(rows[0] || null, secrets);
  },

  /**
   * The created row is returned WITHOUT secrets, matching the Mongoose
   * toJSON transform on the other driver. Registration hands this object
   * straight back in the API response, so returning the raw item put the
   * freshly made password hash in the body.
   */
  async create(doc, { secrets } = {}) {
    const now = repo.nowIso();
    const created = await repo.put({
      ...doc,
      id: doc.id || repo.newId(),
      email: norm(doc.email),
      /* There is no Mongoose hook on this side. Without this the account is
         created with its password in plaintext. */
      password: await hashIfPlain(doc.password),
      /* Schema defaults. Mongoose applied these; DynamoDB has no schema, so
         without them `isActive` arrives undefined and every sign-in is
         refused with "this account has been deactivated". */
      role: doc.role || 'buyer',
      authProvider: doc.authProvider || 'local',
      isActive: doc.isActive !== undefined ? doc.isActive : true,
      isEmailVerified: doc.isEmailVerified !== undefined ? doc.isEmailVerified : false,
      tokenVersion: doc.tokenVersion || 0,
      failedLoginAttempts: doc.failedLoginAttempts || 0,
      createdAt: doc.createdAt || now,
      updatedAt: now,
    });
    return view(created, secrets);
  },

  async update(id, changes = {}, { remove = [], secrets } = {}) {
    const set = { ...changes, updatedAt: repo.nowIso() };
    if (set.email) set.email = norm(set.email);
    if (set.password) {
      set.password = await hashIfPlain(set.password);
      set.passwordChangedAt = passwordChangedStamp().toISOString();
    }
    return view(await repo.update(id, undefined, { set, remove }), secrets);
  },

  /**
   * Invalidates every issued refresh token for this account by bumping the
   * version the tokens are signed against. ADD is atomic, so two sign-outs
   * racing each other still both take effect.
   */
  bumpTokenVersion: (id) => repo.update(id, undefined, { add: { tokenVersion: 1 } }),   // returns secrets by design

  recordFailedLogin: (id, lockedUntil) =>
    repo.update(id, undefined, { add: { failedLoginAttempts: 1 }, set: { lockedUntil } }),

  clearLoginFailures: (id) =>
    repo.update(id, undefined, { set: { failedLoginAttempts: 0, lastLoginAt: repo.nowIso() }, remove: ['lockedUntil'] }),

  /** Admin user list. A Scan is honest here: there is no partition that means
      "every user", and the table is small. */
  async listAll({ role, limit } = {}) {
    const rows = role
      ? await repo.query(role, { index: 'role-createdAt-index', descending: true, limit })
      : await repo.scan({ limit });
    return rows.map((r) => stripSecrets(r));
  },

  /* Admin list. A Scan is honest here: there is no partition that means
     "every user", DynamoDB has no case-insensitive match, and `total` has
     to reflect the search rather than the page. The table is small. */
  async page({ role, search, skip = 0, limit = 0 } = {}) {
    const rows = role
      ? await repo.query(role, { index: 'role-createdAt-index', descending: true })
      : await repo.scan({});
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const needle = search ? String(search).toLowerCase() : null;
    const matched = needle
      ? rows.filter((u) => [u.name, u.email].some((v) => String(v || '').toLowerCase().includes(needle)))
      : rows;
    const page = limit ? matched.slice(skip, skip + limit) : matched.slice(skip);
    return { items: page.map((r) => stripSecrets(r)), total: matched.length };
  },

  count: () => repo.count(),
};
