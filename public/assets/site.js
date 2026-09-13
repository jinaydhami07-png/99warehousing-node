/* ============================================================
   99Warehousing — shared site behaviour
   Navbar scroll state, mobile menu, scroll reveal.
   Loaded with `defer` on every page. Page-specific logic stays
   inline in each page's own <script> block.
   ============================================================ */
(function () {
  'use strict';

  /* ─── Brand logo ───────────────────────────────────────────────
     The mark is fetched once and inlined into every logo slot rather than
     used through <img>, for two reasons:

       • an SVG inside <img> is an isolated document — it cannot see the
         page's webfont, so the numerals would silently fall back to a
         system face and change shape from machine to machine;
       • inlined, `currentColor` resolves against the surrounding CSS, so the
         same file renders dark on the navbar and cream on the dashboard
         sidebar with no second copy.

     The existing wordmark text stays in the HTML and is only replaced once
     the SVG has actually arrived, so the logo degrades to readable text if
     the request fails or scripting is off. */
  function mountLogo() {
    var slots = document.querySelectorAll('.nav-logo, .auth-logo, .sidebar-logo-text');
    if (!slots.length) return;

    /* The supplied artwork, lifted off its paper mockup. A bitmap cannot take
       its colour from CSS the way an inline SVG can, so there are two prints
       of the same mask: dark for the light navbar, cream for the dark
       dashboard sidebar.

       Only the graphic half of the artwork is used. The full lockup carries
       the "99warehouses" wordmark, which beside the written name would read
       "99warehouses 99Warehousing" — logo-photo-full.png holds that version
       for standalone use. */
    slots.forEach(function (slot) {
      if (slot.querySelector('.brand-mark')) return;   // already mounted

      /* Wrap the written name so CSS can address it on its own. A phone
         shows the mark alone — and the name is a bare text node in the
         markup, which no selector can reach. The wrapper is added up front
         rather than in onload because on its own it changes nothing: only
         `.has-logo`, set once the image has really arrived, lets the mobile
         rule hide the name. If the image 404s the name simply stays. */
      if (!slot.querySelector('.brand-name')) {
        /* Named before the name is wrapped away. On a phone the text is
           hidden and the mark is decorative, so the link would otherwise
           reach a screen reader with no accessible name at all. */
        if (slot.tagName === 'A' && !slot.getAttribute('aria-label')) {
          slot.setAttribute('aria-label', slot.textContent.replace(/\s+/g, ' ').trim() + ' — home');
        }
        var name = document.createElement('span');
        name.className = 'brand-name';
        while (slot.firstChild) name.appendChild(slot.firstChild);
        slot.appendChild(name);
      }

      /* Which print to use. The dashboard sidebar and the auth pages' brand
         panel are both dark mahogany — the brown mark all but disappears on
         them, so they take the cream one. */
      var onDark = slot.classList.contains('sidebar-logo-text') ||
                   slot.classList.contains('auth-logo');
      var img = new Image();
      img.src = 'assets/img/logo-photo' + (onDark ? '-light' : '') + '.png';
      img.alt = '';                                    // the adjacent text names the brand
      img.decoding = 'async';

      /* Prepended, not substituted: the written name stays on screen and
         remains selectable text for search engines and screen readers. If the
         file fails to load, nothing is inserted and the name stands alone. */
      img.onload = function () {
        var holder = document.createElement('span');
        holder.className = 'brand-mark';
        holder.setAttribute('aria-hidden', 'true');
        holder.appendChild(img);
        slot.classList.add('has-logo');
        slot.insertBefore(holder, slot.firstChild);
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountLogo);
  } else {
    mountLogo();
  }

  /* ─── Account chip ─────────────────────────────────────────────
     Replaces the "Login" button once there is a session, showing who is
     signed in and giving them somewhere to go. The photo comes from Google
     when the account was created that way; otherwise the initial stands in,
     so the chip looks the same shape either way.
     ───────────────────────────────────────────────────────────── */
  function renderAccountChip() {
    var actions = document.querySelector('.nav-actions');
    if (!actions || !window.API) return;

    var existing = actions.querySelector('.account-chip');
    var loginBtn = actions.querySelector('.btn-login');
    var user = API.isAuthed() ? API.currentUser() : null;

    if (!user) {                              // signed out — restore Login
      if (existing) existing.remove();
      if (loginBtn) loginBtn.style.display = '';
      return;
    }

    if (loginBtn) loginBtn.style.display = 'none';
    if (existing) existing.remove();

    var wrap = document.createElement('div');
    wrap.className = 'account-chip';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'account-chip-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    if (user.avatar) {
      var img = document.createElement('img');
      img.className = 'account-avatar';
      img.src = user.avatar;
      img.alt = '';
      /* Google's CDN occasionally refuses hot-linked images. Fall back to the
         initial rather than leaving a broken-image icon in the navbar. */
      img.onerror = function () { img.replaceWith(initialBadge(user)); };
      btn.appendChild(img);
    } else {
      btn.appendChild(initialBadge(user));
    }

    var label = document.createElement('span');
    label.className = 'account-email';
    label.textContent = user.email || user.name || 'Account';
    btn.appendChild(label);

    var caret = document.createElement('span');
    caret.className = 'account-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);

    var menu = document.createElement('div');
    menu.className = 'account-menu';
    menu.hidden = true;
    menu.innerHTML =
      '<div class="account-menu-head">' +
        '<div class="account-menu-name"></div>' +
        '<div class="account-menu-email"></div>' +
      '</div>' +
      '<a class="account-menu-item" href="account.html">⚙ Manage account settings</a>' +
      (user.role === 'admin' ? '<a class="account-menu-item" href="dashboard.html">🛠 Admin dashboard</a>' : '') +
      '<a class="account-menu-item" href="submit-listing.html">🏗 List a property</a>' +
      '<button type="button" class="account-menu-item account-signout">↪ Sign out</button>';
    menu.querySelector('.account-menu-name').textContent = user.name || 'Signed in';
    menu.querySelector('.account-menu-email').textContent = user.email || '';

    btn.onclick = function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    };
    menu.querySelector('.account-signout').onclick = function () {
      API.auth.logout().then(function () { window.location = 'index.html'; });
    };

    /* Clicking anywhere else, or pressing Escape, closes it. */
    document.addEventListener('click', function () { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    /* First in the actions row, so it reads before "List Property". */
    actions.insertBefore(wrap, actions.firstChild);
  }

  function initialBadge(user) {
    var span = document.createElement('span');
    span.className = 'account-avatar account-initial';
    span.textContent = ((user.name || user.email || '?').trim()[0] || '?').toUpperCase();
    return span;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAccountChip);
  } else {
    renderAccountChip();
  }
  window.addEventListener('bpsf:auth', renderAccountChip);

  /* ─── Navbar scroll state ─── */
  var navbar = document.getElementById('navbar') || document.querySelector('.navbar');

  if (navbar) {
    var onScroll = function () {
      var scrolled = window.scrollY > 50;
      navbar.classList.toggle('scrolled', scrolled);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ─── Mobile menu ─── */
  var menu = document.getElementById('mobileMenu');
  var hamburger = document.getElementById('hamburger');

  function toggleMenu() {
    if (!menu) return;
    var open = menu.classList.toggle('open');

    // The X-fold lives in CSS (.hamburger.open) rather than in inline
    // styles here: the bar geometry is a style concern, and inline
    // transforms outrank the stylesheet, so the two fought each other
    // whenever the bar size changed.
    if (hamburger) {
      hamburger.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', String(open));
    }

    // Stop the page behind the sheet from scrolling under it.
    document.body.classList.toggle('menu-open', open);
  }

  // Pages wire this up via onclick="toggleMenu()", so it has to be global.
  window.toggleMenu = toggleMenu;

  // Close the menu on Escape.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu && menu.classList.contains('open')) toggleMenu();
  });

  /* ─── Scroll reveal ─── */
  var revealables = document.querySelectorAll('.reveal');

  if (revealables.length) {
    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry, i) {
          if (!entry.isIntersecting) return;
          setTimeout(function () { entry.target.classList.add('visible'); }, i * 80);
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.1 });
      revealables.forEach(function (el) { observer.observe(el); });
    } else {
      revealables.forEach(function (el) { el.classList.add('visible'); });
    }
  }
})();
