/* ============================================================
   99Warehousing — offline demo backend  (CLIENT SIDE)
   ------------------------------------------------------------
   A complete stand-in for the REST API, backed by localStorage.
   It mirrors the real server's routes and response shapes exactly
   (server/src/routes/*), so every page behaves identically whether
   or not the Node backend is running.

   api.js calls BPSFDemo.handle() automatically whenever the network
   request fails. Start the real server and it takes over with no
   code change — this file simply stops being reached.

   ADMIN PASSKEY: 2010J   (also set as ADMIN_PASSKEY in server/.env)
   ============================================================ */
(function (global) {
  'use strict';

  var ADMIN_PASSKEY = '2010J';

  var K = {
    props: 'bpsf.demo.properties.v2',
    users: 'bpsf.demo.users.v1',
    session: 'bpsf.demo.session.v1',
    favs: 'bpsf.demo.favorites.v1',
    enq: 'bpsf.demo.enquiries.v1',
    audit: 'bpsf.demo.audit.v1'
  };

  /* ── storage (degrades to memory in private mode) ── */
  var mem = {};
  var canPersist = (function () {
    try { localStorage.setItem('__d__', '1'); localStorage.removeItem('__d__'); return true; }
    catch (e) { return false; }
  })();

  function read(key, fallback) {
    var raw;
    try { raw = canPersist ? localStorage.getItem(key) : mem[key]; } catch (e) { raw = mem[key]; }
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }
  function write(key, val) {
    var raw = JSON.stringify(val);
    try { if (canPersist) localStorage.setItem(key, raw); else mem[key] = raw; }
    catch (e) { mem[key] = raw; }
  }

  var uid = function (p) { return p + '-' + Math.random().toString(36).slice(2, 9); };
  var nowISO = function () { return new Date().toISOString(); };

  /* ── seed properties ──
     10 live, 3 awaiting review (these populate the admin queue), 1 rejected. */
  function seed() {
    var mk = function (o) {
      return {
        id: o.id, slug: o.id, name: o.name, type: o.type, grade: o.grade,
        listingType: 'rent',
        city: o.city, locality: o.locality,
        location: o.locality + ', ' + o.city,
        rate: o.rate, area: o.area, depositMonths: o.dep || 3,
        icon: o.icon || '🏭',
        specs: {
          clearHeight: o.ch || null, loadingDocks: o.dk || null, power: o.pw || null,
          features: o.ft || ['24×7 Security', 'CCTV Surveillance', 'Power Backup']
        },
        description: o.desc,
        ownerName: o.owner, ownerEmail: (o.owner || 'owner').toLowerCase().replace(/[^a-z]/g, '') + '@example.com',
        status: o.status || 'approved',
        isVerified: (o.status || 'approved') === 'approved',
        rejectionReason: o.reason || '',
        views: o.views || 0, enquiryCount: 0,
        createdAt: o.at
      };
    };

    return [
      mk({ id: 'demo-001', name: 'Bhiwandi Logistics Hub — Block C', type: 'Warehouse', grade: 'Grade A', city: 'Mumbai', locality: 'Bhiwandi', rate: 28, area: 85000, ch: 12, dk: 8, pw: 500, icon: '🏭', owner: 'Deepak Patel', views: 1240, at: '2026-06-02T09:00:00Z',
        desc: 'Premium Grade A warehouse in MIDC Bhiwandi, India\'s largest inland logistics cluster. Purpose-built to modern logistics specification with 12m clear height and column-free 24m spans, suitable for high-rack storage up to 12 pallet levels. NH-48 within 4km and JNPT reachable in under 45 minutes.' }),
      mk({ id: 'demo-002', name: 'Pune Cold Storage Facility — MIDC Chakan', type: 'Cold Storage', grade: 'Cold Chain', city: 'Pune', locality: 'Chakan', rate: 42, area: 32000, ch: 9, dk: 4, pw: 750, icon: '❄️', owner: 'Sunita Rao', views: 890, at: '2026-06-11T09:00:00Z',
        ft: ['Multi-temperature Zones', 'Blast Freezing', '100% Power Backup', 'Dock Levellers'],
        desc: 'Multi-temperature cold chain facility with zones from −25°C to +15°C. Blast freezing capability, insulated dock shelters, and full redundancy on refrigeration. Ideal for pharma, dairy, and quick-commerce fulfilment.' }),
      mk({ id: 'demo-003', name: 'GMR Aero Warehousing Complex — T3', type: 'Warehouse', grade: 'Grade A', city: 'Delhi', locality: 'Aerocity', rate: 35, area: 120000, ch: 15, dk: 6, pw: 900, icon: '🏭', owner: 'GMR Estates', views: 2110, at: '2026-06-18T09:00:00Z',
        ft: ['LEED Gold Certified', 'Airside Access', '24×7 Security', 'Fire Suppression'],
        desc: 'LEED Gold certified airside warehousing adjacent to Delhi International Airport Terminal 3. Bonded warehouse capability and customs clearance on site. Best suited to air-freight forwarders and high-value electronics.' }),
      mk({ id: 'demo-004', name: 'Gurgaon Industrial Estate — Shed 14B', type: 'Industrial Shed', grade: 'Grade B', city: 'Gurugram', locality: 'Sector 37', rate: 18, area: 22500, ch: 8, dk: 2, pw: 250, icon: '🏗️', owner: 'Harpreet Singh', views: 430, at: '2026-06-25T09:00:00Z',
        desc: 'Independent industrial shed on a gated estate in Sector 37, Gurugram. Suits light manufacturing, assembly, or regional distribution. Three-phase power with sanctioned load of 250 kVA.' }),
      mk({ id: 'demo-005', name: 'Hoskote Logistics Park — Phase II', type: 'Logistics Park', grade: 'Grade A', city: 'Bengaluru', locality: 'Hoskote', rate: 31, area: 64000, ch: 13, dk: 10, pw: 600, icon: '🚛', owner: 'Embassy Industrial', views: 1580, at: '2026-07-01T09:00:00Z',
        ft: ['Truck Parking Court', 'Dock Levellers', 'ESFR Sprinklers', '24×7 Security'],
        desc: 'Institutional-grade logistics park on NH-75 with a dedicated truck court and 10 dock-levelled bays. ESFR sprinkler system throughout. Phase II offers flexible demising from 20,000 sq ft upward.' }),
      mk({ id: 'demo-006', name: 'Andheri Dark Store Hub — Q-Commerce Ready', type: 'Dark Store', grade: 'Grade A', city: 'Mumbai', locality: 'Andheri East', rate: 55, area: 4800, ch: 6, dk: 2, pw: 200, icon: '🛒', owner: 'Quick Retail Pvt Ltd', views: 1920, at: '2026-07-05T09:00:00Z',
        ft: ['Last-mile Ready', 'Cold Zone', 'Two-wheeler Bay', 'CCTV'],
        desc: 'Purpose-fitted dark store for quick commerce, 8 minutes from Andheri station. Includes a chilled zone, two-wheeler loading bay for 40+ riders, and a fit-out already compliant with major q-commerce operator specs.' }),
      mk({ id: 'demo-007', name: 'Sriperumbudur Auto Ancillary Shed', type: 'Industrial Shed', grade: 'Grade B', city: 'Chennai', locality: 'Sriperumbudur', rate: 19, area: 41000, ch: 10, dk: 5, pw: 400, icon: '🏗️', owner: 'TN Industrial Estates', views: 660, at: '2026-07-09T09:00:00Z',
        desc: 'Auto-ancillary shed inside the Sriperumbudur belt, minutes from major OEM plants. EOT crane provision, heavy floor loading, and dedicated trailer parking.' }),
      mk({ id: 'demo-008', name: 'Nashik Cold Chain Facility', type: 'Cold Storage', grade: 'Cold Chain', city: 'Nashik', locality: 'Sinnar MIDC', rate: 38, area: 18000, ch: 9, dk: 3, pw: 700, icon: '❄️', owner: 'Agro Cold Pvt Ltd', views: 380, at: '2026-07-12T09:00:00Z',
        ft: ['Controlled Atmosphere', 'Pre-cooling Chamber', 'Grading Line'],
        desc: 'Controlled-atmosphere storage built for horticulture — grapes, onion, and pomegranate. On-site pre-cooling and grading line, with direct access to the Nashik–Mumbai corridor.' }),
      mk({ id: 'demo-009', name: 'Luhari Logistics Yard — Block A', type: 'Logistics Park', grade: 'Grade B', city: 'Gurugram', locality: 'Luhari', rate: 16, area: 96000, ch: 11, dk: 12, pw: 550, icon: '🚛', owner: 'North Logistics LLP', views: 520, at: '2026-07-15T09:00:00Z',
        desc: 'Large-format yard on the KMP Expressway with 12 docks and generous trailer circulation. Priced for bulk storage and cross-dock operations rather than premium fit-out.' }),
      mk({ id: 'demo-010', name: 'Hyderabad Pharma Grade Warehouse', type: 'Warehouse', grade: 'Grade A', city: 'Hyderabad', locality: 'Medchal', rate: 26, area: 55000, ch: 12, dk: 7, pw: 480, icon: '🏭', owner: 'Genome Estates', views: 1010, at: '2026-07-18T09:00:00Z',
        ft: ['GMP Compliant', 'Temperature Mapped', 'Validated Storage', 'CCTV'],
        desc: 'GMP-compliant warehousing with full temperature mapping and validation documentation. Built for pharmaceutical distribution serving the Genome Valley cluster.' }),

      /* Awaiting admin review — these appear in the approval queue */
      mk({ id: 'demo-011', name: 'Panvel Industrial Park — Plot 22', type: 'Industrial Land', grade: 'Land', city: 'Navi Mumbai', locality: 'Panvel', rate: 22, area: 80000, icon: '🏞️', owner: 'Ramesh Kulkarni', status: 'pending', at: '2026-07-19T09:00:00Z',
        ft: ['MIDC Approved', 'Road Frontage', 'Water Connection'],
        desc: 'Freehold industrial plot with MIDC approval and 60m road frontage. Suitable for built-to-suit development. Water and power connections already sanctioned.' }),
      mk({ id: 'demo-012', name: 'Ahmedabad Textile Storage — Sanand', type: 'Warehouse', grade: 'Grade B', city: 'Ahmedabad', locality: 'Sanand', rate: 15, area: 38000, ch: 9, dk: 4, pw: 300, icon: '🏭', owner: 'Sanand Warehousing Co', status: 'pending', at: '2026-07-22T09:00:00Z',
        desc: 'Textile and general storage near the Sanand industrial belt, close to the Tata Nano plant corridor. Competitive rate for bulk requirements above 20,000 sq ft.' }),
      mk({ id: 'demo-013', name: 'Kolkata Riverside Distribution Centre', type: 'Warehouse', grade: 'Grade B', city: 'Kolkata', locality: 'Dankuni', rate: 17, area: 47000, ch: 10, dk: 5, pw: 350, icon: '🏭', owner: 'Bengal Logistics', status: 'pending', at: '2026-07-25T09:00:00Z',
        desc: 'Distribution centre at Dankuni with direct access to NH-19 and the Kolkata port road. Suits FMCG and e-commerce regional distribution for East India.' }),

      /* Previously rejected */
      mk({ id: 'demo-014', name: 'Wagholi Storage Shed', type: 'Industrial Shed', grade: 'Grade C', city: 'Pune', locality: 'Wagholi', rate: 12, area: 9000, ch: 6, dk: 1, pw: 100, icon: '🏗️', owner: 'Anon Seller', status: 'rejected', at: '2026-07-08T09:00:00Z',
        reason: 'Ownership documents missing; quoted rate inconsistent with locality benchmark.',
        desc: 'Small storage shed on the Pune–Nagar road.' })
    ];
  }

  function props() {
    var rows = read(K.props, null);
    if (!rows || !rows.length) { rows = seed(); write(K.props, rows); }
    return rows;
  }
  function saveProps(rows) {
    write(K.props, rows);
    global.dispatchEvent(new CustomEvent('bpsf:properties', { detail: { items: rows } }));
  }

  /* ── users & session ── */
  function users() { return read(K.users, []); }
  function session() { return read(K.session, null); }

  function setSession(user) {
    write(K.session, user);
    return { accessToken: 'demo.' + user.id, user: user };
  }

  function adminUser() {
    return { id: 'demo-admin', name: '99Warehousing Admin', email: 'admin@99warehousing.local', role: 'admin', isVerified: true, authProvider: 'local' };
  }

  function audit(action, entityId, before, after) {
    var rows = read(K.audit, []);
    var s = session();
    rows.unshift({
      _id: uid('a'), action: action, entity: 'property', entityId: entityId,
      actorEmail: (s && s.email) || 'admin@99warehousing.local',
      before: before || null, after: after || null, createdAt: nowISO()
    });
    write(K.audit, rows.slice(0, 200));
  }

  var err = function (status, message) { var e = new Error(message); e.status = status; return e; };

  /* ── query helper (also used directly by warehouses.html) ── */
  function query(f) {
    f = f || {};
    var items = props().filter(function (p) { return p.status === 'approved'; });

    if (f.city) {
      var c = String(f.city).toLowerCase();
      items = items.filter(function (p) { return (p.city + ' ' + p.locality).toLowerCase().indexOf(c) > -1; });
    }
    if (f.type) items = items.filter(function (p) { return p.type === f.type; });
    if (f.grade) items = items.filter(function (p) { return p.grade === f.grade; });
    if (f.minArea) items = items.filter(function (p) { return p.area >= +f.minArea; });
    if (f.minRate) items = items.filter(function (p) { return p.rate >= +f.minRate; });
    if (f.maxRate) items = items.filter(function (p) { return p.rate <= +f.maxRate; });
    if (f.q) {
      var q = String(f.q).toLowerCase();
      items = items.filter(function (p) { return (p.name + ' ' + p.location).toLowerCase().indexOf(q) > -1; });
    }

    var sorts = {
      'rate-asc': function (a, b) { return a.rate - b.rate; },
      'rate-desc': function (a, b) { return b.rate - a.rate; },
      'area-desc': function (a, b) { return b.area - a.area; },
      'newest': function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); }
    };
    items.sort(sorts[f.sort] || sorts.newest);

    var total = items.length;
    var limit = +f.limit || 12;
    var page = +f.page || 1;
    return {
      items: items.slice((page - 1) * limit, page * limit),
      total: total, page: page, limit: limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      demo: true
    };
  }

  function find(id) {
    return props().filter(function (p) { return p.id === id; })[0] || null;
  }

  /* ── requireAuth / requireAdmin, mirroring the server's guards ── */
  function requireUser() {
    var s = session();
    if (!s) throw err(401, 'Sign in to continue.');
    return s;
  }
  function requireAdmin() {
    var s = requireUser();
    if (s.role !== 'admin') throw err(403, 'This action requires the admin role.');
    return s;
  }

  /* ============================================================
     Router — mirrors server/src/routes/*
     ============================================================ */
  function route(method, path, body, q) {
    body = body || {};
    q = q || {};

    /* ── auth ── */
    if (method === 'POST' && path === '/auth/register') {
      if (!body.name) throw err(400, 'Name is required.');
      if (!body.email) throw err(400, 'Enter a valid email.');
      if (!body.password || body.password.length < 8) throw err(400, 'Password must be at least 8 characters.');
      var all = users();
      if (all.some(function (u) { return u.email === body.email.toLowerCase(); })) {
        throw err(409, 'That email is already registered.');
      }
      var user = {
        id: uid('u'), name: body.name, email: body.email.toLowerCase(),
        mobile: body.mobile || '', company: body.company || '',
        role: ['buyer', 'owner', 'agency'].indexOf(body.accountType) > -1 ? body.accountType : 'buyer',
        isVerified: true, authProvider: 'local', password: body.password,
        createdAt: nowISO()
      };
      all.push(user); write(K.users, all);
      var pub = Object.assign({}, user); delete pub.password;
      return setSession(pub);
    }

    if (method === 'POST' && path === '/auth/login') {
      var hit = users().filter(function (u) {
        return u.email === String(body.email || '').toLowerCase() && u.password === body.password;
      })[0];
      if (!hit) throw err(401, 'Incorrect email or password.');
      var p2 = Object.assign({}, hit); delete p2.password;
      return setSession(p2);
    }

    if (method === 'POST' && path === '/auth/admin') {
      if (String(body.passkey) !== ADMIN_PASSKEY) throw err(401, 'Incorrect admin passkey.');
      return setSession(adminUser());
    }

    if (method === 'POST' && path === '/auth/refresh') {
      var s = session();
      if (!s) throw err(401, 'No active session.');
      return { accessToken: 'demo.' + s.id, user: s };
    }

    if (method === 'POST' && path === '/auth/logout') {
      write(K.session, null);
      return { ok: true };
    }

    if (method === 'GET' && path === '/auth/me') {
      return { user: requireUser() };
    }

    /* ── properties ── */
    if (method === 'GET' && path === '/properties') return query(q);

    if (method === 'GET' && path === '/properties/mine') {
      var me = requireUser();
      return { items: props().filter(function (p) { return p.ownerEmail === me.email; }) };
    }

    var pm = path.match(/^\/properties\/([^/]+)$/);
    if (pm) {
      var prop = find(pm[1]);
      if (!prop) throw err(404, 'Property not found.');

      if (method === 'GET') {
        var s3 = session();
        var mayView = prop.status === 'approved' || (s3 && (s3.role === 'admin' || s3.email === prop.ownerEmail));
        if (!mayView) throw err(404, 'Property not found.');
        var rows = props();
        rows.forEach(function (r) { if (r.id === prop.id) r.views = (r.views || 0) + 1; });
        write(K.props, rows);
        return { item: prop };
      }
      if (method === 'PATCH') {
        var u4 = requireUser();
        if (u4.role !== 'admin' && u4.email !== prop.ownerEmail) throw err(403, 'You can only edit your own listings.');
        var rows4 = props().map(function (r) {
          if (r.id !== prop.id) return r;
          var next = Object.assign({}, r, body);
          if (u4.role !== 'admin') { next.status = 'pending'; next.isVerified = false; }
          return next;
        });
        saveProps(rows4);
        return { item: find(prop.id) };
      }
      if (method === 'DELETE') {
        var u5 = requireUser();
        if (u5.role !== 'admin' && u5.email !== prop.ownerEmail) throw err(403, 'You can only delete your own listings.');
        saveProps(props().filter(function (r) { return r.id !== prop.id; }));
        return { ok: true };
      }
    }

    if (method === 'POST' && path === '/properties') {
      var owner = requireUser();
      if (!body.name) throw err(400, 'Property title is required.');
      if (!(+body.rate > 0)) throw err(400, 'Rate must be greater than zero.');
      if (!(+body.area > 0)) throw err(400, 'Area must be greater than zero.');
      var rec = {
        id: uid('p'), slug: uid('p'), name: body.name,
        type: body.type || 'Warehouse', grade: body.grade || 'Grade B', listingType: 'rent',
        city: body.city || '', locality: body.locality || '',
        location: [body.locality, body.city].filter(Boolean).join(', '),
        rate: +body.rate, area: +body.area, depositMonths: 3, icon: '🏭',
        specs: { clearHeight: body.clearHeight || null, loadingDocks: body.loadingDocks || null, power: null, features: [] },
        description: body.description || '',
        ownerName: owner.name, ownerEmail: owner.email,
        status: 'pending', isVerified: false, rejectionReason: '',
        views: 0, enquiryCount: 0, createdAt: nowISO()
      };
      var rows5 = props(); rows5.push(rec); saveProps(rows5);
      audit('property.submitted', rec.id, null, { name: rec.name, rate: rec.rate });
      return { item: rec };
    }

    /* ── uploads ──
       No server to store bytes, so files become object URLs that live only
       for this page session. Enough to preview the flow; real uploads need
       the Next.js backend running. */
    if (method === 'POST' && path === '/upload') {
      requireUser();
      var picked = [];
      if (body && typeof body.getAll === 'function') picked = body.getAll('files');
      if (!picked.length) throw err(400, 'No files were attached.');

      return {
        files: picked.map(function (f, i) {
          return {
            url: (global.URL && URL.createObjectURL) ? URL.createObjectURL(f) : '',
            publicId: 'demo-' + Date.now() + '-' + i,
            storage: 'local',
            bytes: f.size,
            format: (f.name || '').split('.').pop(),
            isPrimary: i === 0
          };
        }),
        storage: 'demo'
      };
    }

    /* ── favourites ── */
    if (path === '/favorites' && method === 'GET') {
      requireUser();
      var ids = read(K.favs, []);
      return { items: props().filter(function (p) { return ids.indexOf(p.id) > -1; }) };
    }
    var fm = path.match(/^\/favorites\/([^/]+)$/);
    if (fm) {
      requireUser();
      var favs = read(K.favs, []);
      if (method === 'POST' && favs.indexOf(fm[1]) === -1) favs.push(fm[1]);
      if (method === 'DELETE') favs = favs.filter(function (i) { return i !== fm[1]; });
      write(K.favs, favs);
      return { ok: true, favorited: method === 'POST', count: favs.length };
    }

    /* ── enquiries ── */
    if (method === 'POST' && path === '/enquiries') {
      if (!body.name) throw err(400, 'Your name is required.');
      if (!body.email || body.email.indexOf('@') === -1) throw err(400, 'Enter a valid email.');
      var target = find(body.propertyId);
      var list = read(K.enq, []);
      var e2 = {
        _id: uid('e'), property: body.propertyId || null,
        propertyName: target ? target.name : (body.subject || 'General enquiry'),
        name: body.name, email: body.email, mobile: body.mobile || '',
        company: body.company || '', message: body.message || '',
        stage: 'new', createdAt: nowISO()
      };
      list.unshift(e2); write(K.enq, list);
      if (target) {
        var rows6 = props();
        rows6.forEach(function (r) { if (r.id === target.id) r.enquiryCount = (r.enquiryCount || 0) + 1; });
        write(K.props, rows6);
      }
      return { ok: true, id: e2._id };
    }
    if (method === 'GET' && path === '/enquiries/mine') {
      var me7 = requireUser();
      var mine = props().filter(function (p) { return p.ownerEmail === me7.email; }).map(function (p) { return p.id; });
      return { items: read(K.enq, []).filter(function (e) { return mine.indexOf(e.property) > -1; }) };
    }

    /* ── admin ── */
    if (path.indexOf('/admin/') === 0) {
      requireAdmin();

      if (method === 'GET' && path === '/admin/stats') {
        var all8 = props();
        var by = function (s) { return all8.filter(function (p) { return p.status === s; }).length; };
        return {
          total: all8.length, pending: by('pending'), approved: by('approved'), rejected: by('rejected'),
          users: users().length + 1, enquiries: read(K.enq, []).length
        };
      }

      if (method === 'GET' && path === '/admin/properties') {
        var rows9 = props().slice();
        if (q.status && q.status !== 'all') rows9 = rows9.filter(function (p) { return p.status === q.status; });
        if (q.q) {
          var qq = String(q.q).toLowerCase();
          rows9 = rows9.filter(function (p) {
            return (p.name + ' ' + p.location + ' ' + p.ownerName + ' ' + p.type).toLowerCase().indexOf(qq) > -1;
          });
        }
        rows9.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
        return { items: rows9.map(function (p) { return Object.assign({}, p, { submitted: p.createdAt }); }) };
      }

      if (method === 'GET' && path === '/admin/users') {
        return { items: [adminUser()].concat(users().map(function (u) { var c = Object.assign({}, u); delete c.password; return c; })) };
      }
      if (method === 'GET' && path === '/admin/enquiries') return { items: read(K.enq, []) };
      if (method === 'GET' && path === '/admin/audit') return { items: read(K.audit, []) };

      if (method === 'POST' && path === '/admin/properties') {
        if (!body.name) throw err(400, 'Property title is required.');
        if (!(+body.rate > 0)) throw err(400, 'Rate must be greater than zero.');
        if (!(+body.area > 0)) throw err(400, 'Area must be greater than zero.');
        var st = body.status || 'approved';
        var rec2 = {
          id: uid('p'), slug: uid('p'), name: body.name,
          type: body.type || 'Warehouse', grade: body.grade || 'Grade B', listingType: 'rent',
          city: body.city || '', locality: body.locality || '',
          location: [body.locality, body.city].filter(Boolean).join(', '),
          rate: +body.rate, area: +body.area, depositMonths: 3, icon: '🏭',
          specs: { clearHeight: null, loadingDocks: null, power: null, features: [] },
          description: body.description || '',
          ownerName: body.ownerName || 'Added by admin', ownerEmail: 'admin@99warehousing.local',
          status: st, isVerified: st === 'approved', rejectionReason: '',
          views: 0, enquiryCount: 0, createdAt: nowISO()
        };
        var rowsA = props(); rowsA.push(rec2); saveProps(rowsA);
        audit('property.created', rec2.id, null, { name: rec2.name });
        return { item: rec2 };
      }

      var am = path.match(/^\/admin\/properties\/([^/]+?)(?:\/(approve|reject))?$/);
      if (am) {
        var id = am[1], act = am[2];
        var target2 = find(id);
        if (!target2) throw err(404, 'Property not found.');
        var before = { status: target2.status, name: target2.name, rate: target2.rate };

        if (act === 'approve' && method === 'PATCH') {
          saveProps(props().map(function (r) {
            return r.id !== id ? r : Object.assign({}, r, { status: 'approved', isVerified: true, rejectionReason: '' });
          }));
          audit('property.approved', id, before, { status: 'approved' });
          return { item: find(id) };
        }
        if (act === 'reject' && method === 'PATCH') {
          if (!body.reason || !String(body.reason).trim()) throw err(400, 'A rejection reason is required.');
          saveProps(props().map(function (r) {
            return r.id !== id ? r : Object.assign({}, r, { status: 'rejected', isVerified: false, rejectionReason: body.reason });
          }));
          audit('property.rejected', id, before, { status: 'rejected', reason: body.reason });
          return { item: find(id) };
        }
        if (!act && method === 'PATCH') {
          if (body.name !== undefined && !String(body.name).trim()) throw err(400, 'Property name is required.');
          if (body.rate !== undefined && !(+body.rate > 0)) throw err(400, 'Rate must be greater than zero.');
          if (body.area !== undefined && !(+body.area > 0)) throw err(400, 'Area must be greater than zero.');
          saveProps(props().map(function (r) {
            if (r.id !== id) return r;
            var next = Object.assign({}, r, body);
            next.rate = +next.rate; next.area = +next.area;
            next.location = [next.locality, next.city].filter(Boolean).join(', ');
            next.isVerified = next.status === 'approved';
            return next;
          }));
          audit('property.edited', id, before, { name: body.name, rate: body.rate, status: body.status });
          return { item: find(id) };
        }
        if (!act && method === 'DELETE') {
          saveProps(props().filter(function (r) { return r.id !== id; }));
          audit('property.deleted', id, before, null);
          return { ok: true };
        }
      }
    }

    /* ── misc ── */
    if (method === 'GET' && path === '/config') {
      return { googleMapsApiKey: null, features: { googleAuth: false, uploads: false, email: false, sms: false }, demo: true };
    }
    if (method === 'GET' && path === '/health') return { status: 'demo', time: nowISO() };

    throw err(404, 'No demo handler for ' + method + ' ' + path);
  }

  /* True once the demo backend has actually answered something. The
     dashboard reads it to label its toasts, so a moderator is never told a
     change is "live on the site" when it only reached this browser. */
  var engaged = false;

  /* Entry point used by api.js. Always returns a Promise, like fetch. */
  function handle(method, path, body, q) {
    engaged = true;
    try { return Promise.resolve(route(method, path, body, q)); }
    catch (e) { return Promise.reject(e); }
  }

  /* The demo-mode banner that used to appear along the bottom of every
     page has been removed. It existed to warn that the data on screen was
     fabricated — which was the right thing to do while demo data could
     engage on its own. It no longer can: api.js keeps the fallback off
     unless it is explicitly asked for, so there is nothing to warn about
     on a normal page load. */

  function reset() {
    [K.props, K.favs, K.enq, K.audit].forEach(function (k) {
      try { canPersist ? localStorage.removeItem(k) : delete mem[k]; } catch (e) {}
    });
    props();
    return { ok: true };
  }

  global.BPSFDemo = {
    handle: handle,
    query: query,
    find: find,
    properties: props,
    reset: reset,
    isEngaged: function () { return engaged; },
    ADMIN_PASSKEY: ADMIN_PASSKEY
  };
})(window);
