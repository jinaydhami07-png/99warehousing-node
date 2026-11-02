/**
 * API behaviour snapshot — the safety net for the repository refactor.
 *
 * The contract test proves the two *repositories* behave alike. It says
 * nothing about the services on top of them, and those are what the
 * refactor rewrites. This runs the real Express app against a throwaway
 * database, walks a fixed script of HTTP requests, and prints a normalised
 * record of every answer.
 *
 * Normalised, because the interesting part is the shape and the status, not
 * the ids: a fresh database mints new ones every run and a raw diff would be
 * nothing but noise. Ids become <id:1>, <id:2>… in order of first
 * appearance, which still catches a wrong id — the *same* row has to appear
 * under the same alias in both runs.
 *
 *   node tests/api-behaviour.js            > before.json
 *   DB_DRIVER=dynamo node tests/api-behaviour.js > dynamo.json
 *
 * Then diff them. Identical output means the services do not care which
 * driver is underneath, which is the whole point of the exercise.
 */
'use strict';

const path = require('path');
const http = require('http');

const SRV = path.join(__dirname, '..');
const driver = process.env.DB_DRIVER || 'mongo';

/* Set before anything reads config. The app refuses to start in production
   without real values, and these are a throwaway database's throwaway keys. */
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.JWT_ACCESS_SECRET = 'behaviour-harness-access-secret-not-a-real-key-000';
process.env.JWT_REFRESH_SECRET = 'behaviour-harness-refresh-secret-not-a-real-key-11';
process.env.ADMIN_PASSKEY = 'behaviour-harness-passkey';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder-replaced-below';

/* The DynamoDB driver refuses to start unless images go to object storage,
   because an item is capped at 400KB. Nothing here uploads a file, so the
   bucket is never contacted — it only has to satisfy the startup check. */
if (driver === 'dynamo') {
  process.env.MEDIA_DRIVER = 's3';
  process.env.AWS_S3_BUCKET = 'harness-bucket-never-contacted';
  process.env.AWS_REGION = process.env.AWS_REGION || 'ap-southeast-2';
}

const stops = [];
async function stopAll() {
  while (stops.length) {
    try { await stops.pop()(); } catch { /* already gone */ }
  }
}

async function startMongo() {
  const { MongoMemoryServer } = require(path.join(SRV, 'node_modules/mongodb-memory-server'));
  const mongoose = require(path.join(SRV, 'node_modules/mongoose'));
  const mem = await MongoMemoryServer.create();
  stops.push(() => mem.stop());
  process.env.MONGODB_URI = mem.getUri();
  await mongoose.connect(mem.getUri(), { dbName: 'bpsf' });
  stops.push(() => mongoose.disconnect());
}

async function startDynamo() {
  const dynalite = require(path.join(SRV, 'node_modules/dynalite'));
  const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
  await new Promise((resolve, reject) => server.listen(0, (e) => (e ? reject(e) : resolve())));
  stops.push(() => new Promise((r) => server.close(r)));
  process.env.DYNAMO_ENDPOINT = `http://127.0.0.1:${server.address().port}`;

  /* Spawned asynchronously on purpose: dynalite answers from this process's
     event loop, so a synchronous child would block the very loop that has to
     serve its requests — a deadlock, not a slow start. */
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(
      process.execPath,
      [path.join(SRV, 'src/jobs/dynamo-create-tables.js')],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
  });
}

/* ── Normalisation ─────────────────────────────────────────────────────── */

const ID_RE = /^[0-9a-f]{24}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

const ids = new Map();
function alias(id) {
  if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
  return ids.get(id);
}

/* Volatile by nature: they change between two runs of identical code, so
   comparing them would report a difference that means nothing. */
/* `stack` is in the body because the harness runs in development mode,
   where the error handler includes it. It carries absolute paths and line
   numbers, so it changes on any edit anywhere above the throw — comparing it
   reports a difference for every refactor and hides the real ones. */
const VOLATILE = new Set(['uptime', 'memoryMB', 'timestamp', 'requestId', 'expiresIn', 'stack']);

function normalise(v, key) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => normalise(x));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalise(v[k], k);
    return out;
  }
  if (VOLATILE.has(key)) return `<${key}>`;
  if (typeof v === 'string') {
    /* A slug ends in six hex characters taken from a freshly minted id, so
       it differs between two runs of identical code. The readable part still
       has to match. */
    if (key === 'slug') return v.replace(/-[0-9a-f]{6}$/i, '-<suffix>');
    if (JWT_RE.test(v)) return '<jwt>';
    if (UUID_RE.test(v)) return '<uuid>';
    if (ID_RE.test(v)) return alias(v);
    if (ISO_RE.test(v)) return '<date>';
    /* Ids also turn up inside URLs and messages. */
    return v.replace(/[0-9a-f]{24}/gi, (m) => alias(m));
  }
  return v;
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */

let port;
const results = [];

function call(label, method, url, { body, token, cookie } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path: url, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        } },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = { _nonJson: raw.slice(0, 120) }; }
          const setCookie = res.headers['set-cookie'] || [];
          results.push({
            label,
            request: `${method} ${url.replace(/[0-9a-f]{24}/gi, (m) => alias(m))}`,
            status: res.statusCode,
            /* Names only. The values are secrets and rotate every run. */
            cookies: setCookie.map((c) => c.split('=')[0]).sort(),
            body: normalise(parsed),
          });
          resolve({ status: res.statusCode, body: parsed, setCookie });
        });
      },
    );
    req.on('error', (e) => {
      results.push({ label, request: `${method} ${url}`, status: 0, error: e.message });
      resolve({ status: 0, body: null, setCookie: [] });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── Fixture ───────────────────────────────────────────────────────────────
   Built through the repository layer rather than the HTTP API, so the same
   rows exist on either driver without depending on the very service code
   this harness is here to check. Values are fixed, never random: a snapshot
   that changes run to run cannot be diffed. */

async function seed() {
  const db = require(path.join(SRV, 'src/db'));
  const bcrypt = require(path.join(SRV, 'node_modules/bcryptjs'));
  const hash = await bcrypt.hash('Harness!Pass9x', 10);

  const admin = await db.users.create({
    name: 'Harness Admin', email: 'harness-admin@example.invalid',
    password: hash, role: 'admin', mobile: '9000000001',
  });
  const owner = await db.users.create({
    name: 'Harness Owner', email: 'harness-owner@example.invalid',
    password: hash, role: 'owner', mobile: '9000000002',
  });
  const buyer = await db.users.create({
    name: 'Harness Buyer', email: 'harness-buyer@example.invalid',
    password: hash, role: 'buyer', mobile: '9000000003',
  });

  const specs = { clearHeight: 12, loadingDocks: 6, power: 400, features: [] };
  const base = { owner: owner.id, ownerName: owner.name, specs, isVerified: true, views: 0, enquiryCount: 0, images: [] };

  const p1 = await db.properties.create({ ...base,
    name: 'Harness Bhiwandi Warehouse', description: 'Dry storage near the highway.',
    type: 'Warehouse', grade: 'Grade A', city: 'Mumbai', locality: 'Bhiwandi',
    rate: 25, area: 50000, depositMonths: 3, status: 'approved' });
  const p2 = await db.properties.create({ ...base,
    name: 'Harness Chakan Shed', description: 'Industrial shed with power backup.',
    type: 'Industrial Shed', grade: 'Grade B', city: 'Pune', locality: 'Chakan',
    rate: 18, area: 20000, depositMonths: 2, status: 'approved' });
  const p3 = await db.properties.create({ ...base,
    name: 'Harness Pending Listing', description: 'Awaiting moderation.',
    type: 'Warehouse', grade: 'Grade B', city: 'Kolkata', locality: 'Dankuni',
    rate: 15, area: 30000, depositMonths: 1, status: 'pending' });

  await db.reviews.upsert({ property: p1.id, author: buyer.id, authorName: buyer.name,
    rating: 4, comment: 'Clean, well run and easy to access.', status: 'published' });
  await db.enquiries.create({ property: p1.id, user: buyer.id, name: 'Harness Buyer',
    email: 'harness-buyer@example.invalid', mobile: '9000000003', message: 'Is this available?' });

  return { admin, owner, buyer, p1, p2, p3 };
}

/* ── Script ────────────────────────────────────────────────────────────── */

async function run(fx) {
  await call('health', 'GET', '/api/v1/health');
  await call('config', 'GET', '/api/v1/config');

  await call('list all', 'GET', '/api/v1/properties');
  await call('list limit 1', 'GET', '/api/v1/properties?limit=1');
  await call('list page 2', 'GET', '/api/v1/properties?limit=1&page=2');
  await call('filter city', 'GET', '/api/v1/properties?city=Mumbai');
  await call('filter city wrong case', 'GET', '/api/v1/properties?city=mumbai');
  await call('filter type', 'GET', '/api/v1/properties?type=Warehouse');
  await call('filter grade', 'GET', '/api/v1/properties?grade=Grade%20A');
  await call('filter rate range', 'GET', '/api/v1/properties?minRate=16&maxRate=30');
  await call('filter area range', 'GET', '/api/v1/properties?minArea=25000&maxArea=60000');
  await call('sort rate-asc', 'GET', '/api/v1/properties?sort=rate-asc');
  await call('sort rate-desc', 'GET', '/api/v1/properties?sort=rate-desc');
  await call('sort newest', 'GET', '/api/v1/properties?sort=newest');
  await call('search hit', 'GET', '/api/v1/properties?q=Chakan');
  await call('search miss', 'GET', '/api/v1/properties?q=zzzznothing');
  await call('pending hidden from public', 'GET', '/api/v1/properties?city=Kolkata');

  await call('detail', 'GET', `/api/v1/properties/${fx.p1.id}`);
  await call('detail unknown', 'GET', '/api/v1/properties/000000000000000000000000');
  await call('detail malformed', 'GET', '/api/v1/properties/not-an-id');
  await call('reviews', 'GET', `/api/v1/properties/${fx.p1.id}/reviews`);

  await call('me unauthenticated', 'GET', '/api/v1/auth/me');
  await call('favourites unauthenticated', 'GET', '/api/v1/favorites');
  await call('admin unauthenticated', 'GET', '/api/v1/admin/properties');
  await call('create unauthenticated', 'POST', '/api/v1/properties', { body: { name: 'x' } });

  const reg = await call('register', 'POST', '/api/v1/auth/register', {
    body: { name: 'Harness New', email: 'harness-new@example.invalid',
            password: 'Harness!Pass9x', mobile: '9000000004' } });
  const token = reg.body?.data?.accessToken;
  const cookie = (reg.setCookie || []).map((c) => c.split(';')[0]).join('; ');

  await call('register duplicate', 'POST', '/api/v1/auth/register', {
    body: { name: 'Harness New', email: 'harness-new@example.invalid',
            password: 'Harness!Pass9x', mobile: '9000000004' } });
  await call('register bad email', 'POST', '/api/v1/auth/register', {
    body: { name: 'Harness Bad', email: 'nope', password: 'Harness!Pass9x' } });
  await call('register short password', 'POST', '/api/v1/auth/register', {
    body: { name: 'Harness Bad', email: 'harness-bad@example.invalid', password: 'abc' } });
  await call('register role injection', 'POST', '/api/v1/auth/register', {
    body: { name: 'Harness Role', email: 'harness-role@example.invalid',
            password: 'Harness!Pass9x', role: 'admin' } });

  await call('me', 'GET', '/api/v1/auth/me', { token });
  await call('me tampered token', 'GET', '/api/v1/auth/me', { token: `${token}x` });
  await call('refresh', 'POST', '/api/v1/auth/refresh', { cookie });
  await call('login', 'POST', '/api/v1/auth/login', {
    body: { email: 'harness-new@example.invalid', password: 'Harness!Pass9x' } });
  await call('login wrong password', 'POST', '/api/v1/auth/login', {
    body: { email: 'harness-new@example.invalid', password: 'wrong-one' } });
  await call('login unknown email', 'POST', '/api/v1/auth/login', {
    body: { email: 'harness-nobody@example.invalid', password: 'Harness!Pass9x' } });

  await call('favourites empty', 'GET', '/api/v1/favorites', { token });
  await call('favourite add', 'POST', `/api/v1/favorites/${fx.p1.id}`, { token });
  await call('favourite add again', 'POST', `/api/v1/favorites/${fx.p1.id}`, { token });
  await call('favourites after add', 'GET', '/api/v1/favorites', { token });
  await call('favourite remove', 'DELETE', `/api/v1/favorites/${fx.p1.id}`, { token });
  await call('favourites after remove', 'GET', '/api/v1/favorites', { token });

  await call('enquiry create', 'POST', '/api/v1/enquiries', {
    body: { property: fx.p1.id, name: 'Harness Enquirer',
            email: 'harness-enq@example.invalid', mobile: '9000000005',
            message: 'Harness enquiry body.' } });
  await call('enquiry missing property', 'POST', '/api/v1/enquiries', {
    body: { name: 'X', email: 'harness-enq@example.invalid', mobile: '9000000005', message: 'No property.' } });

  await call('submit listing', 'POST', '/api/v1/properties', { token,
    body: { name: 'Harness Submitted Listing', description: 'Submitted through the API by the harness.',
            type: 'Warehouse', grade: 'Grade B', city: 'Chennai', locality: 'Sriperumbudur',
            rate: 21, area: 40000, depositMonths: 2,
            specs: { clearHeight: 10, loadingDocks: 4, power: 300, features: [] } } });
  await call('submitted listing not public', 'GET', '/api/v1/properties?city=Chennai');

  await call('admin as non-admin', 'GET', '/api/v1/admin/properties', { token });
}

/* ── Main ──────────────────────────────────────────────────────────────── */

(async () => {
  try {
    if (driver === 'dynamo') await startDynamo();
    else await startMongo();

    const fx = await seed();

    const app = require(path.join(SRV, 'src/app'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => new Promise((r) => server.close(r)));
    port = server.address().port;

    await run(fx);

    /* A blanket check, because this leak has now happened four separate
       ways: req.user, users.create, the sign-in response and the refresh
       response. Every one was the same root cause — Mongoose's toJSON
       transform was doing security work, and it stops running the moment a
       row comes from the repository layer instead of a document.
       Rather than remember every return path, assert on the output. */
    const SECRETS = ['password', 'tokenVersion', 'failedLoginAttempts', 'lockedUntil', 'passwordChangedAt'];
    const leaks = [];
    const walk = (node, label, path) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, label, `${path}[${i}]`)); return; }
      for (const [k, v] of Object.entries(node)) {
        if (SECRETS.includes(k)) leaks.push(`${label}: ${path}.${k}`);
        walk(v, label, `${path}.${k}`);
      }
    };
    for (const r of results) walk(r.body, r.label, 'body');
    if (leaks.length) {
      process.stderr.write(`SECRET LEAK in ${leaks.length} place(s):\n  ${leaks.join('\n  ')}\n`);
      await stopAll();
      process.exit(2);
    }

    process.stdout.write(`${JSON.stringify({ driver, results }, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`HARNESS FAILED: ${err && err.stack ? err.stack : err}\n`);
    await stopAll();
    process.exit(1);
  }
  await stopAll();
  process.exit(0);
})();
