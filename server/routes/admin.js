'use strict';
const crypto = require('crypto');
const cfg = require('../config');
const { q, tx, audit, notify, getSetting, setSetting } = require('../db');
const L = require('../lib');
const A = require('../auth');

const ROLE_RANK = { student: 0, teacher: 1, supervisor: 2, admin: 3, main_admin: 4, chief: 5 };

function target(id) {
  const u = q.get('SELECT * FROM users WHERE id=?', L.int(id, { name: 'User' }));
  if (!u) throw L.notFound('User not found.');
  return u;
}
/** Admins may act on users below them; main admins on anyone below main admin; nobody on the chief. */
function assertCanManage(actor, t) {
  if (t.is_chief) throw L.forbidden('The Chief Administrator account is protected.');
  if (t.id === actor.id) throw L.forbidden('You cannot perform this action on your own account.');
  if (actor.role === 'chief') return;
  if (actor.role === 'main_admin' && ROLE_RANK[t.role] < ROLE_RANK.main_admin) return;
  if (actor.role === 'admin' && ROLE_RANK[t.role] < ROLE_RANK.admin) return;
  throw L.forbidden('You do not have authority over this account.');
}

function setRole(user, role) {
  tx(() => {
    if (user.role === 'supervisor' && role !== 'supervisor') {
      q.run('DELETE FROM supervisor_subjects WHERE user_id=?', user.id);
      q.run("UPDATE submissions SET supervisor_id=NULL, review_status='none', status=CASE WHEN status='in_review' THEN 'draft' ELSE status END WHERE supervisor_id=? AND status IN('draft','in_review')", user.id);
    }
    q.run('UPDATE users SET role=? WHERE id=?', role, user.id);
    if (!['admin', 'main_admin', 'chief'].includes(role)) q.run('UPDATE users SET can_publish=0 WHERE id=?', user.id);
  });
}

module.exports = (r) => {
  // ---- overview ---------------------------------------------------------------------
  r.get('/api/admin/overview', A.requireAdmin, (req, res) => {
    const c = (sql, ...p) => q.get(sql, ...p).c;
    res.json({
      users: {
        students: c("SELECT COUNT(*) c FROM users WHERE role='student'"),
        teachers: c("SELECT COUNT(*) c FROM users WHERE role='teacher'"),
        supervisors: c("SELECT COUNT(*) c FROM users WHERE role='supervisor'"),
        admins: c("SELECT COUNT(*) c FROM users WHERE role IN('admin','main_admin','chief')"),
        blocked: c("SELECT COUNT(*) c FROM users WHERE status='blocked'"),
      },
      limits: {
        main_admins: { used: c("SELECT COUNT(*) c FROM users WHERE role IN('main_admin','chief')"), max: cfg.LIMITS.MAIN_ADMINS },
        supervisors: { used: c("SELECT COUNT(*) c FROM users WHERE role='supervisor'"), max: cfg.LIMITS.SUPERVISORS },
        teachers: { used: c("SELECT COUNT(*) c FROM users WHERE role='teacher'"), max: cfg.LIMITS.TEACHERS },
      },
      content: Object.fromEntries(['draft', 'in_review', 'approved', 'published', 'rejected', 'archived'].map((s) => [s, c('SELECT COUNT(*) c FROM submissions WHERE status=?', s)])),
      awaiting_review: c("SELECT COUNT(*) c FROM submissions WHERE status='in_review' AND review_status='pending'"),
      awaiting_approval: c("SELECT COUNT(*) c FROM submissions WHERE status='in_review' AND review_status IN('recommend_approval','recommend_rejection','corrections_requested')"),
      pending_applications: { teacher: c("SELECT COUNT(*) c FROM applications WHERE kind='teacher' AND status IN('pending','info_requested')"),
        supervisor: c("SELECT COUNT(*) c FROM applications WHERE kind='supervisor' AND status IN('pending','info_requested')"),
        admin: c("SELECT COUNT(*) c FROM applications WHERE kind='admin' AND status IN('pending','info_requested')") },
      inbox_new: c("SELECT COUNT(*) c FROM inbox WHERE status='new'"),
      donations: q.get("SELECT COUNT(*) c, COALESCE(SUM(amount_gmd),0) total FROM donations WHERE status='confirmed'"),
    });
  });

  // ---- applications -------------------------------------------------------------------
  r.get('/api/admin/applications', A.requireAdmin, (req, res) => {
    const { kind, status } = req.query;
    const where = []; const p = [];
    if (kind) { where.push('a.kind=?'); p.push(kind); }
    where.push(status ? 'a.status=?' : "a.status IN('pending','info_requested')"); if (status) p.push(status);
    const rows = q.all(`SELECT a.*, u.full_name, u.email, u.phone, u.school, d.full_name AS decided_by_name
      FROM applications a JOIN users u ON u.id=a.user_id LEFT JOIN users d ON d.id=a.decided_by
      WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 200`, ...p);
    for (const a of rows) {
      const ids = JSON.parse(a.subject_ids || '[]');
      a.subjects = ids.length ? q.all(`SELECT s.id,s.name,e.code exam FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE s.id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    }
    res.json({ items: rows });
  });

  r.post('/api/admin/applications/:id/decide', A.requireAdmin, (req, res) => {
    const app = q.get('SELECT * FROM applications WHERE id=?', L.int(req.params.id, { name: 'Application' }));
    if (!app) throw L.notFound();
    if (!['pending', 'info_requested'].includes(app.status)) throw L.bad('This application has already been decided.');
    const decision = req.body.decision;
    const reason = L.str(req.body.reason, { max: 1000, name: 'Reason' });
    if (!['approve', 'reject', 'request_info'].includes(decision)) throw L.bad('Invalid decision.');
    if (decision !== 'approve' && !reason) throw L.bad('Please give a reason or the information you need.');
    if (app.user_id === req.user.id) throw L.forbidden('You cannot decide your own application.');
    const applicant = target(app.user_id);
    if (app.kind === 'admin' && !A.isMainAdmin(req.user)) throw L.forbidden('Only main administrators can decide administrator applications.');

    if (decision === 'approve') {
      if (applicant.status === 'blocked') throw L.bad('This account is blocked. Unblock it first.');
      if (applicant.is_chief) throw L.bad('The Chief Administrator account is protected.');
      const next = app.kind === 'admin' ? 'admin' : app.kind;
      if (ROLE_RANK[applicant.role] > ROLE_RANK[next]) throw L.bad('This user already holds a higher role.');
      const ids = JSON.parse(app.subject_ids || '[]');
      if (app.kind === 'supervisor' && (ids.length < 2 || ids.length > cfg.LIMITS.SUPERVISOR_SUBJECTS)) throw L.bad('A supervisor needs between 2 and 4 subjects.');
      tx(() => {
        setRole(applicant, next);
        if (app.kind === 'supervisor') {
          q.run('DELETE FROM supervisor_subjects WHERE user_id=?', applicant.id);
          for (const sid of ids) q.run('INSERT INTO supervisor_subjects(user_id,subject_id,assigned_by) VALUES(?,?,?)', applicant.id, sid, req.user.id);
        }
        q.run("UPDATE applications SET status='approved', decided_by=?, decided_at=datetime('now'), decision_reason=? WHERE id=?", req.user.id, reason || null, app.id);
      });
      notify(applicant.id, `Your ${app.kind} application was approved`, 'You now have access to your new dashboard.', '#/');
      audit(req.user, 'application_approved', 'application', app.id, { kind: app.kind, user: applicant.id }, 'user', req.ip);
    } else {
      const st = decision === 'reject' ? 'rejected' : 'info_requested';
      q.run("UPDATE applications SET status=?, decided_by=?, decided_at=datetime('now'), decision_reason=? WHERE id=?", st, req.user.id, reason, app.id);
      notify(applicant.id, decision === 'reject' ? `Your ${app.kind} application was not approved` : `More information needed for your ${app.kind} application`, reason, '#/apply');
      audit(req.user, 'application_' + st, 'application', app.id, { kind: app.kind, user: applicant.id, reason }, 'user', req.ip);
    }
    res.json({ ok: true });
  });

  // ---- users ----------------------------------------------------------------------------
  r.get('/api/admin/users', A.requireAdmin, (req, res) => {
    const where = ['1=1']; const p = [];
    if (req.query.role) { where.push('role=?'); p.push(req.query.role); }
    if (req.query.status) { where.push('status=?'); p.push(req.query.status); }
    if (req.query.q) { where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR school LIKE ?)'); const t = `%${String(req.query.q).slice(0, 60)}%`; p.push(t, t, t, t); }
    const items = q.all(`SELECT id,full_name,school,email,phone,role,is_chief,can_publish,status,blocked_reason,blocked_at,created_at FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, ...p);
    res.json({ items });
  });

  r.post('/api/admin/users/:id/block', A.requireAdmin, (req, res) => {
    const t = target(req.params.id); assertCanManage(req.user, t);
    const reason = L.str(req.body.reason, { min: 3, max: 500, name: 'Reason', required: true });
    q.run("UPDATE users SET status='blocked', blocked_reason=?, blocked_at=datetime('now'), blocked_by=? WHERE id=?", reason, req.user.id, t.id);
    A.revokeAllSessions(t.id);
    audit(req.user, 'user_blocked', 'user', t.id, { reason }, 'user', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/admin/users/:id/unblock', A.requireAdmin, (req, res) => {
    const t = target(req.params.id); assertCanManage(req.user, t);
    q.run("UPDATE users SET status='active', blocked_reason=NULL, blocked_at=NULL, blocked_by=NULL WHERE id=?", t.id);
    audit(req.user, 'user_unblocked', 'user', t.id, { reason: L.str(req.body.reason, { max: 500 }) || null }, 'user', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/role', A.requireMain, (req, res) => {
    const t = target(req.params.id); assertCanManage(req.user, t);
    const role = req.body.role;
    if (!['student', 'teacher', 'supervisor', 'admin', 'main_admin'].includes(role)) throw L.bad('Invalid role.');
    if (role === 'main_admin' && req.user.role !== 'chief') throw L.forbidden('Only the Chief Administrator can appoint main administrators.');
    if (role === 'supervisor') {
      const n = q.get('SELECT COUNT(*) c FROM supervisor_subjects WHERE user_id=?', t.id).c;
      if (t.role !== 'supervisor' && n < 2) throw L.bad('Use the supervisor application flow (min. 2 subjects) to create supervisors.');
    }
    const before = t.role;
    setRole(t, role);
    notify(t.id, 'Your role was changed', `Your role is now: ${role.replace('_', ' ')}.`, '#/');
    audit(req.user, 'role_changed', 'user', t.id, { from: before, to: role }, 'user', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/can-publish', A.requireMain, (req, res) => {
    const t = target(req.params.id); assertCanManage(req.user, t);
    if (t.role !== 'admin') throw L.bad('Publishing permission applies to administrators (main administrators already have it).');
    const v = req.body.value ? 1 : 0;
    q.run('UPDATE users SET can_publish=? WHERE id=?', v, t.id);
    audit(req.user, v ? 'publish_granted' : 'publish_revoked', 'user', t.id, null, 'user', req.ip);
    res.json({ ok: true });
  });

  // one-time password reset link, issued by an administrator (no email provider is configured)
  r.post('/api/admin/users/:id/reset-link', A.requireAdmin, (req, res) => {
    const t = target(req.params.id); assertCanManage(req.user, t);
    const token = L.newToken();
    q.run('INSERT INTO reset_tokens(user_id,token_hash,expires_at,created_by) VALUES(?,?,?,?)', t.id, L.sha256(token), Date.now() + 60 * 60e3, req.user.id);
    audit(req.user, 'reset_link_issued', 'user', t.id, null, 'security', req.ip);
    res.json({ path: `/#/reset/${token}`, expires_in_minutes: 60, note: 'Give this link to the user privately. It works once.' });
  });

  // ---- supervisors -----------------------------------------------------------------------
  r.get('/api/admin/supervisors', A.requireAdmin, (req, res) => {
    const sups = q.all("SELECT id,full_name,email,phone,status FROM users WHERE role='supervisor' ORDER BY full_name");
    for (const s of sups) {
      s.subjects = q.all('SELECT s.id,s.name,e.code exam FROM supervisor_subjects ss JOIN subjects s ON s.id=ss.subject_id JOIN exams e ON e.id=s.exam_id WHERE ss.user_id=?', s.id);
      s.open_reviews = q.get("SELECT COUNT(*) c FROM submissions WHERE supervisor_id=? AND status='in_review' AND review_status='pending'", s.id).c;
    }
    res.json({ items: sups, max_subjects: cfg.LIMITS.SUPERVISOR_SUBJECTS });
  });
  r.put('/api/admin/supervisors/:id/subjects', A.requireAdmin, (req, res) => {
    const t = target(req.params.id);
    if (t.role !== 'supervisor') throw L.bad('That user is not a supervisor.');
    const ids = [...new Set((Array.isArray(req.body.subject_ids) ? req.body.subject_ids : []).map(Number))];
    if (ids.length < 2) throw L.bad('A supervisor must keep at least two subjects.');
    if (ids.length > cfg.LIMITS.SUPERVISOR_SUBJECTS) throw L.bad(`A supervisor can have at most ${cfg.LIMITS.SUPERVISOR_SUBJECTS} subjects.`);
    if (ids.some((x) => !Number.isInteger(x) || !q.get('SELECT 1 FROM subjects WHERE id=?', x))) throw L.bad('Invalid subject selected.');
    tx(() => {
      q.run('DELETE FROM supervisor_subjects WHERE user_id=?', t.id);
      for (const sid of ids) q.run('INSERT INTO supervisor_subjects(user_id,subject_id,assigned_by) VALUES(?,?,?)', t.id, sid, req.user.id);
    });
    audit(req.user, 'supervisor_subjects_set', 'user', t.id, { subject_ids: ids }, 'user', req.ip);
    res.json({ ok: true });
  });

  // ---- exams / subjects / paper types (managed from the UI, not code) --------------------
  r.get('/api/admin/catalog', A.requireAdmin, (req, res) => {
    res.json({
      exams: q.all('SELECT * FROM exams ORDER BY sort,id'),
      subjects: q.all('SELECT s.*, e.code exam_code FROM subjects s JOIN exams e ON e.id=s.exam_id ORDER BY e.sort, s.sort, s.name'),
      paper_types: q.all('SELECT * FROM paper_types ORDER BY sort,id'),
      content_types: JSON.parse(getSetting('content_types') || '[]'),
      year_min: Number(getSetting('year_min')), year_max: Number(getSetting('year_max')),
    });
  });
  r.post('/api/admin/exams', A.requireAdmin, (req, res) => {
    const code = L.str(req.body.code, { min: 2, max: 20, name: 'Code', required: true }).toUpperCase();
    const name = L.str(req.body.name, { min: 2, max: 100, name: 'Name', required: true });
    if (q.get('SELECT 1 FROM exams WHERE code=?', code)) throw L.bad('An examination with that code already exists.');
    const sort = q.get('SELECT COALESCE(MAX(sort),0)+1 n FROM exams').n;
    const ins = q.run('INSERT INTO exams(code,name,grade,description,sort) VALUES(?,?,?,?,?)', code, name, L.str(req.body.grade, { max: 40 }) || null, L.str(req.body.description, { max: 300 }) || null, sort);
    audit(req.user, 'exam_created', 'exam', Number(ins.lastInsertRowid), code, 'content', req.ip);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });
  r.put('/api/admin/exams/:id', A.requireAdmin, (req, res) => {
    const e = q.get('SELECT * FROM exams WHERE id=?', L.int(req.params.id, { name: 'Exam' })); if (!e) throw L.notFound();
    q.run('UPDATE exams SET name=?, grade=?, description=?, active=?, sort=? WHERE id=?',
      L.str(req.body.name ?? e.name, { min: 2, max: 100, required: true, name: 'Name' }), req.body.grade ?? e.grade, req.body.description ?? e.description,
      req.body.active === undefined ? e.active : (req.body.active ? 1 : 0), req.body.sort === undefined ? e.sort : L.int(req.body.sort, { name: 'Order' }), e.id);
    audit(req.user, 'exam_updated', 'exam', e.id, req.body, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/admin/subjects', A.requireAdmin, (req, res) => {
    const exam_id = L.int(req.body.exam_id, { name: 'Examination' });
    if (!q.get('SELECT 1 FROM exams WHERE id=?', exam_id)) throw L.bad('Unknown examination.');
    const name = L.str(req.body.name, { min: 2, max: 120, name: 'Subject name', required: true });
    if (q.get('SELECT 1 FROM subjects WHERE exam_id=? AND name=? COLLATE NOCASE', exam_id, name)) throw L.bad('That subject already exists in this examination.');
    const sort = q.get('SELECT COALESCE(MAX(sort),0)+1 n FROM subjects WHERE exam_id=?', exam_id).n;
    const ins = q.run('INSERT INTO subjects(exam_id,name,sort) VALUES(?,?,?)', exam_id, name, sort);
    audit(req.user, 'subject_created', 'subject', Number(ins.lastInsertRowid), name, 'content', req.ip);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });
  r.put('/api/admin/subjects/:id', A.requireAdmin, (req, res) => {
    const s = q.get('SELECT * FROM subjects WHERE id=?', L.int(req.params.id, { name: 'Subject' })); if (!s) throw L.notFound();
    const name = L.str(req.body.name ?? s.name, { min: 2, max: 120, name: 'Subject name', required: true });
    if (name.toLowerCase() !== s.name.toLowerCase() && q.get('SELECT 1 FROM subjects WHERE exam_id=? AND name=? COLLATE NOCASE', s.exam_id, name)) throw L.bad('That subject already exists in this examination.');
    q.run('UPDATE subjects SET name=?, active=?, sort=? WHERE id=?', name, req.body.active === undefined ? s.active : (req.body.active ? 1 : 0),
      req.body.sort === undefined ? s.sort : L.int(req.body.sort, { name: 'Order' }), s.id);
    audit(req.user, 'subject_updated', 'subject', s.id, req.body, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/admin/paper-types', A.requireAdmin, (req, res) => {
    const name = L.str(req.body.name, { min: 2, max: 60, name: 'Paper type', required: true });
    if (q.get('SELECT 1 FROM paper_types WHERE name=? COLLATE NOCASE', name)) throw L.bad('That paper type already exists.');
    const ins = q.run('INSERT INTO paper_types(name,sort) VALUES(?,?)', name, q.get('SELECT COALESCE(MAX(sort),0)+1 n FROM paper_types').n);
    audit(req.user, 'paper_type_created', 'paper_type', Number(ins.lastInsertRowid), name, 'content', req.ip);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });
  r.put('/api/admin/paper-types/:id', A.requireAdmin, (req, res) => {
    const p = q.get('SELECT * FROM paper_types WHERE id=?', L.int(req.params.id, { name: 'Paper type' })); if (!p) throw L.notFound();
    q.run('UPDATE paper_types SET name=?, active=? WHERE id=?', L.str(req.body.name ?? p.name, { min: 2, max: 60, required: true, name: 'Paper type' }), req.body.active === undefined ? p.active : (req.body.active ? 1 : 0), p.id);
    audit(req.user, 'paper_type_updated', 'paper_type', p.id, req.body, 'content', req.ip);
    res.json({ ok: true });
  });

  // ---- audit log -----------------------------------------------------------------------------
  r.get('/api/admin/audit', A.requireAdmin, (req, res) => {
    const where = []; const p = [];
    // regular admins see content + user-management history; security events are for main administrators
    const allowed = A.isMainAdmin(req.user) ? ['content', 'user', 'security'] : ['content', 'user'];
    const scope = req.query.scope && allowed.includes(req.query.scope) ? [req.query.scope] : allowed;
    where.push(`scope IN (${scope.map(() => '?').join(',')})`); p.push(...scope);
    if (req.query.action) { where.push('action LIKE ?'); p.push(`%${String(req.query.action).slice(0, 40)}%`); }
    if (req.query.target_type && req.query.target_id) { where.push('target_type=? AND target_id=?'); p.push(String(req.query.target_type), Number(req.query.target_id)); }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ items: q.all(`SELECT id,actor_id,actor_name,action,target_type,target_id,detail,scope,created_at FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, ...p) });
  });

  // ---- settings (chief only) ---------------------------------------------------------------------
  r.get('/api/admin/settings', A.requireMain, (req, res) => {
    res.json({
      admin_recruitment_enabled: getSetting('admin_recruitment_enabled') === '1',
      require_phone_verification: getSetting('require_phone_verification') === '1',
      year_min: Number(getSetting('year_min')), year_max: Number(getSetting('year_max')),
      integrations: require('../integrations').status(),
    });
  });
  r.put('/api/admin/settings', A.requireChief, (req, res) => {
    if (req.body.admin_recruitment_enabled !== undefined) setSetting('admin_recruitment_enabled', req.body.admin_recruitment_enabled ? '1' : '0');
    if (req.body.require_phone_verification !== undefined) {
      if (req.body.require_phone_verification && !require('../integrations').status().sms.configured) throw L.bad('Cannot require phone verification: no SMS provider is configured.');
      setSetting('require_phone_verification', req.body.require_phone_verification ? '1' : '0');
    }
    if (req.body.year_min !== undefined) setSetting('year_min', L.int(req.body.year_min, { min: 1950, max: 2100, name: 'First year' }));
    if (req.body.year_max !== undefined) setSetting('year_max', L.int(req.body.year_max, { min: 1950, max: 2100, name: 'Last year' }));
    audit(req.user, 'settings_changed', 'settings', null, req.body, 'security', req.ip);
    res.json({ ok: true });
  });

  r.get('/api/admin/system', A.requireMain, (req, res) => {
    const fs = require('fs');
    let dbSize = 0; try { dbSize = fs.statSync(cfg.DB_FILE).size; } catch {}
    res.json({ node: process.version, uptime_s: Math.round(process.uptime()), db_bytes: dbSize, memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      active_sessions: q.get('SELECT COUNT(*) c FROM sessions WHERE revoked=0').c, integrations: require('../integrations').status() });
  });

  // ---- inbox: contact messages, reports, feedback ---------------------------------------------------
  r.get('/api/admin/inbox', A.requireAdmin, (req, res) => {
    const where = []; const p = [];
    if (req.query.type) { where.push('type=?'); p.push(req.query.type); }
    if (req.query.status) { where.push('status=?'); p.push(req.query.status); }
    res.json({ items: q.all(`SELECT * FROM inbox ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, ...p) });
  });
  r.put('/api/admin/inbox/:id', A.requireAdmin, (req, res) => {
    const it = q.get('SELECT * FROM inbox WHERE id=?', L.int(req.params.id, { name: 'Item' })); if (!it) throw L.notFound();
    const status = req.body.status;
    if (!['new', 'in_progress', 'resolved', 'dismissed'].includes(status)) throw L.bad('Invalid status.');
    q.run('UPDATE inbox SET status=?, handled_by=?, handled_note=? WHERE id=?', status, req.user.id, L.str(req.body.note, { max: 1000 }) || null, it.id);
    audit(req.user, 'inbox_' + status, 'inbox', it.id, null, 'content', req.ip);
    res.json({ ok: true });
  });

  r.get('/api/admin/donations', A.requireAdmin, (req, res) => {
    res.json({ items: q.all('SELECT id,provider,amount_gmd,status,created_at,confirmed_at FROM donations ORDER BY id DESC LIMIT 200'),
      confirmed_total: q.get("SELECT COALESCE(SUM(amount_gmd),0) t FROM donations WHERE status='confirmed'").t });
  });
};
