'use strict';
/* Core: safe DOM builder, API client, router, shell. All user-supplied text goes through textContent, never innerHTML. */
window.GES = (function () {
  const G = { me: null, prefs: { scroll_mode: 1, page_mode: 0, font_scale: 1 }, unread: 0, routes: [], views: {} };

  // ---------- DOM ----------
  // Make Element.append() accept arrays and ignore null/undefined/false, exactly like el() does,
  // so `node.append(items.map(...), cond && child)` never prints "[object …]" or "null".
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function (...kids) {
    nativeAppend.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map((k) => (k instanceof Node ? k : String(k))));
  };
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'required' || k === 'open') { if (v) n.setAttribute(k, ''); n[k] = !!v; }
      else n.setAttribute(k, v === true ? '' : v);
    }
    append(n, kids);
    return n;
  }
  function append(n, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

  const ICONS = {
    home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
    book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zM4 19a2 2 0 012-2h13',
    chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
    chat: 'M4 5h16v11H9l-5 4V5z',
    users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 100-6M21 20c0-2-1.5-3.6-4-4.4',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    check: 'M5 13l4 4L19 7',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
    staff: 'M12 3l9 4-9 4-9-4 9-4zM7 10v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5',
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name] || ICONS.book); s.appendChild(p); return s;
  }
  function logo() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 512 512'); s.setAttribute('class', 'logo'); s.setAttribute('aria-hidden', 'true');
    const mk = (t, a) => { const e = document.createElementNS('http://www.w3.org/2000/svg', t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); s.appendChild(e); };
    mk('rect', { width: 512, height: 512, rx: 104, fill: '#13315C' });
    mk('path', { d: 'M70 372c70-24 96-110 150-110 54 0 54 74 108 74 40 0 64-34 114-98', fill: 'none', stroke: '#D9A21B', 'stroke-width': 30, 'stroke-linecap': 'round' });
    mk('path', { d: 'M150 214 256 150l106 64-106 60z', fill: '#fff' });
    mk('path', { d: 'M196 252v50c0 18 28 32 60 32s60-14 60-32v-50l-60 34z', fill: '#fff', opacity: '.85' });
    return s;
  }

  // ---------- API ----------
  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opt); }
    catch { const e = new Error('Cannot reach the server. Check your internet connection and try again.'); e.offline = true; throw e; }
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error((data && data.error) || `Request failed (${res.status}).`); e.status = res.status; e.data = data;
      if (res.status === 401 && G.me) { G.me = null; toast('Your session ended. Please log in again.', 'bad'); location.hash = '#/login'; }
      throw e;
    }
    return data;
  }
  G.get = (u) => api('GET', u); G.post = (u, b) => api('POST', u, b === undefined ? {} : b); G.put = (u, b) => api('PUT', u, b); G.del = (u) => api('DELETE', u);

  // ---------- toasts & dialogs ----------
  function toast(msg, kind) {
    const t = el('div', { class: 'toast ' + (kind || ''), role: 'status', text: msg });
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
  }
  function dialog(build) {
    return new Promise((resolve) => {
      const d = el('dialog'); const inner = el('div', { class: 'in' }); d.appendChild(inner);
      const close = (v) => { d.close(); d.remove(); resolve(v); };
      build(inner, close);
      d.addEventListener('cancel', () => close(null));
      document.body.appendChild(d); d.showModal();
    });
  }
  function confirmBox(title, text, okLabel = 'Confirm', danger) {
    return dialog((box, close) => {
      box.append(
        el('h2', { text: title }), el('p', { text }),
        el('div', { class: 'row' },
          el('button', { class: 'btn ' + (danger ? 'danger' : ''), on: { click: () => close(true) }, text: okLabel }),
          el('button', { class: 'btn ghost', on: { click: () => close(false) }, text: 'Cancel' })));
    }).then((v) => !!v);
  }
  const promptBox = (title, label, { required = true, okLabel = 'Save', hint, multiline = true } = {}) => dialog((box, close) => {
    const inp = el(multiline ? 'textarea' : 'input', { id: 'pb', 'aria-label': label });
    const err = el('div', { class: 'err' });
    box.append(el('h2', { text: title }), el('label', { for: 'pb', text: label }), inp, hint && el('div', { class: 'hint', text: hint }), err,
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', { class: 'btn', on: { click: () => { if (required && !inp.value.trim()) { err.textContent = 'This is required.'; err.classList.add('show'); return; } close(inp.value.trim()); } }, text: okLabel }),
        el('button', { class: 'btn ghost', on: { click: () => close(null) }, text: 'Cancel' })));
    setTimeout(() => inp.focus(), 30);
  });

  // ---------- form helpers ----------
  function field(label, input, hint) { const id = 'f' + Math.random().toString(36).slice(2, 8); input.id = id; return el('div', null, el('label', { for: id, text: label }), input, hint && el('div', { class: 'hint', text: hint })); }
  function select(options, value, attrs) { return el('select', attrs, options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(value), text: o.label }))); }
  async function submitting(btn, fn, errBox) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    if (errBox) errBox.classList.remove('show');
    try { return await fn(); }
    catch (e) {
      if (errBox) { errBox.textContent = e.message + (e.data && e.data.problems ? '' : ''); errBox.classList.add('show'); errBox.scrollIntoView({ block: 'nearest' }); } else toast(e.message, 'bad');
      return undefined;
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  const fmtDate = (s) => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('T') || String(s).includes('Z') ? '' : 'Z')); return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const fmtTime = (s) => { const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const pill = (status) => el('span', { class: 'pill ' + status, text: ({ in_review: 'In Review', draft: 'Draft', approved: 'Approved', published: 'Published', rejected: 'Rejected', archived: 'Archived' })[status] || status });
  const empty = (title, text, action) => el('div', { class: 'empty' }, el('b', { text: title }), text && el('div', { text }), action);

  // ---------- router ----------
  function route(pattern, handler, opts = {}) {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    G.routes.push({ re, keys, handler, opts });
  }
  let renderToken = 0;
  async function navigate() {
    const token = ++renderToken;
    const path = (location.hash || '#/').slice(1) || '/';
    const [p] = path.split('?'); const query = Object.fromEntries(new URLSearchParams(path.split('?')[1] || ''));
    let hit = null;
    for (const r of G.routes) { const m = r.re.exec(p); if (m) { hit = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; } }
    if (!hit) hit = { r: { handler: () => G.views.notFound(), opts: {} }, params: {} };
    const { opts } = hit.r;
    if (opts.auth && !G.me) { sessionStorage.setItem('ges_next', location.hash); location.hash = '#/login'; return; }
    if (opts.roles && G.me && !opts.roles.includes(G.me.role)) { location.hash = '#/'; return; }
    G.cleanup && G.cleanup(); G.cleanup = null;
    const root = $('#root');
    try {
      const out = await hit.r.handler({ ...hit.params, query });
      if (token !== renderToken) return;
      mount(root, out, opts);
    } catch (e) {
      if (token !== renderToken) return;
      mount(root, { body: el('div', { class: 'card' }, el('h2', { text: 'We could not load this page' }), el('p', { text: e.message }), el('button', { class: 'btn', on: { click: navigate }, text: 'Try again' })) }, {});
    }
    window.scrollTo(0, G.keepScroll || 0); G.keepScroll = 0;
  }
  G.refresh = () => { G.keepScroll = window.scrollY; return navigate(); };
  function mount(root, out, opts) {
    clear(root);
    if (out && out.fullscreen) { root.appendChild(out.fullscreen); return; }
    root.append(shell());
    const main = el('main', { id: 'app', tabindex: '-1', class: out && out.wide ? 'wide' : '' }, out && out.body);
    root.appendChild(main);
    if (G.me && !(A_isStaff())) root.appendChild(tabbar());
    applyFont();
  }
  const A_isStaff = () => G.me && ['supervisor', 'admin', 'main_admin', 'chief'].includes(G.me.role);
  const isAdmin = () => G.me && ['admin', 'main_admin', 'chief'].includes(G.me.role);
  const isMain = () => G.me && ['main_admin', 'chief'].includes(G.me.role);
  function applyFont() { document.documentElement.style.fontSize = (16 * (G.prefs.font_scale || 1)) + 'px'; }

  function navItems() {
    const r = G.me && G.me.role;
    if (!r) return [];
    if (r === 'student') return [['#/', 'Home', 'home'], ['#/library', 'Library', 'book'], ['#/progress', 'Progress', 'chart'], ['#/tutor', 'AI tutor', 'chat'], ['#/classes', 'Classes', 'users']];
    if (r === 'teacher') return [['#/', 'Home', 'home'], ['#/library', 'Library', 'book'], ['#/teacher/content', 'My content', 'upload'], ['#/classes', 'Classes', 'users'], ['#/tutor', 'AI tutor', 'chat']];
    if (r === 'supervisor') return [['#/', 'Reviews', 'check'], ['#/library', 'Library', 'book']];
    return [['#/', 'Dashboard', 'shield'], ['#/library', 'Library', 'book']];
  }
  const here = () => (location.hash || '#/').split('?')[0];
  function shell() {
    const links = navItems();
    const initials = G.me ? G.me.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '';
    return el('header', { class: 'top' },
      el('a', { class: 'brand', href: G.me ? '#/' : '#/welcome' }, logo(), el('span', { text: 'Gambia Exam Success' })),
      el('nav', { 'aria-label': 'Main' }, links.map(([h, t]) => el('a', { href: h, 'aria-current': here() === h ? 'page' : undefined, text: t }))),
      G.me && el('div', { class: 'right' },
        el('a', { href: '#/notifications', class: 'linkbtn', 'aria-label': 'Notifications' }, 'Alerts', G.unread ? el('span', { class: 'badge', text: String(G.unread) }) : null),
        el('a', { href: '#/profile', class: 'avatar', 'aria-label': 'Your profile' }, G.me.has_avatar ? el('img', { src: `/api/profile/avatar/${G.me.id}`, alt: '', width: 34, height: 34 }) : initials)));
  }
  function tabbar() {
    return el('nav', { class: 'tabs', 'aria-label': 'Main' }, navItems().slice(0, 5).map(([h, t, i]) => el('a', { href: h, 'aria-current': here() === h ? 'page' : undefined }, icon(i), el('span', { text: t }))));
  }

  // ---------- session ----------
  async function loadMe() {
    try {
      const r = await G.get('/api/auth/me');
      G.me = r.user; if (r.prefs) G.prefs = r.prefs; G.unread = r.unread || 0; G.applications = r.applications || [];
      G.sessionExpired = !!r.session_expired; G.blocked = !!r.blocked;
    } catch (e) { G.me = null; G.offlineStart = !!e.offline; }
  }
  async function logout() {
    try { await G.post('/api/auth/logout'); } catch {}
    G.me = null; G.offlineClear && G.offlineClear(); // saved papers are removed from shared devices
    location.hash = '#/welcome'; navigate();
  }

  // ---------- offline copies (per user, removed at logout) ----------
  const okey = (id) => `ges:${G.me ? G.me.id : 'x'}:paper:${id}`;
  G.offlineSave = (id, data) => { try { localStorage.setItem(okey(id), JSON.stringify({ saved: Date.now(), data })); return true; } catch { return false; } };
  G.offlineLoad = (id) => { try { const v = JSON.parse(localStorage.getItem(okey(id)) || 'null'); return v && v.data; } catch { return null; } };
  G.offlineList = () => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(`ges:${G.me ? G.me.id : 'x'}:paper:`)) { try { const v = JSON.parse(localStorage.getItem(k)); out.push({ id: k.split(':')[3], title: v.data.paper.title, subject: v.data.paper.subject_name, year: v.data.paper.year, saved: v.saved }); } catch {} } } return out; };
  G.offlineRemove = (id) => localStorage.removeItem(okey(id));
  G.offlineClear = () => { const pre = 'ges:'; for (const k of Object.keys(localStorage)) if (k.startsWith(pre)) localStorage.removeItem(k); };

  Object.assign(G, { el, append, $, clear, icon, logo, api, toast, dialog, confirmBox, promptBox, field, select, submitting, fmtDate, fmtTime, pill, empty, route, navigate, mount, loadMe, logout, isAdmin, isMain, applyFont, isStaff: A_isStaff });
  return G;
})();
