'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { q } = require('./db');
const L = require('./lib');
const A = require('./auth');

const router = new L.Router();
for (const m of ['auth', 'admin', 'content', 'learn', 'classes']) require('./routes/' + m)(router);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

// Map database-trigger failures (the last line of defence) to friendly client errors.
const DB_MESSAGES = {
  'limit:main_admins': [409, 'The maximum of 5 main administrators (including the Chief Administrator) has been reached.'],
  'limit:supervisors': [409, 'The maximum of 200 subject supervisors has been reached.'],
  'limit:teachers': [409, 'The maximum of 5,000 approved teachers has been reached.'],
  'limit:supervisor_subjects': [409, 'A supervisor can be assigned at most 4 subjects.'],
  chief_protected: [403, 'The Chief Administrator account is protected.'],
  chief_exists: [409, 'A Chief Administrator already exists.'],
  chief_not_assignable: [403, 'The Chief Administrator role cannot be assigned.'],
  'workflow:publish_requires_approved': [409, 'Content must be approved before it can be published.'],
  'workflow:approver_required': [409, 'An approver must be recorded.'],
  'workflow:publisher_required': [409, 'A publisher must be recorded.'],
  'frozen:content_not_editable': [409, 'Approved, published and archived content is locked. Reopen it first.'],
  'audit:immutable': [403, 'Audit records cannot be changed.'],
};

function decorateResponse(res) {
  res.cookies = [];
  res.setCookie = (c) => res.cookies.push(c);
  const flush = (status, headers) => { if (res.cookies.length) headers['Set-Cookie'] = res.cookies; res.writeHead(status, headers); };
  res.json = (a, b) => {
    res.handled = true;
    const status = typeof a === 'number' ? a : 200; const body = typeof a === 'number' ? b : a;
    const data = JSON.stringify(body === undefined ? {} : body);
    flush(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  res.sendFile = (file, headers = {}) => {
    res.handled = true;
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
      flush(200, { 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', ...headers });
      fs.createReadStream(file).pipe(res);
    });
  };
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // unknown /api paths are real 404s; anything else falls back to the SPA shell
      if (pathname.startsWith('/api/')) return res.json(404, { error: 'Not found.' });
      return res.sendFile(path.join(cfg.PUBLIC_DIR, 'index.html'), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    }
    const ext = path.extname(file).toLowerCase();
    res.sendFile(file, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': pathname === '/sw.js' || ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  });
}

const server = http.createServer(async (req, res) => {
  decorateResponse(res);
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (cfg.SECURE_COOKIES) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    const url = new URL(req.url, 'http://x');
    req.query = Object.fromEntries(url.searchParams);
    req.ip = L.clientIp(req);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('Method not allowed'); }
      return serveStatic(req, res, decodeURIComponent(pathname));
    }
    // CSRF: state-changing API calls must come from our own origin
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch {} if (!ok) throw L.forbidden('Cross-site request blocked.'); }
    }
    const m = router.match(req.method, pathname);
    if (!m.route) throw m.pathMatched ? new L.HttpError(405, 'Method not allowed.') : L.notFound('Not found.');
    A.loadUser(req);
    await L_parse(req);
    req.params = m.params;
    for (const h of m.route.handlers) {
      await h(req, res);
      if (res.handled || res.headersSent) return; // json()/sendFile() mark the response as handled
    }
    throw new Error('Handler did not respond');
  } catch (e) { handleError(e, req, res); }
});

async function L_parse(req) {
  const big = req.url.includes('/api/content/') || req.url.includes('/profile/avatar');
  await L.parseRequest(req, big ? cfg.MAX_BODY_BYTES : 1024 * 1024);
}

function handleError(e, req, res) {
  res.handled = false;
  if (res.headersSent) { try { res.end(); } catch {} return; }
  if (e instanceof L.HttpError) return res.json(e.status, { error: e.message, ...(e.extra || {}) });
  const dbm = DB_MESSAGES[String(e && e.message || '').replace(/^.*?(limit:\w+|chief_\w+|workflow:\w+|frozen:\w+|audit:\w+).*$/, '$1')];
  if (dbm) return res.json(dbm[0], { error: dbm[1] });
  if (e && /UNIQUE constraint failed/.test(e.message)) return res.json(409, { error: 'That already exists.' });
  if (e && /CHECK constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint/.test(e.message)) return res.json(400, { error: 'The request was not valid.' });
  console.error('[error]', req.method, req.url, e && e.stack || e); // details stay in the server log, never in the response
  res.json(500, { error: 'Something went wrong on our side. Please try again.' });
}

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`Gambia Exam Success listening on http://${cfg.HOST}:${cfg.PORT}`);
    if (!q.get('SELECT 1 FROM users WHERE is_chief=1')) console.log("No Chief Administrator yet. Run: CHIEF_PASSWORD='...' node scripts/provision-chief.js");
  });
  // purge old sessions and tokens daily
  setInterval(() => {
    q.run('DELETE FROM sessions WHERE revoked=1 OR last_seen < ?', Date.now() - 450 * 86400e3);
    q.run('DELETE FROM reset_tokens WHERE expires_at < ?', Date.now() - 86400e3);
  }, 24 * 3600e3).unref();
}

module.exports = { server };
