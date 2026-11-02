/**
 * Contract test: identical assertions, run against whichever driver
 * DB_DRIVER selects. If both pass, the drivers are interchangeable and the
 * services can be switched with a configuration change.
 *
 * It starts its own database — mongodb-memory-server or dynalite, on a port
 * the OS picks — so it runs on a clean checkout with nothing set up first.
 * Both start empty, which is why there is no pre-run cleanup: a contract test
 * that inherits the last run's rows measures the leftovers.
 */
const path = require('path');
const SRV = path.join(__dirname, '..');
const driver = process.env.DB_DRIVER || 'mongo';

/* config/env refuses to load a DynamoDB deployment that would store image
   bytes in the database, because an item is capped at 400KB. This is a data
   layer test, not a deployment — it never uploads anything — so it satisfies
   the check and moves on. The bucket is never contacted. */
if (driver === 'dynamo') {
  process.env.MEDIA_DRIVER = 's3';
  process.env.AWS_S3_BUCKET = 'contract-test-bucket-never-contacted';
  process.env.AWS_REGION = process.env.AWS_REGION || 'ap-southeast-2';
}

/* Shutdown steps, run in reverse. Without them the ephemeral server keeps
   the event loop alive and the run hangs instead of reporting. */
const stops = [];
async function stopAll() {
  while (stops.length) {
    try { await stops.pop()(); } catch { /* already gone; nothing to salvage */ }
  }
}

async function startMongo() {
  const { MongoMemoryServer } = require(path.join(SRV, 'node_modules/mongodb-memory-server'));
  const mongoose = require(path.join(SRV, 'node_modules/mongoose'));
  const mem = await MongoMemoryServer.create();
  stops.push(() => mem.stop());
  await mongoose.connect(mem.getUri(), { dbName: 'bpsf' });
  stops.push(() => mongoose.disconnect());
}

async function startDynamo() {
  const dynalite = require(path.join(SRV, 'node_modules/dynalite'));
  const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
  await new Promise((resolve, reject) => {
    server.listen(0, (err) => (err ? reject(err) : resolve()));
  });
  stops.push(() => new Promise((resolve) => server.close(resolve)));

  /* Set before src/db is required: the client reads this at require time. */
  process.env.DYNAMO_ENDPOINT = `http://127.0.0.1:${server.address().port}`;

  /* Build the tables with the real job rather than a copy of its table
     definitions, so a drift between the two cannot pass unnoticed.
     Spawned asynchronously on purpose: dynalite answers from this process's
     event loop, so a synchronous child would block the very loop that has to
     serve its requests — a deadlock, not a slow start. */
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(SRV, 'src/jobs/dynamo-create-tables.js')],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`table setup exited ${code}:\n${log}`))));
  });
}

(async () => {
  if (driver === 'mongo') await startMongo();
  if (driver === 'dynamo') await startDynamo();

  const r = require(path.join(SRV, 'src/db'));

  let pass = 0, fail = 0;
  const ok = (c, label, extra = '') => {
    c ? (pass++, console.log('  ✓ ' + label)) : (fail++, console.log('  ✗ ' + label + '   ' + extra));
  };

  // users
  const { comparePassword: compare } = require(path.join(SRV, 'src/db/password'));
  const PLAINTEXT_PASSWORD = 'x'.repeat(12);
  const u = await r.users.create({ name: 'Asha', email: ' Asha@Example.COM ', password: PLAINTEXT_PASSWORD, role: 'owner' });
  ok(u.id && !u._id, 'create returns `id`, never `_id`');
  /* Registration hands the created user straight back in the API response,
     so create() must withhold secrets the way every other read does. */
  ok(u.password === undefined, 'create withholds the password hash');
  ok(u.tokenVersion === undefined, 'create withholds tokenVersion');
  ok(u.email === 'asha@example.com', 'email normalised');
  ok((await r.users.findByEmail('ASHA@example.com'))?.id === u.id, 'findByEmail case-insensitive');
  await r.users.bumpTokenVersion(u.id); await r.users.bumpTokenVersion(u.id);
  ok((await r.users.getById(u.id, { secrets: true })).tokenVersion === 2, 'tokenVersion increments');
  await r.users.recordFailedLogin(u.id, new Date(Date.now() + 9e5).toISOString());
  ok((await r.users.getById(u.id, { secrets: true })).failedLoginAttempts === 1, 'failed login counter');
  await r.users.clearLoginFailures(u.id);
  const c2 = await r.users.getById(u.id, { secrets: true });
  ok(c2.failedLoginAttempts === 0 && !c2.lockedUntil, 'lock cleared');

  // The rule that keeps password hashes out of API responses.
  const safe = await r.users.getById(u.id);
  ok(safe.password === undefined && safe.tokenVersion === undefined, 'hidden fields withheld by default');
  ok((await r.users.getById(u.id, { secrets: true })).password !== undefined, 'hidden fields returned on request');
  ok((await r.users.findByEmail('asha@example.com')).password === undefined, 'findByEmail withholds password');
  ok((await r.users.listAll())[0].password === undefined, 'listAll withholds password');

  /* Withholding the password from responses is not the same as storing it
     safely. One driver hashed on the way in through a Mongoose pre-save
     hook; the other wrote whatever it was handed, so the same call stored a
     plaintext password. Assert on what is actually at rest. */
  const stored = await r.users.getById(u.id, { secrets: true });
  ok(stored.password !== PLAINTEXT_PASSWORD, 'stored password is not the plaintext');
  ok(/^\$2[aby]\$/.test(String(stored.password)), 'stored password is a bcrypt hash');
  ok(await compare(PLAINTEXT_PASSWORD, stored.password), 'stored hash verifies against the plaintext');

  /* The update path is a separate hole: Mongoose's pre-save hook never ran
     for findByIdAndUpdate, so a password *change* wrote plaintext even on
     the driver that hashed on create. */
  const NEW_PASSWORD = 'y'.repeat(14);
  await r.users.update(u.id, { password: NEW_PASSWORD });
  const changed = await r.users.getById(u.id, { secrets: true });
  ok(changed.password !== NEW_PASSWORD, 'changed password is not stored as plaintext');
  ok(await compare(NEW_PASSWORD, changed.password), 'changed password verifies');
  ok(!(await compare(PLAINTEXT_PASSWORD, changed.password)), 'old password no longer verifies');
  ok(Boolean(changed.passwordChangedAt), 'password change is stamped');

  /* Re-hashing an existing hash would lock the account out for good. */
  await r.users.update(u.id, { name: 'Asha Updated' });
  ok(await compare(NEW_PASSWORD, (await r.users.getById(u.id, { secrets: true })).password),
     'an unrelated update does not re-hash the password');

  // properties
  const mk = (n, o) => r.properties.create({ name: n, owner: u.id, ...o });
  await mk('Bhiwandi Grade A Warehouse', { city: 'Mumbai', type: 'Warehouse', grade: 'Grade A', rate: 28, area: 45000, status: 'approved', description: 'Dock levellers' });
  await mk('Chakan Cold Storage', { city: 'Pune', type: 'Cold Storage', grade: 'Cold Chain', rate: 45, area: 18000, status: 'approved' });
  const p3 = await mk('Panvel Logistics Park', { city: 'Mumbai', type: 'Logistics Park', grade: 'Grade A', rate: 34, area: 80000, status: 'approved' });
  await mk('Pending Shed', { city: 'Hosur', type: 'Industrial Shed', grade: 'Grade B', rate: 22, area: 26000, status: 'pending' });

  ok((await r.properties.listByStatus('approved')).total === 3, 'listByStatus counts only approved');
  ok((await r.properties.listByStatus('approved', { filters: { city: 'MUMBAI' } })).total === 2, 'city filter case-insensitive');
  ok((await r.properties.listByStatus('approved', { filters: { type: 'Cold Storage' } })).total === 1, 'type filter');
  ok((await r.properties.listByStatus('approved', { filters: { minRate: 30 } })).total === 2, 'minRate filter');
  ok((await r.properties.listByStatus('approved', { filters: { minArea: 40000, maxArea: 90000 } })).total === 2, 'area range filter');
  ok((await r.properties.listByStatus('approved', { filters: { q: 'dock levellers' } })).total === 1, 'free-text search');
  ok((await r.properties.listByStatus('approved', { filters: { q: 'zzz' } })).total === 0, 'free-text miss');

  const asc = await r.properties.listByStatus('approved', { sort: 'rate-asc' });
  ok(asc.items[0].rate === 28 && asc.items[2].rate === 45, 'sort rate-asc');
  ok((await r.properties.listByStatus('approved', { sort: 'rate-desc' })).items[0].rate === 45, 'sort rate-desc');
  const pg = await r.properties.listByStatus('approved', { limit: 2, skip: 2 });
  ok(pg.items.length === 1 && pg.total === 3, 'pagination keeps total honest');

  await r.properties.increment(p3.id, 'views', 5);
  ok((await r.properties.getById(p3.id)).views === 5, 'views increment');
  ok((await r.properties.listByOwner(u.id)).length === 4, 'listByOwner');
  /* The slug is what a shareable listing URL is built from. It came from a
     Mongoose pre-save hook, so one driver produced listings with none. */
  ok(/^panvel-logistics-park-[0-9a-f]{6}$/.test(String(p3.slug)), 'slug generated on create');
  ok((await r.properties.getById(p3.id)).slug === p3.slug, 'slug persists');
  const st = await r.properties.stats();
  ok(st.approved === 3 && st.pending === 1 && st.total === 4, 'stats', JSON.stringify(st));

  const kept = await r.properties.create({ name: 'Preset Slug Listing', slug: 'chosen-by-hand', city: 'Pune', type: 'Warehouse', grade: 'Grade B', rate: 9, area: 1000, status: 'draft', owner: u.id });
  ok(kept.slug === 'chosen-by-hand', 'an explicit slug is never overwritten');

  // favourites
  await r.favorites.add(u.id, p3.id); await r.favorites.add(u.id, p3.id);
  ok((await r.favorites.listForUser(u.id)).length === 1, 'duplicate favourite prevented');
  ok(await r.favorites.has(u.id, p3.id), 'favourite has()');
  await r.favorites.remove(u.id, p3.id);
  ok((await r.favorites.listForUser(u.id)).length === 0, 'favourite removed');

  // enquiries
  const e = await r.enquiries.create({ user: u.id, property: p3.id, name: 'Buyer', email: 'b@x.com', message: 'Available for a three year lease?' });
  ok((await r.enquiries.listForUser(u.id)).length === 1, 'enquiries for user');
  ok((await r.enquiries.listForProperty(p3.id)).length === 1, 'enquiries for property');
  const inbox = await r.enquiries.listAll();
  ok(inbox.items.length === 1 && inbox.total === 1, 'enquiry admin list');
  ok((await r.enquiries.listAll({ q: 'Buyer' })).total === 1, 'enquiry search by name');
  ok((await r.enquiries.listAll({ q: 'nobody-here' })).total === 0, 'enquiry search miss');
  ok((await r.enquiries.listAll({ status: 'new' })).total === 1, 'enquiry filter by status');
  ok((await r.enquiries.listAll({ status: 'closed' })).total === 0, 'enquiry status miss');
  /* total counts the matches, not the page: a pager built on page length
     cannot tell a last page from a full one. */
  const paged = await r.enquiries.listAll({ limit: 1, skip: 1 });
  ok(paged.items.length === 0 && paged.total === 1, 'enquiry paging keeps total honest');
  await r.enquiries.update(e.id, { status: 'handled' });
  ok((await r.enquiries.getById(e.id)).status === 'handled', 'enquiry update');

  // reviews
  await r.reviews.upsert({ property: p3.id, author: u.id, authorName: 'Asha', rating: 4, comment: 'Good location and clear height.', status: 'published' });
  await r.reviews.upsert({ property: p3.id, author: u.id, authorName: 'Asha', rating: 5, comment: 'Revised after a second visit.', status: 'published' });
  const revs = await r.reviews.listForProperty(p3.id);
  ok(revs.length === 1 && revs[0].rating === 5, 'one review per author, upsert overwrites');
  const rid = revs[0].id;
  ok((await r.reviews.getById(rid))?.id === rid, 'review getById');
  const rating = await r.reviews.ratingFor(p3.id);
  ok(rating.average === 5 && rating.count === 1, 'average rating', JSON.stringify(rating));
  await r.reviews.moderate(rid, 'rejected');
  ok((await r.reviews.getById(rid)).status === 'rejected', 'moderate');
  ok((await r.reviews.pageForProperty(p3.id, { status: 'published' })).total >= 0, 'review paging for property');
  ok((await r.reviews.pageByStatus('published')).total >= 0, 'review paging by status');

  /* A rejection reason belongs only to a rejected review; carrying a stale
     one onto an approval shows the author why it was turned down next to
     the news that it was published. */
  const rej = await r.reviews.moderate(rid, 'rejected', 'Not specific enough');
  ok(rej.rejectionReason === 'Not specific enough', 'rejection reason stored');
  const app = await r.reviews.moderate(rid, 'published');
  ok(!app.rejectionReason, 'rejection reason cleared on approval');
  ok(await r.reviews.removeById(rid), 'review removeById');

  // audit
  await r.auditlogs.record({ action: 'property.approve', entity: 'property', entityId: p3.id, actor: u.id });
  ok((await r.auditlogs.list({ limit: 5 })).length === 1, 'audit record + list');

  /* `entity` records what was acted on. One driver used it as its index
     partition key and overwrote it with a constant, so every entry in the
     admin trail claimed the same subject. Assert the value comes back. */
  const trail = await r.auditlogs.list({ limit: 5 });
  ok(trail[0].entity === 'property', 'audit entity survives the round trip');
  ok(String(trail[0].entityId) === String(p3.id), 'audit entityId survives the round trip');

  await r.auditlogs.record({ action: 'review.reject', entity: 'review', actor: u.id });
  ok((await r.auditlogs.list({ limit: 10, action: 'review.reject' })).length === 1, 'audit filter by action');
  ok((await r.auditlogs.list({ limit: 10, entityId: p3.id })).length === 1, 'audit filter by entityId');

  // images
  const img = await r.images.create({ property: p3.id, url: 's3://b/k.webp', w: 1280, contentType: 'image/webp', uploadedBy: u.id, size: 48123, storage: 's3' });
  ok((await r.images.listForProperty(p3.id)).length === 1, 'image metadata by property');
  await r.images.remove(img.id);
  ok((await r.images.listForProperty(p3.id)).length === 0, 'image delete');

  console.log(`\n  [${driver}] ${pass} passed, ${fail} failed`);
  await stopAll();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('  CRASH:', e.message);
  console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  await stopAll();
  process.exit(1);
});
