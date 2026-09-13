# 99warehousing — Node.js application

Deployment repository for **cPanel → Setup Node.js App**. The root of this
repo *is* the application root: `app.js`, `package.json`, the API in
`server/`, and the website in `public/`, all served by Express from one origin.

Public on purpose: it contains **no secrets**. `server/env` is not tracked and
never will be — see *Settings* below.

---

## Setting it up in cPanel

### 1. Pull the code

**Git Version Control → Create**

| Field | Value |
|---|---|
| Clone URL | `https://github.com/jinaydhami07-png/99warehousing-node.git` |
| Repository Path | `99warehousing` |
| Branch | `main` |

No credentials needed — this repo is public, which is the whole point. A
private repo fails here with an authentication error, because cPanel clones
over HTTPS with nothing to authenticate with.

> **Repository Path must not already exist.** If `~/99warehousing` is there
> from an earlier attempt, cPanel refuses with *"path already exists"*. Rename
> or delete it first, or pick a different path.

### 2. Add the settings file

Upload your `env` to `~/99warehousing/server/env`.

Do this once. It is not in the repository, so `git pull` and redeploys never
touch it. Without it the app will not start.

### 3. Create the application

**Setup Node.js App → Create Application**

| Field | Value |
|---|---|
| Node.js version | 20 (minimum 18) |
| Application mode | Production |
| Application root | `99warehousing` |
| Application URL | `99warehousing.com` — domain root, no subfolder |
| Application startup file | `app.js` |

Application root is relative to your **home** directory, not `public_html`.
Keep it outside `public_html`: Apache serves anything in there as a plain
file, and `server/env` lives in this tree. The two `.htaccess` files are a
backstop for that, not a substitute for putting it in the right place.

### 4. Install and start

**Run NPM Install** → wait → **Restart**. Both are buttons; no terminal needed.

### 5. Let the server reach the database

**MongoDB Atlas → Network Access → Add IP Address**, using the *Shared IP
Address* from the cPanel home page.

Skipping this used to take the whole site down. It no longer does — see
*Behaviour when the database is down* — but the API still cannot work until
the IP is allowed.

### 6. Check

`https://99warehousing.com/api/v1/health`

- `"database":"connected"` → working
- `"database":"disconnected"` → step 5
- 503 with no JSON → npm install unfinished, or Application root is wrong

---

## Updating

Push to `main`, then **Git Version Control → Manage → Pull or Deploy → Update
from Remote**, then **Restart** in Setup Node.js App. Node holds the code in
memory, so a pull alone changes nothing until you restart.

---

## Settings

`server/env` — no leading dot, because cPanel File Manager hides dotfiles and
routinely drops the dot on upload or extract. `server/src/config/env.js`
accepts `.env` first and `env` second, so either name works.

`server/.env.example` is the template and is safe to read; it contains
placeholders only.

The staff passkey is `ADMIN_PASSKEY` inside your settings file. Minimum twelve
characters, then Restart.

---

## Behaviour when the database is down

The server starts and serves pages even if MongoDB is unreachable, and retries
the connection in the background with backoff.

It used to exit instead, which under Passenger meant cPanel returned 503 for
everything — including `/api/v1/health`, the one endpoint that would have
named the cause. API requests still fail while the database is down, but the
site stays up, health reports `disconnected`, and it recovers on its own once
Network Access is fixed. No restart needed.

---

## Install size

`npm install` pulls **156 packages, ~52 MB**. devDependencies are excluded
(`nodemon`, `pino-pretty`, `pm2` — cPanel supervises the process itself), and
`@aws-sdk/client-s3` is left out: 18 MB and ~30 transitive packages that never
load, since `storage.service.js` requires it lazily and only when
`MEDIA_DRIVER=s3`. A missing SDK is handled there as a configuration problem,
logged once, with a fallback to MongoDB image storage.

`sharp` is kept — it does the upload image resizing, and degrades gracefully
if a host cannot build it.

There is no build or compile step. The frontend is plain HTML, CSS and vanilla
JS, served straight from `public/`.

---

## Layout

| Path | What |
|---|---|
| `app.js` | Startup file cPanel runs; hands over to `server/src/server.js` |
| `public/` | The website — 17 pages, served by Express at the domain root |
| `server/src/` | API: routes, controllers, services, models |
| `server/env` | Your settings — **not in this repo**, uploaded once |
| `.htaccess` | Denies web access to this folder |
| `server/.htaccess` | Denies web access to the API folder |

Development source of truth is
[99warehousing](https://github.com/jinaydhami07-png/99warehousing); this repo
is the generated deployment artifact.

---

## Deploying to Vercel

This repo runs on **both** cPanel and Vercel. cPanel runs `app.js` as a
long-lived process; Vercel invokes `api/index.js` per request. Neither entry
point interferes with the other.

| File | Role |
|---|---|
| `api/index.js` | Serverless handler — the Express app, minus `listen()` |
| `vercel.json` | Static from `public/`, `/api/*` to the function |
| `.vercelignore` | Keeps `app.js` and the `.htaccess` files out of the bundle |

### Settings must be added in the Vercel dashboard

`server/env` is not in this repository and Vercel never sees it. Add these
under **Project → Settings → Environment Variables**, copying the values from
your own `env` file:

```
MONGODB_URI
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
JWT_ACCESS_EXPIRES
JWT_REFRESH_EXPIRES
BCRYPT_ROUNDS
ADMIN_PASSKEY
CORS_ORIGINS
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL
GOOGLE_CALLBACK_URLS
MEDIA_DRIVER
BODY_LIMIT
TRUST_PROXY
LOG_LEVEL
MONGO_POOL_SIZE
RATE_LIMIT_WINDOW_MIN
RATE_LIMIT_MAX
AUTH_RATE_LIMIT_MAX
```

Do **not** set `PORT` — Vercel has no port to listen on. `NODE_ENV` is set to
`production` by Vercel automatically.

Three of these need different values than the cPanel deployment:

- **`CORS_ORIGINS`** — add your Vercel URL (`https://<project>.vercel.app`)
  alongside the real domain. Production refuses to start if it still says
  `localhost`.
- **`GOOGLE_CALLBACK_URL`** — must point at the deployed domain over https,
  and the same string must be registered in Google Cloud Console. Production
  refuses to start on a `localhost` or `http` value.
- **`MONGO_POOL_SIZE`** — set it to `5` or lower. Every warm function instance
  holds its own pool, so the cPanel value of 10 multiplies fast and can
  exhaust the Atlas connection limit.

### Atlas must allow Vercel

**Atlas → Network Access → Add IP Address → `0.0.0.0/0`.**

Serverless functions have no fixed IP, so an allowlist of specific addresses
blocks every request. This is the most common reason the site deploys fine but
the API returns errors.

### What runs where

- `/` and every `.html` page, plus `assets/` — served by Vercel's CDN straight
  from `public/`. No function invocation.
- `/api/*` — the serverless function.

### Known limits

Cold starts add a second or two to the first request after idle. Uploads are
capped by Vercel's request body limit, which is smaller than cPanel's. If
either matters, a long-lived host (Render, Railway, or the cPanel Node app)
avoids both.
