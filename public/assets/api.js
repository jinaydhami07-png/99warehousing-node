/* ============================================================
   99Warehousing — client-side API layer  (CLIENT SIDE)
   ------------------------------------------------------------
   The single place the browser talks to the server. Every other
   client script goes through this, so swapping hosts or auth
   behaviour is a one-file change.

   Access token  → kept in memory + sessionStorage (short-lived)
   Refresh token → httpOnly cookie set by the server; JavaScript
                   cannot read it, which is the point.
   ============================================================ */
(function (global) {
  'use strict';

  /* The Express API is versioned and mounted at /api/v1 (see
     server/src/app.js). When the server serves these pages itself — the
     normal case, http://localhost:5000 — a relative base is correct and no
     CORS is involved. Override with window.BPSF_API_BASE to point at an API
     on another host. */
  var API_BASE = global.BPSF_API_BASE ||
    (location.protocol === 'file:' ? 'http://localhost:5000/api/v1' : '/api/v1');

  /* Where the API lives when the pages are being served by something else.
     Opening the site through Live Server, http-server or a bundler is common,
     and in that case the relative base above points at a port with no API on
     it. Without this the page would decide there is no backend at all and
     silently switch to demo data — so edits would appear to succeed while the
     database never changed. */
  var LOCAL_API = 'http://localhost:5000/api/v1';

  var isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  /* True once a request has actually reached the real API in this session.
     After that, a later failure means the server is struggling — not that
     this is a static demo site — so writes must surface the error instead of
     being answered by the demo backend. */
  var apiConfirmed = false;

  if (location.protocol === 'file:') {
    console.warn(
      '[99Warehousing] Opened from the filesystem. Sign-in and uploads need cookies, ' +
      'which browsers block on file:// — open http://localhost:5000 instead.'
    );
  }

  var TOKEN_KEY = 'bpsf.access_token';
  var USER_KEY = 'bpsf.user';

  var accessToken = null;
  try { accessToken = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* private mode */ }

  function setSession(token, user) {
    accessToken = token || null;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
      if (user) sessionStorage.setItem(USER_KEY, JSON.stringify(user));
      else sessionStorage.removeItem(USER_KEY);
    } catch (e) { /* ignore */ }
    global.dispatchEvent(new CustomEvent('bpsf:auth', { detail: { user: user || null } }));
  }

  function currentUser() {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
  }

  var isAuthed = function () { return !!accessToken; };
  var isAdmin = function () { var u = currentUser(); return !!u && u.role === 'admin'; };

  /* ── Response envelope ──
     The Express API wraps every response as
         { success, message, data, meta? }
     which is good server-side practice, but the pages were written against
     a flat shape ({ accessToken, user }, { items, total }, …).

     This is the adapter's job, so the unwrapping happens here once rather
     than forcing every page to reach through `.data`. Anything that is not
     our envelope (the demo backend, a third-party error body) passes
     through untouched.

       { data: { accessToken, user } }        → { accessToken, user }
       { data: [ … ], meta: { total, … } }    → { items: [ … ], total, … }
  */
  function unwrap(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
    if (!Object.prototype.hasOwnProperty.call(json, 'success')) return json;

    var data = json.data;
    var meta = json.meta || {};

    if (Array.isArray(data)) {
      return Object.assign({ items: data }, meta);
    }
    if (data && typeof data === 'object') {
      return Object.assign({}, data, meta);
    }
    // No data payload (e.g. logout) — hand back the envelope itself.
    return json;
  }

  /* ── Error messages ──
     The Express API reports failures as
         { success: false, message, errors: [{ field, message }] }
     while the demo backend uses { error, details }. Read both, and prefer
     the specific field-level complaint ("Rate is required") over the generic
     summary ("Validation failed") — that is the part a user can act on.

     Without this the pages fell back to "Request failed (422)" for every
     rejected form, which tells the user nothing about what to change. */
  function errorMessage(data, status, fallback) {
    if (data && typeof data === 'object') {
      var list = data.errors || data.details;
      if (Array.isArray(list) && list.length) {
        var first = list[0];
        var text = typeof first === 'string' ? first : first && first.message;
        if (text) return first && first.field ? first.field + ': ' + text : text;
      }
      if (data.error) return data.error;
      if (data.message) return data.message;
    }
    return fallback || 'Request failed (' + status + ')';
  }

  /* ── Offline fallback ──
     When the API can't be reached, requests can be routed to the bundled
     demo backend so the pages still render something.

     OFF BY DEFAULT, and deliberately so. This is a live marketplace: the
     demo dataset is fourteen invented warehouses with invented prices and
     invented owners, and showing those to a real visitor as though they
     were inventory is worse than showing nothing. It also made the site
     look like it had reset itself — the real catalogue vanished and a
     different one took its place.

     It stays available for the one case it was written for: demonstrating
     the site on a static host with no backend at all (GitHub Pages). Turn
     it on explicitly, per page load:

         <script>window.BPSF_DEMO = true;</script>   before api.js
         …or open any page with ?demo=1

     With it off, an unreachable API surfaces as an error and each page
     shows its own "could not load" state. That is the honest answer. */
  var DEMO_ENABLED = (function () {
    if (global.BPSF_DEMO === true) return true;
    try { return new URLSearchParams(location.search).get('demo') === '1'; }
    catch (e) { return false; }
  })();

  var demoMode = false;

  function splitPath(path) {
    var i = path.indexOf('?');
    if (i === -1) return { path: path, query: {} };
    var q = {};
    new URLSearchParams(path.slice(i + 1)).forEach(function (v, k) { q[k] = v; });
    return { path: path.slice(0, i), query: q };
  }

  function toDemo(path, options) {
    if (!DEMO_ENABLED || !global.BPSFDemo) {
      var off = new Error(
        (options.method || 'GET').toUpperCase() === 'GET'
          ? 'Could not reach the server. Please try again in a moment.'
          : 'Could not reach the server, so this was NOT saved. ' +
            'Check your connection and that the API is running, then try again.'
      );
      off.status = 0;
      off.offline = true;
      if ((options.method || 'GET').toUpperCase() !== 'GET') off.notSaved = true;
      throw off;
    }

    /* ── Never fake a save. Ever. ──
       Reading demo data when no backend exists is useful: the site still
       demonstrates itself on a static host. Answering a WRITE from the demo
       backend is not — it writes the record into localStorage, reports
       success, and the database never hears about it. The listing then
       exists on exactly one browser: clear the site data, open it on a
       phone, or come back after the storage is evicted, and the property is
       simply gone. From the outside that looks like the site reset itself.

       This used to be allowed whenever the real API had not yet answered in
       this session — which is precisely the situation during a first-load
       submit, and precisely when it does the most damage. A write that
       cannot reach the server now always raises, on every path, so the
       submit form shows an error and the user still has their work.

       Reads may still fall back: stale listings on screen are obvious and
       harmless, and nothing is lost by showing them. */
    var method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      var e = new Error(
        'Could not reach the server, so this was NOT saved. ' +
        'Check your connection and that the API is running, then try again.'
      );
      e.status = 0;
      e.notSaved = true;
      throw e;
    }

    /* Once the API has answered in this session, it exists. A later read
       failing is a blip — a slow query, a dropped connection — not proof
       that this is a static demo site. Swapping in the demo catalogue there
       would replace the user's real listings with invented ones on screen,
       which is the other half of what reads as "everything reset". */
    if (apiConfirmed) {
      var re = new Error('Could not reach the server. Please try again in a moment.');
      re.status = 0;
      re.offline = true;
      throw re;
    }

    if (!demoMode) {
      demoMode = true;
      console.info('[99Warehousing] API unreachable — running on the local demo backend (demo mode was requested).');
    }
    var parts = splitPath(path);
    return BPSFDemo.handle(options.method || 'GET', parts.path, options.body, parts.query)
      .then(function (data) {
        // Keep the client session in step with the demo session.
        if (data && data.accessToken) setSession(data.accessToken, data.user);
        if (path === '/auth/logout') setSession(null, null);
        return data;
      });
  }

  /* How long to wait for the API before deciding it isn't there.
     Without this a request can hang forever (notably from file://,
     where the browser may never settle the promise) and the page
     would sit on a spinner instead of falling back to demo data.

     This budget only makes sense for a READ, where the question being asked
     is "is there a backend at all" and the answer arrives in milliseconds. */
  var API_TIMEOUT_MS = 3500;

  /* A write gets far longer, and an upload longer still.
     Three and a half seconds is not a timeout for a ten-megabyte photo on a
     phone connection — it is a guaranteed abort partway through. The old
     code applied the read budget to every request, so a slow upload was
     cancelled mid-flight and treated as "no server here"; before the fix
     above, the listing was then written to localStorage and lost. Even now
     it would fail a save that was going to succeed. */
  var WRITE_TIMEOUT_MS = 30000;
  var UPLOAD_TIMEOUT_MS = 180000;

  function timeoutFor(options) {
    if ((options.method || 'GET').toUpperCase() === 'GET') return API_TIMEOUT_MS;
    return options.body instanceof FormData ? UPLOAD_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  }

  /* Probe the standard dev port. If the API answers there, adopt it as the
     base for the rest of the session.

     The result is memoised as a PROMISE, not a boolean flag, because pages
     fire several requests at once (the dashboard opens with five). With a
     plain "already tried" flag the first caller starts the probe and every
     other caller sees the flag set, skips the probe, and drops to demo mode
     — which is sticky, so the whole page ends up on demo data even though
     the probe was about to succeed. Sharing one promise makes the others
     wait for the same answer. */
  var localApiProbe = null;

  function adoptLocalApi() {
    if (localApiProbe) return localApiProbe;

    localApiProbe = fetch(LOCAL_API + '/health', { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) return false;
        return r.json().then(function (j) {
          if (!j || j.success !== true) return false;
          API_BASE = LOCAL_API;
          API.base = LOCAL_API;
          /* A racing request may already have flipped this on. The API is
             there after all, so undo that — otherwise every later call keeps
             short-circuiting to demo data. */
          demoMode = false;
          console.info('[99Warehousing] API found at ' + LOCAL_API + ' — using it instead of this origin.');
          return true;
        });
      })
      .catch(function () { return false; });

    return localApiProbe;
  }

  /* ── Core request ──
     On a 401 we try the refresh cookie exactly once, then replay the
     original request. `_retried` stops that becoming an infinite loop. */
  function request(path, options, _retried) {
    options = options || {};

    // Already known to be offline — don't re-attempt the network every call.
    if (demoMode) return toDemo(path, options);

    // Opened straight off disk: cookies and CORS can't work, so don't even try.
    if (location.protocol === 'file:') return toDemo(path, options);

    var headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutFor(options));

    return fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'include', // send/receive the refresh cookie
      signal: controller ? controller.signal : undefined,
      body:
        options.body === undefined || options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body),
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 204) return null;

      /* ── Is there actually a backend at this origin? ──
         On a static host (GitHub Pages, Netlify, S3) there is no API, so
         every /api/v1/… request is answered by whatever that host says for
         an unknown path. That is an HTTP error, not a network failure, so
         the offline fallback never fired and the whole site appeared
         broken: sign-in, favourites and the contact form all failed with a
         bare "Request failed (404)".

         The tell is the CONTENT TYPE, not the status. This API answers in
         JSON for everything, successes and failures alike — a real 404
         ("no property with that id") arrives as our own envelope. Anything
         that is not JSON did not come from us: a host's HTML 404 page, a
         proxy's 502, a static server answering 501 to a POST because it
         only knows how to serve files.

         Judging by status code instead got this wrong in both directions.
         A 501 from a dumb static host counted as "reached the API", which
         then suppressed the read fallback for the rest of the session. */
      var ctype = res.headers.get('content-type') || '';
      if (ctype.indexOf('json') === -1) {
        /* Before writing the origin off, check the usual dev port. The
           pages are often opened through Live Server or similar, where the
           relative base points at a server that only has files on it while
           the real API is running on 5000 all along. */
        if (isLocalHost && API_BASE !== LOCAL_API) {
          return adoptLocalApi().then(function (found) {
            return found ? request(path, options, _retried) : toDemo(path, options);
          });
        }
        return toDemo(path, options);
      }

      // Reached the real API — from here on, writes must not be faked.
      apiConfirmed = true;

      return res
        .json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (res.ok) return unwrap(data);

          if (res.status === 401 && !_retried && path.indexOf('/auth/') !== 0) {
            return refresh().then(
              function () { return request(path, options, true); },
              function () {
                setSession(null, null);
                var err = new Error(errorMessage(data, res.status, 'Session expired. Please sign in again.'));
                err.status = 401;
                throw err;
              }
            );
          }

          var err = new Error(errorMessage(data, res.status));
          err.status = res.status;
          err.details = data.errors || data.details;
          throw err;
        });
    },
    function () {
      // fetch() rejected or timed out → no server reachable
      clearTimeout(timer);
      return toDemo(path, options);
    });
  }

  function refresh() {
    if (demoMode || location.protocol === 'file:') return toDemo('/auth/refresh', { method: 'POST' });

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    /* Longer than a read budget: a refresh that times out signs the user
       out, and being signed out mid-submit loses whatever they were saving.
       Short enough that a genuinely dead server does not hang the page. */
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 10000);

    return fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      signal: controller ? controller.signal : undefined
    })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('refresh failed');
        return r.json();
      }, function () {
        clearTimeout(timer);
        return toDemo('/auth/refresh', { method: 'POST' });
      })
      .then(function (d) { if (d && d.accessToken) setSession(d.accessToken, d.user); return d; });
  }

  var qs = function (params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    });
    return parts.length ? '?' + parts.join('&') : '';
  };

  var API = {
    base: API_BASE,
    isAuthed: isAuthed,
    isAdmin: isAdmin,
    currentUser: currentUser,
    setSession: setSession,
    refresh: refresh,

    auth: {
      register: function (payload) {
        return request('/auth/register', { method: 'POST', body: payload })
          .then(function (d) { setSession(d.accessToken, d.user); return d; });
      },
      login: function (email, password) {
        return request('/auth/login', { method: 'POST', body: { email: email, password: password } })
          .then(function (d) { setSession(d.accessToken, d.user); return d; });
      },
      adminLogin: function (passkey) {
        return request('/auth/admin', { method: 'POST', body: { passkey: passkey } })
          .then(function (d) { setSession(d.accessToken, d.user); return d; });
      },
      me: function () { return request('/auth/me'); },
      logout: function () {
        return request('/auth/logout', { method: 'POST' })
          .catch(function () { /* log out locally even if the call fails */ })
          .then(function () { setSession(null, null); });
      },
      /* Full-page redirect — OAuth cannot run inside fetch(). */
      googleUrl: function () { return API_BASE + '/auth/google'; },
    },

    properties: {
      list: function (filters) { return request('/properties' + qs(filters)); },
      get: function (id) { return request('/properties/' + id); },
      create: function (payload) { return request('/properties', { method: 'POST', body: payload }); },
      update: function (id, patch) { return request('/properties/' + id, { method: 'PATCH', body: patch }); },
      remove: function (id) { return request('/properties/' + id, { method: 'DELETE' }); },
      mine: function () { return request('/properties/mine'); },
      /* Owner phone/email. Separate call because the server only releases
         these to a signed-in account — they are never part of the public
         listing payload. Rejects with 401 when signed out. */
      contact: function (id) { return request('/properties/' + id + '/contact'); },
    },

    /* ── Image / document upload ──
       Upload first, then attach the returned objects to a property:

         var fd = new FormData();
         for (var i = 0; i < input.files.length; i++) fd.append('files', input.files[i]);
         API.upload(fd).then(function (res) {
           return API.properties.create({ name: …, rate: …, area: …, images: res.files });
         });

       Content-Type is deliberately not set — the browser must add the
       multipart boundary itself.

       `kind` is 'photo' or 'floorplan'. A floor plan is stored under its own
       prefix and gets a larger full-size rendition, because it is opened and
       read rather than glanced at in a card. */
    upload: function (formData, kind) {
      var path = kind === 'floorplan' ? '/upload?kind=floorplan' : '/upload';
      return request(path, { method: 'POST', body: formData });
    },

    images: {
      /* Images live in S3 behind a CDN, so a stored url is already absolute
         and goes straight into <img src>. This builds the API path for the
         older ones, whose url is /api/v1/images/:id — that route still
         works and redirects to the CDN once an image has been migrated. */
      url: function (publicId) { return API_BASE + '/images/' + publicId; },
      remove: function (publicId) {
        return request('/images/' + publicId, { method: 'DELETE' });
      },
    },

    /* ── Media ──────────────────────────────────────────────────────
       Turning a stored image record into markup that loads quickly.

       The server renders each upload at several widths and hands back the
       whole set. These helpers put that set in front of the browser so it
       can choose: a phone on a card grid fetches the 320px file, a desktop
       gallery fetches the 1280px one, and nobody downloads a 4000px phone
       photo to display it in a 400px box.

       Everything degrades. An image with no variants — anything uploaded
       before this existed — still renders from its single url, just
       without the choice. So these are safe to call on any image object.
       ─────────────────────────────────────────────────────────────── */
    media: {
      /* Sorted small to large; the browser needs the widths, not the order,
         but a stable order keeps the generated markup diffable. */
      variants: function (img) {
        if (!img) return [];
        var list = (img.variants || []).filter(function (v) { return v && v.url && v.w; });
        return list.sort(function (a, b) { return a.w - b.w; });
      },

      /* The srcset attribute. Empty string when there is nothing to choose
         between, so the caller can drop the attribute entirely rather than
         emitting srcset="". */
      srcset: function (img) {
        return API.media.variants(img).map(function (v) {
          return v.url + ' ' + v.w + 'w';
        }).join(', ');
      },

      /* The plain src — what a browser without srcset support loads, and
         what the others use to resolve relative candidates. Deliberately
         NOT the largest file: if srcset is ignored for any reason, a
         middling size is a far better thing to be stuck with than 1920px.
         `min` keeps a small target (a thumbnail) from picking something
         needlessly big. */
      src: function (img, min) {
        if (!img) return '';
        var list = API.media.variants(img);
        if (!list.length) return img.url || '';
        var wanted = min || 640;
        for (var i = 0; i < list.length; i++) {
          if (list[i].w >= wanted) return list[i].url;
        }
        return list[list.length - 1].url;
      },

      /* Full resolution — for the lightbox and the "open floor plan" link,
         where the point is to see detail. */
      full: function (img) {
        var list = API.media.variants(img);
        return list.length ? list[list.length - 1].url : (img && img.url) || '';
      },

      /* The image a card should show: the one marked primary, else the
         first with a url. Every listing grid on the site used to repeat
         this rule inline, which is how they drifted apart. */
      cover: function (property) {
        var imgs = (property && property.images) || [];
        var primary = null;
        var first = null;
        for (var i = 0; i < imgs.length; i++) {
          if (!imgs[i] || !imgs[i].url) continue;
          if (!first) first = imgs[i];
          if (imgs[i].isPrimary && !primary) primary = imgs[i];
        }
        return primary || first || null;
      },

      /**
       * The fields a listing stores for one image.
       *
       * Every form that saves a property has to send its photos back, and
       * each of them used to hand-pick the fields to copy. Miss one and the
       * effect is invisible until later: an admin opens a listing, changes
       * the price, saves, and the photos silently lose their renditions and
       * their placeholders — still there, still displayed, just slow again.
       *
       * So the list lives here once. `extra` carries whatever the caller
       * decides on the spot, which in practice is `isPrimary`.
       */
      descriptor: function (img, extra) {
        if (!img || !img.url) return null;
        var out = {
          url: img.url,
          publicId: img.publicId,
          variants: img.variants,
          blur: img.blur,
          width: img.width,
          height: img.height
        };
        if (img.caption) out.caption = img.caption;
        for (var k in (extra || {})) out[k] = extra[k];
        /* Undefined keys would be sent as nothing anyway, but the property
           schema is strict and an explicitly null variants array is not the
           same as an absent one. */
        Object.keys(out).forEach(function (k) {
          if (out[k] === undefined || out[k] === null) delete out[k];
        });
        return out;
      },

      /* A style value that paints the tiny inlined placeholder behind the
         image while the real file is in flight — so the space shows the
         rough colours and shape of the photo instead of an empty box.

         The blur field is validated server-side to be a base64 image data
         URI and nothing else, which is what makes it safe to interpolate
         into a style attribute here. */
      blurStyle: function (img) {
        if (!img || !img.blur) return '';
        return 'background-image:url(' + img.blur + ');background-size:cover;background-position:center;';
      },

      /* `width`/`height` attributes, so the browser reserves the right box
         before the bytes arrive and the page stops jumping as photos load.
         Returns '' when the dimensions were never recorded — a wrong ratio
         is worse than none, because it distorts a correctly-sized image. */
      sizeAttrs: function (img) {
        if (!img || !img.width || !img.height) return '';
        return ' width="' + img.width + '" height="' + img.height + '"';
      },

      /**
       * One <img> tag, built the fast way.
       *
       * opts: { alt, sizes, className, style, eager, min }
       *
       * `eager` is for the one image that is visible before any scrolling —
       * a gallery's first photo. Everything else stays lazy. Marking the
       * above-the-fold image eager AND high priority is what stops it
       * queueing behind a screenful of thumbnails.
       */
      tag: function (img, opts) {
        var o = opts || {};
        if (!img || !img.url) return '';

        var srcset = API.media.srcset(img);
        var esc = function (s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };

        return '<img src="' + esc(API.media.src(img, o.min)) + '"' +
          (srcset ? ' srcset="' + esc(srcset) + '"' : '') +
          (srcset && o.sizes ? ' sizes="' + esc(o.sizes) + '"' : '') +
          ' alt="' + esc(o.alt || '') + '"' +
          API.media.sizeAttrs(img) +
          (o.eager ? ' loading="eager" fetchpriority="high"' : ' loading="lazy" fetchpriority="low"') +
          ' decoding="async"' +
          (o.className ? ' class="' + esc(o.className) + '"' : '') +
          ' style="' + esc(API.media.blurStyle(img) + (o.style || '')) + '">';
      },
    },

    reviews: {
      /* Public — published reviews plus the average, for one property. */
      forProperty: function (propertyId) {
        return request('/properties/' + propertyId + '/reviews');
      },
      /* The signed-in user's own review, whatever its moderation state, so
         the form can show what they already said instead of a blank box. */
      mine: function (propertyId) {
        return request('/properties/' + propertyId + '/reviews/mine');
      },
      /* Creating twice replaces rather than duplicates — the server upserts
         on (property, author). */
      create: function (propertyId, payload) {
        return request('/properties/' + propertyId + '/reviews', { method: 'POST', body: payload });
      },
      /* Admin moderation queue. */
      pending: function () { return request('/admin/reviews'); },
      moderate: function (id, patch) {
        return request('/admin/reviews/' + id, { method: 'PATCH', body: patch });
      },
      remove: function (id) { return request('/admin/reviews/' + id, { method: 'DELETE' }); },
    },

    account: {
      /* The signed-in user's own profile. `role` and `isActive` are rejected
         server-side, so this cannot be used to self-promote. */
      me: function () { return request('/users/me'); },
      update: function (patch) { return request('/users/me', { method: 'PATCH', body: patch }); },
    },

    favorites: {
      list: function () { return request('/favorites'); },
      add: function (id) { return request('/favorites/' + id, { method: 'POST' }); },
      remove: function (id) { return request('/favorites/' + id, { method: 'DELETE' }); },
    },

    enquiries: {
      create: function (payload) { return request('/enquiries', { method: 'POST', body: payload }); },
      mine: function () { return request('/enquiries/mine'); },
    },

    admin: {
      stats: function () { return request('/admin/stats'); },
      properties: function (status, q) { return request('/admin/properties' + qs({ status: status, q: q })); },
      approve: function (id) { return request('/admin/properties/' + id + '/approve', { method: 'PATCH' }); },
      reject: function (id, reason) {
        return request('/admin/properties/' + id + '/reject', { method: 'PATCH', body: { reason: reason } });
      },
      create: function (payload) { return request('/admin/properties', { method: 'POST', body: payload }); },
      update: function (id, patch) { return request('/admin/properties/' + id, { method: 'PATCH', body: patch }); },
      remove: function (id) { return request('/admin/properties/' + id, { method: 'DELETE' }); },
      users: function () { return request('/admin/users'); },
      updateUser: function (id, patch) { return request('/admin/users/' + id, { method: 'PATCH', body: patch }); },
      enquiries: function () { return request('/admin/enquiries'); },
      audit: function () { return request('/admin/audit'); },
    },

    config: function () { return request('/config'); },
    health: function () { return request('/health'); },
  };

  /* Google redirects back with #token=… — consume it, then strip it from
     the URL so the token isn't left sitting in the address bar or history. */
  (function captureOAuthToken() {
    if (!location.hash || location.hash.indexOf('token=') === -1) return;
    var token = new URLSearchParams(location.hash.slice(1)).get('token');
    if (!token) return;
    accessToken = token;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
    API.auth.me()
      .then(function (d) { setSession(token, d.user); })
      .catch(function () { setSession(null, null); });
  })();

  global.API = API;
})(window);
