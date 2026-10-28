'use strict';
const crypto = require('crypto');
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, extra) => new HttpError(400, m, extra);
const unauthorized = (m = 'Please log in.') => new HttpError(401, m);
const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
const notFound = (m = 'Not found.') => new HttpError(404, m);

// ---- router ---------------------------------------------------------------
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  del(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

// ---- cookies ----------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieString(name, value, { maxAgeMs, clear } = {}) {
  let s = `${name}=${clear ? '' : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (cfg.SECURE_COOKIES) s += '; Secure';
  if (clear) s += '; Max-Age=0';
  else if (maxAgeMs) s += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
  return s;
}

// ---- body parsing -------------------------------------------------------------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'Upload is too large.')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw bad('Malformed upload.');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; const files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw bad('Malformed upload.');
  while (pos >= 0) {
    pos += boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;            // closing --
    if (buf[pos] === 0x0d) pos += 2;                                    // CRLF
    const next = buf.indexOf(boundary, pos);
    if (next < 0) break;
    const part = buf.subarray(pos, next - 2);                           // strip trailing CRLF
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd >= 0) {
      const head = part.subarray(0, hEnd).toString('utf8');
      const body = part.subarray(hEnd + 4);
      const name = /name="([^"]*)"/i.exec(head);
      const fn = /filename="([^"]*)"/i.exec(head);
      const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
      if (name) {
        if (fn && fn[1] !== '') files.push({ field: name[1], filename: fn[1], mime: ct ? ct[1].trim().toLowerCase() : 'application/octet-stream', data: Buffer.from(body) });
        else if (!fn) fields[name[1]] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

async function parseRequest(req, limit) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') { req.body = {}; req.files = []; return; }
  const raw = await readBody(req, limit);
  req.rawBody = raw; // needed to verify signed webhooks
  if (ct.startsWith('multipart/form-data')) {
    const { fields, files } = parseMultipart(raw, req.headers['content-type']);
    req.body = fields; req.files = files;
  } else if (ct.startsWith('application/json')) {
    try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw bad('Invalid JSON.'); }
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('Invalid JSON body.');
    req.files = [];
  } else if (ct.startsWith('application/x-www-form-urlencoded')) {
    req.body = Object.fromEntries(new URLSearchParams(raw.toString('utf8'))); req.files = [];
  } else { req.body = {}; req.files = []; }
}

// ---- rate limiting (in-memory sliding window) ---------------------------------
const buckets = new Map();
function rateLimit(name, max, windowMs, keyFn) {
  return (req) => {
    const key = name + ':' + (keyFn ? keyFn(req) : req.ip);
    const now = Date.now();
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    arr.push(now);
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) { if (!arr.length || arr[arr.length - 1] < now - 3600e3) buckets.delete(k); }
}, 600e3).unref();
function resetRateLimits() { buckets.clear(); }

// ---- passwords & tokens --------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, s, h] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
  } catch { return false; }
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---- validation helpers -----------------------------------------------------------
function str(v, { min = 0, max = 5000, name = 'Field', required = false } = {}) {
  if (v == null || v === '') { if (required) throw bad(`${name} is required.`); return ''; }
  if (typeof v !== 'string') throw bad(`${name} is invalid.`);
  const s = v.trim();
  if (required && s.length < Math.max(min, 1)) throw bad(`${name} is required.`);
  if (s.length < min) throw bad(`${name} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
}
function int(v, { min = -Infinity, max = Infinity, name = 'Value', required = true } = {}) {
  if (v == null || v === '') { if (required) throw bad(`${name} is required.`); return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} is invalid.`);
  return n;
}
function normEmail(v) {
  const s = (v || '').trim().toLowerCase();
  if (!s) return null;
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('Please enter a valid email address.');
  return s;
}
/** Gambian numbers: +220 followed by 7 digits. Accepts "7012345", "220 701 2345", "+2207012345". */
function normPhone(v) {
  let s = (v || '').replace(/[\s\-()]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('220')) s = s.slice(3);
  if (!/^[2-9]\d{6}$/.test(s)) throw bad('Enter a valid Gambian phone number (+220 followed by 7 digits).');
  return '+220' + s;
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters.');
  if (pw.length > 200) throw bad('Password is too long.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw bad('Password must include at least one letter and one number.');
}

// ---- file validation (magic bytes, not the client-supplied type) ----------------------
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return { mime: 'application/vnd.openxmlformats-officedocument', ext: '.docx' };
  return null;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

module.exports = {
  HttpError, bad, unauthorized, forbidden, notFound, Router, parseCookies, cookieString, parseRequest,
  rateLimit, resetRateLimits, hashPassword, verifyPassword, DUMMY_HASH, sha256, newToken, str, int,
  normEmail, normPhone, checkPassword, sniff, clientIp,
};
