/* ============================================================
   99Warehousing — "sample data" disclosure
   ------------------------------------------------------------
   Shows a fixed notice when, and only when, the bundled demo
   backend has actually answered a request.

   The condition matters. window.BPSF_DEMO only PERMITS the
   fallback; it does not mean the fallback is in use. With the
   real API reachable, api.js never calls the demo backend and
   this notice must stay hidden — otherwise a live site with a
   working database tells visitors its listings are invented.

   So the trigger is BPSFDemo.isEngaged(), which flips the first
   time the demo backend serves anything. Polled, because the
   engagement happens inside a failed fetch with no event to
   listen for.

   Why disclose at all: the demo catalogue is invented
   warehouses, at invented prices, with invented owners. Unlabelled
   on a live domain, a visitor enquires about a building that does
   not exist.
   ============================================================ */
(function () {
  'use strict';
  if (window.BPSF_DEMO !== true) return;

  var DISMISSED = 'bpsf.demo.notice.dismissed';
  try { if (sessionStorage.getItem(DISMISSED) === '1') return; } catch (e) {}

  var done = false;
  var tries = 0;
  var MAX_TRIES = 40;   // ~12s: long enough for a slow API to time out first

  function engaged() {
    return !!(window.BPSFDemo &&
              typeof window.BPSFDemo.isEngaged === 'function' &&
              window.BPSFDemo.isEngaged());
  }

  function show() {
    done = true;
    var bar = document.createElement('div');
    bar.className = 'demo-notice';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="demo-notice-dot" aria-hidden="true"></span>' +
      '<p class="demo-notice-text"><strong>Sample data.</strong> This site is running without its ' +
      'backend, so every listing, price and owner shown here is an illustrative example — not real ' +
      'inventory. Nothing you submit is saved.</p>' +
      '<button type="button" class="demo-notice-x" aria-label="Dismiss">&times;</button>';

    bar.querySelector('.demo-notice-x').addEventListener('click', function () {
      bar.remove();
      document.body.classList.remove('has-demo-notice');
      try { sessionStorage.setItem(DISMISSED, '1'); } catch (e) {}
    });

    document.body.appendChild(bar);
    /* A class on <body>, not a sibling selector: the notice is appended last,
       so it has no later siblings to reach with ~. The WhatsApp bubble shares
       this corner and would sit underneath it. */
    document.body.classList.add('has-demo-notice');
  }

  function tick() {
    if (done) return;
    if (engaged()) { show(); return; }
    if (++tries > MAX_TRIES) return;
    setTimeout(tick, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick);
  } else {
    tick();
  }
})();
