'use strict';
const cfg = require('./config');
const { q, db, audit } = require('./db');
const L = require('./lib');

const STAFF_ROLES = ['supervisor', 'admin', 'main_admin', 'chief'];
const ADMIN_ROLES = ['admin', 'main_admin', 'chief'];
const isStaff = (u) => !!u && STAFF_ROLES.includes(u.role);
const isAdmin = (u) => !!u && ADMIN_ROLES.includes(u.role);
const isMainAdmin = (u) => !!u && (u.role === 'main_admin' || u.role === 'chief');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, full_name: u.full_name, school: u.school, email: u.email, phone: u.phone, role: u.role,
    can_publish: !!(u.can_publish || u.role === 'main_admin' || u.role === 'chief'),
    has_avatar: !!u.avatar, created_at: u.created_at,
  };
}

function createSession(user, req) {
  const token = L.newToken();
  const now = Date.now();
  q.run('INSERT INTO sessions(user_id,token_hash,created_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?)',
    user.id, L.sha256(token), now, now, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  return token;
}

function sessionCookie(token, user) {
  const maxAge = isStaff(user) ? undefined : cfg.STUDENT_SESSION_MS; // staff cookie is a browser-session cookie
  return L.cookieString(cfg.COOKIE_NAME, token, { maxAgeMs: maxAge });
}

/** Resolves req.user (or null). Enforces staff inactivity timeout and blocked status server-side. */
function loadUser(req) {
  req.user = null;
  const token = L.parseCookies(req.headers.cookie)[cfg.COOKIE_NAME];
  if (!token) return;
  const s = q.get('SELECT * FROM sessions WHERE token_hash=? AND revoked=0', L.sha256(token));
  if (!s) return;
  const u = q.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u) return;
  const now = Date.now();
  if (isStaff(u) && now - s.last_seen > cfg.STAFF_IDLE_MS) {
    q.run('UPDATE sessions SET revoked=1 WHERE id=?', s.id);
    req.sessionExpired = true;
    return;
  }
  if (!isStaff(u) && now - s.created_at > cfg.STUDENT_SESSION_MS) { q.run('UPDATE sessions SET revoked=1 WHERE id=?', s.id); return; }
  if (u.status === 'blocked') { q.run('UPDATE sessions SET revoked=1 WHERE user_id=?', u.id); req.blocked = u; return; }
  if (now - s.last_seen > 60e3) q.run('UPDATE sessions SET last_seen=? WHERE id=?', now, s.id);
  req.user = u;
  req.sessionId = s.id;
}

function revokeAllSessions(userId) { q.run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId); }

// ---- guards ------------------------------------------------------------------
const requireUser = (req) => { if (!req.user) throw L.unauthorized(req.sessionExpired ? 'Your session expired. Please log in again.' : 'Please log in.'); };
const requireRole = (...roles) => (req) => { requireUser(req); if (!roles.includes(req.user.role)) throw L.forbidden(); };
const requireAdmin = (req) => { requireUser(req); if (!isAdmin(req.user)) throw L.forbidden('Administrator access required.'); };
const requireMain = (req) => { requireUser(req); if (!isMainAdmin(req.user)) throw L.forbidden('Main administrator access required.'); };
const requireChief = (req) => { requireUser(req); if (req.user.role !== 'chief') throw L.forbidden('Chief administrator access required.'); };
const requireStaff = (req) => { requireUser(req); if (!isStaff(req.user)) throw L.forbidden(); };
const requireStaffOrTeacher = (req) => { requireUser(req); if (!isStaff(req.user) && req.user.role !== 'teacher') throw L.forbidden(); };
const requirePublisher = (req) => {
  requireAdmin(req);
  if (!(req.user.can_publish || isMainAdmin(req.user))) throw L.forbidden('You have not been authorised to publish. Ask a main administrator.');
};

// ---- Chief Administrator provisioning ---------------------------------------
/*
 * The chief account is NEVER created by registering with the reserved email.
 * It is provisioned out-of-band:   CHIEF_PASSWORD='...' node scripts/provision-chief.js
 * (or an equivalent one-time operator action on the server). Registration with the reserved
 * email is refused by /api/auth/register (see routes/auth.js).
 */
function provisionChief(password) {
  L.checkPassword(password);
  if (q.get('SELECT 1 FROM users WHERE is_chief=1')) throw new Error('A Chief Administrator already exists. Use the password reset script to change the password.');
  if (q.get('SELECT 1 FROM users WHERE email=?', cfg.CHIEF_EMAIL)) throw new Error('The reserved chief email is already registered to a non-chief account. Resolve manually.');
  const r = q.run("INSERT INTO users(full_name,email,pass_hash,role,is_chief,email_verified) VALUES(?,?,?,?,1,1)",
    'Chief Administrator', cfg.CHIEF_EMAIL, L.hashPassword(password), 'chief');
  q.run('INSERT OR IGNORE INTO prefs(user_id) VALUES(?)', Number(r.lastInsertRowid));
  audit(null, 'chief_provisioned', 'user', Number(r.lastInsertRowid), 'Provisioned by operator script', 'security');
  return Number(r.lastInsertRowid);
}

function resetChiefPassword(password) {
  L.checkPassword(password);
  const u = q.get('SELECT * FROM users WHERE is_chief=1');
  if (!u) throw new Error('No Chief Administrator exists yet.');
  q.run('UPDATE users SET pass_hash=? WHERE id=?', L.hashPassword(password), u.id);
  revokeAllSessions(u.id);
  audit(null, 'chief_password_reset', 'user', u.id, 'Reset by operator script', 'security');
}

module.exports = {
  STAFF_ROLES, ADMIN_ROLES, isStaff, isAdmin, isMainAdmin, publicUser, createSession, sessionCookie, loadUser,
  revokeAllSessions, requireUser, requireRole, requireAdmin, requireMain, requireChief, requireStaff,
  requireStaffOrTeacher, requirePublisher, provisionChief, resetChiefPassword,
};
