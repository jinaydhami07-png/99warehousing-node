/* ============================================================
   99Warehousing — Favorites & Compare store
   ------------------------------------------------------------
   Implements the "Favourite Properties" and "Property Comparison"
   features from the platform spec (web + mobile), persisted locally.

   The public interface is deliberately shaped like the REST routes
   planned in ROADMAP.md §7 (/api/favorites, /api/compare), so Phase 1
   can swap the storage driver for fetch() calls without touching any
   calling page: every method already returns a Promise.
   ============================================================ */
(function (global) {
  'use strict';

  var KEY_FAV = 'bpsf.favorites.v1';
  var KEY_CMP = 'bpsf.compare.v1';
  var COMPARE_MAX = 3;   // matches the three slots in the compare bar UI

  /* ── Storage driver ──
     localStorage throws in Safari private mode and when cookies are
     blocked, so fall back to an in-memory map rather than dying. */
  var memory = {};
  var canPersist = (function () {
    try {
      var probe = '__bpsf__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function readRaw(key) {
    if (!canPersist) return memory[key] || null;
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeRaw(key, value) {
    if (!canPersist) { memory[key] = value; return; }
    try { global.localStorage.setItem(key, value); }
    catch (e) { memory[key] = value; }   // quota exceeded → degrade to memory
  }

  function read(key) {
    var raw = readRaw(key);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];                          // corrupt entry — start clean
    }
  }

  function write(key, list) {
    writeRaw(key, JSON.stringify(list));
  }

  /* ── Events ── */
  function emit(name, detail) {
    global.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  /* ── Collection factory ──
     Both favorites and compare are "a list of property records keyed by
     id", differing only in storage key, cap, and event name. */
  function collection(key, eventName, max) {
    function list() { return read(key); }
    function has(id) { return list().some(function (i) { return i.id === String(id); }); }
    function count() { return list().length; }

    function add(id, meta) {
      var items = list();
      id = String(id);
      if (items.some(function (i) { return i.id === id; })) {
        return { ok: true, added: false, items: items };
      }
      if (max && items.length >= max) {
        return { ok: false, reason: 'limit', max: max, items: items };
      }
      var record = {
        id: id,
        name: (meta && meta.name) || 'Property ' + id,
        location: (meta && meta.location) || '',
        rate: (meta && meta.rate) || '',
        area: (meta && meta.area) || '',
        url: (meta && meta.url) || 'property-detail.html',
        addedAt: (meta && meta.addedAt) || null
      };
      items.push(record);
      write(key, items);
      emit(eventName, { action: 'add', id: id, items: items });
      return { ok: true, added: true, items: items };
    }

    function remove(id) {
      id = String(id);
      var items = list().filter(function (i) { return i.id !== id; });
      write(key, items);
      emit(eventName, { action: 'remove', id: id, items: items });
      return { ok: true, added: false, items: items };
    }

    function toggle(id, meta) {
      return has(id) ? remove(id) : add(id, meta);
    }

    function clear() {
      write(key, []);
      emit(eventName, { action: 'clear', items: [] });
      return { ok: true, items: [] };
    }

    /* Promise-returning surface — matches the shape the API will have,
       so pages written against this need no change in Phase 1. */
    return {
      list: function () { return Promise.resolve(list()); },
      has: function (id) { return Promise.resolve(has(id)); },
      count: function () { return Promise.resolve(count()); },
      add: function (id, meta) { return Promise.resolve(add(id, meta)); },
      remove: function (id) { return Promise.resolve(remove(id)); },
      toggle: function (id, meta) { return Promise.resolve(toggle(id, meta)); },
      clear: function () { return Promise.resolve(clear()); },
      // Synchronous reads, for render paths that can't await.
      listSync: list,
      hasSync: has,
      countSync: count,
      max: max || null
    };
  }

  var BPSF = {
    favorites: collection(KEY_FAV, 'bpsf:favorites', null),
    compare: collection(KEY_CMP, 'bpsf:compare', COMPARE_MAX),
    COMPARE_MAX: COMPARE_MAX,
    persistent: canPersist
  };

  /* ── Server sync ──
     Favourites belong to an account, so when the visitor is signed in the
     API is the source of truth and localStorage is just a mirror. Compare
     stays local by design: it is a scratch selection, not saved data.

     Anonymous favourites are pushed up on sign-in so nothing is lost. */
  function syncFavourites() {
    if (!global.API || !API.isAuthed()) return Promise.resolve();

    var local = BPSF.favorites.listSync();

    return API.favorites.list()
      .then(function (res) {
        var server = res.items || [];
        var serverIds = server.map(function (p) { return String(p.id); });

        // Anything favourited while signed out gets promoted to the account.
        var pushes = local
          .filter(function (l) { return serverIds.indexOf(String(l.id)) === -1; })
          .map(function (l) { return API.favorites.add(l.id).catch(function () {}); });

        return Promise.all(pushes).then(function () {
          return pushes.length ? API.favorites.list() : res;
        });
      })
      .then(function (res) {
        var merged = (res.items || []).map(function (p) {
          return {
            id: String(p.id), name: p.name, location: p.location || '',
            rate: p.rate != null ? '₹' + p.rate + '/sqft' : '',
            area: p.area ? Number(p.area).toLocaleString('en-IN') + ' sq ft' : '',
            url: 'property-detail.html?id=' + p.id,
            addedAt: p.favoritedAt || null
          };
        });
        write(KEY_FAV, merged);
        emit('bpsf:favorites', { action: 'sync', items: merged });
      })
      .catch(function () { /* offline or signed out — local copy still works */ });
  }

  BPSF.sync = syncFavourites;

  /* Mirror every local favourite change up to the server when signed in. */
  global.addEventListener('bpsf:favorites', function (e) {
    if (!global.API || !API.isAuthed()) return;
    var d = e.detail || {};
    if (d.action === 'add') API.favorites.add(d.id).catch(function () {});
    if (d.action === 'remove') API.favorites.remove(d.id).catch(function () {});
  });

  /* Pull the account's favourites once auth is established. */
  global.addEventListener('bpsf:auth', function (e) {
    if (e.detail && e.detail.user) syncFavourites();
  });

  /* ============================================================
     Declarative UI binding
     Any page opts in with markup alone:
       <button data-fav-id="w-101" data-name="…" data-rate="₹28">♡</button>
       <button data-cmp-id="w-101" data-name="…" data-rate="₹28">+ Compare</button>
       <span data-fav-count></span>
     ============================================================ */

  function metaFrom(el) {
    return {
      name: el.getAttribute('data-name') || '',
      location: el.getAttribute('data-location') || '',
      rate: el.getAttribute('data-rate') || '',
      area: el.getAttribute('data-area') || '',
      url: el.getAttribute('data-url') || 'property-detail.html'
    };
  }

  function paintFavButton(el) {
    var on = BPSF.favorites.hasSync(el.getAttribute('data-fav-id'));
    el.classList.toggle('saved', on);
    el.setAttribute('aria-pressed', String(on));
    el.setAttribute('title', on ? 'Remove from favourites' : 'Save to favourites');
    if (el.hasAttribute('data-fav-icon')) el.textContent = on ? '♥' : '♡';
  }

  function paintCmpButton(el) {
    var on = BPSF.compare.hasSync(el.getAttribute('data-cmp-id'));
    el.classList.toggle('in-compare', on);
    el.setAttribute('aria-pressed', String(on));
    if (el.hasAttribute('data-cmp-label')) el.textContent = on ? '✓ Added' : '+ Compare';
  }

  function paintCounts() {
    var f = BPSF.favorites.countSync();
    Array.prototype.forEach.call(document.querySelectorAll('[data-fav-count]'), function (el) {
      el.textContent = f;
      el.hidden = f === 0;
    });
    var c = BPSF.compare.countSync();
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmp-count]'), function (el) {
      el.textContent = c + ' / ' + COMPARE_MAX;
    });
  }

  function paintAll() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-fav-id]'), paintFavButton);
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmp-id]'), paintCmpButton);
    paintCounts();
  }

  function toast(message) {
    var el = document.getElementById('bpsfToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bpsfToast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function bind() {
    // One delegated listener covers cards rendered after load.
    document.addEventListener('click', function (e) {
      var fav = e.target.closest && e.target.closest('[data-fav-id]');
      if (fav) {
        e.preventDefault();
        var favId = fav.getAttribute('data-fav-id');
        var wasFav = BPSF.favorites.hasSync(favId);
        BPSF.favorites.toggle(favId, metaFrom(fav));
        toast(wasFav ? 'Removed from favourites' : 'Saved to favourites');
        return;
      }

      var cmp = e.target.closest && e.target.closest('[data-cmp-id]');
      if (cmp) {
        e.preventDefault();
        var cmpId = cmp.getAttribute('data-cmp-id');
        var wasCmp = BPSF.compare.hasSync(cmpId);
        var res = BPSF.compare.toggle(cmpId, metaFrom(cmp));
        if (!res.ok && res.reason === 'limit') {
          toast('You can compare up to ' + res.max + ' properties at once.');
        } else {
          toast(wasCmp ? 'Removed from comparison' : 'Added to comparison');
        }
      }
    });

    global.addEventListener('bpsf:favorites', paintAll);
    global.addEventListener('bpsf:compare', paintAll);

    // Keep tabs in sync — the storage event fires in *other* tabs only.
    global.addEventListener('storage', function (e) {
      if (e.key === KEY_FAV || e.key === KEY_CMP) paintAll();
    });

    paintAll();
  }

  function start() {
    bind();
    syncFavourites();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  BPSF.refresh = paintAll;
  BPSF.toast = toast;
  global.BPSF = BPSF;
})(window);
