'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ges-test-'));
process.env.DATA_DIR = DATA;
process.env.TRUST_PROXY = '0';

const db = require('../server/db');
const L = require('../server/lib');
const auth = require('../server/auth');
const { server } = require('../server/index');

let base;
async function start() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
function stop() { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); }

function multipart(fields = {}, files = []) {
  const b = '----ges' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${f.field || 'file'}"; filename="${f.name}"\r\nContent-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`));
    parts.push(f.data); parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

class Client {
  constructor(label) { this.label = label; this.cookie = ''; }
  async req(method, url, body, { form, raw, headers } = {}) {
    const h = { ...(headers || {}) };
    if (this.cookie) h.cookie = this.cookie;
    let payload;
    if (form) { payload = form.body; h['content-type'] = form.contentType; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (/=$/.test(kv)) this.cookie = ''; else this.cookie = kv; }
    if (raw) return res;
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b === undefined ? {} : b, o); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
  async login(identifier, password) { L.resetRateLimits(); return this.post('/api/auth/login', { identifier, password }); }
}

let n = 0;
async function newStudent(label) {
  L.resetRateLimits();
  const c = new Client(label); n++;
  const r = await c.post('/api/auth/register', { full_name: `Test ${label}`, school: 'Test School', email: `${label.toLowerCase()}${n}@example.com`, password: 'Passw0rdTest' });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.json));
  c.id = r.json.user.id; c.email = `${label.toLowerCase()}${n}@example.com`; c.password = 'Passw0rdTest';
  return c;
}
/** Create a user with a given staff role directly in the DB (as an operator would) and log them in. */
async function newStaff(label, role, { subjects = [], can_publish = 0 } = {}) {
  const c = await newStudent(label);
  db.setRoleForTest = null;
  db.db.prepare('UPDATE users SET role=?, can_publish=? WHERE id=?').run(role, can_publish, c.id);
  for (const s of subjects) db.db.prepare('INSERT INTO supervisor_subjects(user_id,subject_id) VALUES(?,?)').run(c.id, s);
  await c.login(c.email, c.password);
  return c;
}

module.exports = { db, L, auth, start, stop, Client, multipart, newStudent, newStaff, DATA, fixture: (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f)) };
