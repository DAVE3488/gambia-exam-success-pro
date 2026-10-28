'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { q, tx, audit, notify, getSetting } = require('../db');
const L = require('../lib');
const A = require('../auth');

const loginLimit = L.rateLimit('login', 10, 10 * 60e3);
const loginAcctLimit = L.rateLimit('login-acct', 8, 10 * 60e3, (req) => String(req.body.identifier || '').toLowerCase());
const registerLimit = L.rateLimit('register', 10, 60 * 60e3);
const resetLimit = L.rateLimit('reset', 5, 60 * 60e3);

function findByIdentifier(id) {
  const s = (id || '').trim();
  if (!s) return null;
  if (s.includes('@')) return q.get('SELECT * FROM users WHERE email=?', s.toLowerCase());
  let phone; try { phone = L.normPhone(s); } catch { return null; }
  return q.get('SELECT * FROM users WHERE phone=?', phone);
}

module.exports = (r) => {
  r.post('/api/auth/register', registerLimit, (req, res) => {
    const b = req.body;
    const full_name = L.str(b.full_name, { min: 2, max: 100, name: 'Full name', required: true });
    const school = L.str(b.school, { min: 2, max: 150, name: 'School', required: true });
    const email = L.normEmail(b.email);
    const phone = L.normPhone(b.phone);
    if (!email && !phone) throw L.bad('Provide an email address or a Gambian phone number.');
    L.checkPassword(b.password);
    // The reserved chief address can never be claimed through public registration.
    if (email === cfg.CHIEF_EMAIL) throw L.bad('This email address is reserved. Please use a different one.');
    if (getSetting('require_phone_verification') === '1' && phone) {
      throw new L.HttpError(501, 'Phone verification is required but no SMS provider is configured on this server.');
    }
    if (email && q.get('SELECT 1 FROM users WHERE email=?', email)) throw L.bad('An account with this email already exists.');
    if (phone && q.get('SELECT 1 FROM users WHERE phone=?', phone)) throw L.bad('An account with this phone number already exists.');
    const id = tx(() => {
      const ins = q.run("INSERT INTO users(full_name,school,email,phone,pass_hash,role) VALUES(?,?,?,?,?,'student')",
        full_name, school, email, phone, L.hashPassword(b.password));
      const uid = Number(ins.lastInsertRowid);
      q.run('INSERT INTO prefs(user_id) VALUES(?)', uid);
      return uid;
    });
    const user = q.get('SELECT * FROM users WHERE id=?', id);
    const token = A.createSession(user, req);
    res.setCookie(A.sessionCookie(token, user));
    audit(user, 'register', 'user', id, null, 'user', req.ip);
    res.json(201, { user: A.publicUser(user), phone_verified: false });
  });

  r.post('/api/auth/login', loginLimit, loginAcctLimit, (req, res) => {
    const identifier = L.str(req.body.identifier, { name: 'Email or phone', required: true, max: 254 });
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = findByIdentifier(identifier);
    // run the hash either way so response time does not reveal whether the account exists
    const ok = L.verifyPassword(password, user ? user.pass_hash : L.DUMMY_HASH) && !!user;
    if (!ok) { audit(null, 'login_failed', 'user', user ? user.id : null, identifier.slice(0, 60), 'security', req.ip); throw new L.HttpError(401, 'Incorrect email/phone or password.'); }
    if (user.status === 'blocked') {
      audit(user, 'login_blocked', 'user', user.id, null, 'security', req.ip);
      throw L.forbidden('This account has been blocked. Contact support' + (user.blocked_reason ? ` (reason: ${user.blocked_reason})` : '') + '.');
    }
    const token = A.createSession(user, req);
    res.setCookie(A.sessionCookie(token, user));
    if (A.isStaff(user)) audit(user, 'login', 'user', user.id, null, 'security', req.ip);
    res.json({ user: A.publicUser(user) });
  });

  r.post('/api/auth/logout', (req, res) => {
    const token = L.parseCookies(req.headers.cookie)[cfg.COOKIE_NAME];
    if (token) q.run('UPDATE sessions SET revoked=1 WHERE token_hash=?', L.sha256(token));
    res.setCookie(L.cookieString(cfg.COOKIE_NAME, '', { clear: true }));
    res.json({ ok: true });
  });

  r.get('/api/auth/me', (req, res) => {
    if (!req.user) {
      return res.json({ user: null, session_expired: !!req.sessionExpired, blocked: !!req.blocked });
    }
    const prefs = q.get('SELECT scroll_mode,page_mode,font_scale FROM prefs WHERE user_id=?', req.user.id) || { scroll_mode: 1, page_mode: 0, font_scale: 1 };
    const unread = q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', req.user.id).c;
    const apps = q.all('SELECT id,kind,status,decision_reason,created_at FROM applications WHERE user_id=? ORDER BY id DESC', req.user.id);
    res.json({ user: A.publicUser(req.user), prefs, unread, applications: apps });
  });

  // ---- password reset --------------------------------------------------------
  // No email/SMS provider is configured, so we do NOT pretend to send anything.
  // A request is queued for administrators, who can issue a one-time reset link.
  r.post('/api/auth/forgot', resetLimit, (req, res) => {
    const identifier = L.str(req.body.identifier, { name: 'Email or phone', required: true, max: 254 });
    const user = findByIdentifier(identifier);
    if (user && !user.is_chief) {
      q.run("INSERT INTO inbox(type,user_id,name,contact,subject,message) VALUES('contact',?,?,?,?,?)", user.id, user.full_name,
        user.email || user.phone, 'Password reset request', `Account recovery requested for user #${user.id}. Issue a reset link from User Management.`);
    }
    res.json({ ok: true, message: 'If that account exists, an administrator has been notified and will send you a one-time reset link. Automatic email delivery is not configured on this server.' });
  });

  r.post('/api/auth/reset', resetLimit, (req, res) => {
    const token = L.str(req.body.token, { name: 'Token', required: true, max: 200 });
    L.checkPassword(req.body.password);
    const row = q.get('SELECT * FROM reset_tokens WHERE token_hash=? AND used=0', L.sha256(token));
    if (!row || row.expires_at < Date.now()) throw L.bad('This reset link is invalid or has expired.');
    tx(() => {
      q.run('UPDATE users SET pass_hash=? WHERE id=?', L.hashPassword(req.body.password), row.user_id);
      q.run('UPDATE reset_tokens SET used=1 WHERE id=?', row.id);
      A.revokeAllSessions(row.user_id);
    });
    audit(null, 'password_reset_used', 'user', row.user_id, null, 'security', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/auth/change-password', A.requireUser, (req, res) => {
    if (!L.verifyPassword(String(req.body.current || ''), req.user.pass_hash)) throw L.bad('Current password is incorrect.');
    L.checkPassword(req.body.password);
    q.run('UPDATE users SET pass_hash=? WHERE id=?', L.hashPassword(req.body.password), req.user.id);
    q.run('UPDATE sessions SET revoked=1 WHERE user_id=? AND id!=?', req.user.id, req.sessionId);
    audit(req.user, 'password_changed', 'user', req.user.id, null, 'security', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/auth/verify-phone', A.requireUser, () => {
    throw new L.HttpError(501, 'SMS verification is not available: no SMS provider is configured on this server. See docs/SETUP.md.');
  });

  // ---- profile ---------------------------------------------------------------
  r.put('/api/profile', A.requireUser, (req, res) => {
    const full_name = L.str(req.body.full_name, { min: 2, max: 100, name: 'Full name', required: true });
    const school = L.str(req.body.school, { max: 150, name: 'School' });
    q.run('UPDATE users SET full_name=?, school=? WHERE id=?', full_name, school || null, req.user.id);
    res.json({ user: A.publicUser(q.get('SELECT * FROM users WHERE id=?', req.user.id)) });
  });

  r.put('/api/prefs', A.requireUser, (req, res) => {
    const scroll = req.body.scroll_mode ? 1 : 0;
    const page = req.body.page_mode ? 1 : 0;
    const fs_ = Number(req.body.font_scale);
    const font = Number.isFinite(fs_) ? Math.min(2, Math.max(0.8, fs_)) : 1;
    q.run(`INSERT INTO prefs(user_id,scroll_mode,page_mode,font_scale) VALUES(?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET scroll_mode=excluded.scroll_mode,page_mode=excluded.page_mode,font_scale=excluded.font_scale`,
      req.user.id, scroll, page, font);
    res.json({ scroll_mode: scroll, page_mode: page, font_scale: font });
  });

  r.post('/api/profile/avatar', A.requireUser, (req, res) => {
    const f = req.files[0];
    if (!f) throw L.bad('Choose an image to upload.');
    if (f.data.length > cfg.MAX_AVATAR_BYTES) throw L.bad('Profile pictures must be 2 MB or smaller.');
    const t = L.sniff(f.data);
    if (!t || !t.mime.startsWith('image/')) throw L.bad('Only PNG, JPEG or WebP images are allowed.');
    const name = crypto.randomBytes(16).toString('hex') + t.ext;
    fs.writeFileSync(path.join(cfg.AVATAR_DIR, name), f.data, { mode: 0o600 });
    const old = req.user.avatar;
    q.run('UPDATE users SET avatar=? WHERE id=?', name, req.user.id);
    if (old) fs.rm(path.join(cfg.AVATAR_DIR, path.basename(old)), () => {});
    res.json({ ok: true });
  });
  // Avatars: owner and staff only (not public).
  r.get('/api/profile/avatar/:id', A.requireUser, (req, res) => {
    const id = L.int(req.params.id, { name: 'User' });
    if (id !== req.user.id && !A.isStaff(req.user)) throw L.forbidden();
    const u = q.get('SELECT avatar FROM users WHERE id=?', id);
    if (!u || !u.avatar) throw L.notFound();
    res.sendFile(path.join(cfg.AVATAR_DIR, path.basename(u.avatar)), { 'Cache-Control': 'private, max-age=300' });
  });

  // ---- notifications ------------------------------------------------------------
  r.get('/api/notifications', A.requireUser, (req, res) => {
    res.json({ items: q.all('SELECT id,title,body,link,read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id) });
  });
  r.post('/api/notifications/read', A.requireUser, (req, res) => {
    q.run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id);
    res.json({ ok: true });
  });

  // ---- staff applications ----------------------------------------------------------
  r.post('/api/applications', A.requireUser, (req, res) => {
    const kind = req.body.kind;
    if (!['teacher', 'supervisor', 'admin'].includes(kind)) throw L.bad('Choose an application type.');
    if (A.isStaff(req.user) && kind !== 'admin') throw L.bad('You already hold a staff role.');
    if (A.isAdmin(req.user)) throw L.bad('You already hold an administrator role.');
    if (req.user.role === 'teacher' && kind === 'teacher') throw L.bad('You are already an approved teacher.');
    if (kind === 'admin' && getSetting('admin_recruitment_enabled') !== '1') throw L.forbidden('Administrator applications are not open right now.');
    if (q.get("SELECT 1 FROM applications WHERE user_id=? AND kind=? AND status IN('pending','info_requested')", req.user.id, kind))
      throw L.bad('You already have an open application of this type.');
    let subject_ids = [];
    if (kind === 'supervisor' || kind === 'teacher') {
      const raw = Array.isArray(req.body.subject_ids) ? req.body.subject_ids : [];
      subject_ids = [...new Set(raw.map((x) => Number(x)))];
      if (subject_ids.some((x) => !Number.isInteger(x) || !q.get('SELECT 1 FROM subjects WHERE id=? AND active=1', x))) throw L.bad('One or more selected subjects are invalid.');
      if (kind === 'supervisor') {
        if (subject_ids.length < 2) throw L.bad('Supervisor applicants must select at least two subject areas.');
        if (subject_ids.length > cfg.LIMITS.SUPERVISOR_SUBJECTS) throw L.bad(`Supervisors can be assigned at most ${cfg.LIMITS.SUPERVISOR_SUBJECTS} subjects.`);
      } else if (subject_ids.length < 1) throw L.bad('Select at least one subject you teach.');
    }
    const qualifications = L.str(req.body.qualifications, { min: 10, max: 2000, name: 'Qualifications', required: true });
    const experience = L.str(req.body.experience, { max: 2000, name: 'Experience' });
    const institution = L.str(req.body.institution, { max: 200, name: 'School / institution' });
    const message = L.str(req.body.message, { max: 2000, name: 'Message' });
    const ins = q.run('INSERT INTO applications(user_id,kind,subject_ids,qualifications,experience,institution,message) VALUES(?,?,?,?,?,?,?)',
      req.user.id, kind, JSON.stringify(subject_ids), qualifications, experience || null, institution || null, message || null);
    audit(req.user, 'application_submitted', 'application', Number(ins.lastInsertRowid), kind, 'user', req.ip);
    for (const a of q.all("SELECT id FROM users WHERE role IN('admin','main_admin','chief') AND status='active'"))
      notify(a.id, `New ${kind} application`, `${req.user.full_name} applied.`, '#/admin/applications');
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });

  r.get('/api/applications/mine', A.requireUser, (req, res) => {
    res.json({ items: q.all('SELECT id,kind,status,subject_ids,decision_reason,created_at,decided_at FROM applications WHERE user_id=? ORDER BY id DESC', req.user.id) });
  });
};
