'use strict';
const crypto = require('crypto');
const { q, tx, audit } = require('../db');
const L = require('../lib');
const A = require('../auth');

const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function loadClass(id) { const c = q.get('SELECT * FROM classes WHERE id=?', L.int(id, { name: 'Class' })); if (!c) throw L.notFound('Class not found.'); return c; }
const isOwner = (u, c) => c.teacher_id === u.id;
function isMember(u, c) { return !!q.get('SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND removed=0', c.id, u.id); }
/** Teacher who owns the class, or a member. Admins can read for moderation. */
function assertAccess(req, c) {
  if (isOwner(req.user, c) || A.isAdmin(req.user) || isMember(req.user, c)) return;
  throw L.notFound('Class not found.');
}
const assertOwner = (req, c) => { if (!isOwner(req.user, c) && !A.isAdmin(req.user)) throw L.forbidden('Only the class teacher can do that.'); };

module.exports = (r) => {
  r.post('/api/classes', A.requireRole('teacher'), (req, res) => {
    const name = L.str(req.body.name, { min: 2, max: 100, name: 'Name', required: true });
    const kind = req.body.kind === 'group' ? 'group' : 'class';
    const subject_id = req.body.subject_id ? L.int(req.body.subject_id, { name: 'Subject' }) : null;
    if (subject_id && !q.get('SELECT 1 FROM subjects WHERE id=?', subject_id)) throw L.bad('Unknown subject.');
    if (q.get('SELECT COUNT(*) c FROM classes WHERE teacher_id=? AND archived=0', req.user.id).c >= 30) throw L.bad('You have reached the limit of 30 active classes.');
    const ins = q.run('INSERT INTO classes(teacher_id,name,kind,subject_id,join_code) VALUES(?,?,?,?,?)', req.user.id, name, kind, subject_id, code());
    audit(req.user, 'class_created', 'class', Number(ins.lastInsertRowid), name, 'user', req.ip);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });

  r.get('/api/classes', A.requireUser, (req, res) => {
    if (req.user.role === 'teacher') {
      return res.json({ items: q.all(`SELECT c.id,c.name,c.kind,c.join_code,c.archived,(SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id AND m.removed=0) members FROM classes c WHERE teacher_id=? ORDER BY c.id DESC`, req.user.id) });
    }
    res.json({ items: q.all(`SELECT c.id,c.name,c.kind,u.full_name teacher_name FROM class_members m JOIN classes c ON c.id=m.class_id JOIN users u ON u.id=c.teacher_id
      WHERE m.user_id=? AND m.removed=0 AND c.archived=0 ORDER BY c.id DESC`, req.user.id) });
  });

  r.post('/api/classes/join', A.requireUser, L.rateLimit('join', 15, 10 * 60e3, (req) => String(req.user && req.user.id)), (req, res) => {
    if (req.user.role !== 'student') throw L.forbidden('Only students can join a class with a code.');
    const c = q.get('SELECT * FROM classes WHERE join_code=? AND archived=0', String(req.body.code || '').trim().toUpperCase());
    if (!c) throw L.bad('That class code was not found.');
    const m = q.get('SELECT * FROM class_members WHERE class_id=? AND user_id=?', c.id, req.user.id);
    if (m && m.removed) throw L.forbidden('You cannot rejoin this class.');
    if (!m) q.run('INSERT INTO class_members(class_id,user_id) VALUES(?,?)', c.id, req.user.id);
    res.json({ id: c.id, name: c.name });
  });

  r.get('/api/classes/:id', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    const owner = isOwner(req.user, c) || A.isAdmin(req.user);
    const teacher = q.get('SELECT full_name FROM users WHERE id=?', c.teacher_id);
    // students never see each other's school/contact details: names only, and only the teacher gets the roster
    const members = owner ? q.all(`SELECT u.id,u.full_name,u.school,m.muted,m.removed FROM class_members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? ORDER BY u.full_name`, c.id) : undefined;
    res.json({ class: { id: c.id, name: c.name, kind: c.kind, join_code: owner ? c.join_code : undefined, teacher_name: teacher.full_name, archived: !!c.archived }, is_owner: owner, members });
  });
  r.put('/api/classes/:id', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertOwner(req, c);
    q.run('UPDATE classes SET name=?, archived=? WHERE id=?', L.str(req.body.name ?? c.name, { min: 2, max: 100, required: true, name: 'Name' }), req.body.archived ? 1 : 0, c.id);
    res.json({ ok: true });
  });
  r.post('/api/classes/:id/members/:uid/:action', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertOwner(req, c);
    const uid = L.int(req.params.uid, { name: 'User' });
    if (!q.get('SELECT 1 FROM class_members WHERE class_id=? AND user_id=?', c.id, uid)) throw L.notFound();
    const a = req.params.action;
    if (a === 'mute') q.run('UPDATE class_members SET muted=1 WHERE class_id=? AND user_id=?', c.id, uid);
    else if (a === 'unmute') q.run('UPDATE class_members SET muted=0 WHERE class_id=? AND user_id=?', c.id, uid);
    else if (a === 'remove') q.run('UPDATE class_members SET removed=1 WHERE class_id=? AND user_id=?', c.id, uid);
    else throw L.bad('Unknown action.');
    audit(req.user, 'class_member_' + a, 'class', c.id, { user: uid }, 'user', req.ip);
    res.json({ ok: true });
  });

  // ---- assignments ----------------------------------------------------------------------------------
  r.post('/api/classes/:id/assignments', A.requireRole('teacher'), (req, res) => {
    const c = loadClass(req.params.id); assertOwner(req, c);
    const kind = req.body.kind === 'quiz' ? 'quiz' : 'written';
    const title = L.str(req.body.title, { min: 2, max: 150, name: 'Title', required: true });
    let quiz = null;
    if (kind === 'quiz') {
      const qs = Array.isArray(req.body.questions) ? req.body.questions : [];
      if (!qs.length || qs.length > 50) throw L.bad('A quiz needs between 1 and 50 questions.');
      quiz = JSON.stringify(qs.map((x, i) => {
        const opts = Array.isArray(x.options) ? x.options.map((o) => L.str(o, { min: 1, max: 300, name: 'Option', required: true })) : [];
        if (opts.length < 2 || opts.length > 6) throw L.bad(`Question ${i + 1}: provide 2–6 options.`);
        const correct = L.int(x.correct, { min: 0, max: opts.length - 1, name: `Correct option for question ${i + 1}` });
        return { text: L.str(x.text, { min: 2, max: 1000, name: `Question ${i + 1}`, required: true }), options: opts, correct };
      }));
    }
    const due = req.body.due_at ? L.str(req.body.due_at, { max: 30 }) : null;
    if (due && Number.isNaN(Date.parse(due))) throw L.bad('Invalid due date.');
    const ins = q.run('INSERT INTO assignments(class_id,kind,title,instructions,due_at,quiz) VALUES(?,?,?,?,?,?)', c.id, kind, title, L.str(req.body.instructions, { max: 4000 }) || null, due, quiz);
    for (const m of q.all('SELECT user_id FROM class_members WHERE class_id=? AND removed=0', c.id)) q.run('INSERT INTO notifications(user_id,title,body,link) VALUES(?,?,?,?)', m.user_id, 'New assignment', `${title} — ${c.name}`, `#/class/${c.id}`);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });

  r.get('/api/classes/:id/assignments', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    const owner = isOwner(req.user, c);
    const rows = q.all('SELECT id,kind,title,instructions,due_at,created_at,quiz FROM assignments WHERE class_id=? ORDER BY id DESC', c.id);
    for (const a of rows) {
      if (a.quiz) { const qs = JSON.parse(a.quiz); a.questions = qs.map((x) => ({ text: x.text, options: x.options })); a.question_count = qs.length; } // answers never leave the server
      delete a.quiz;
      a.mine = owner ? undefined : q.get('SELECT id,answer,auto_score,auto_total,grade,feedback,submitted_at FROM assignment_submissions WHERE assignment_id=? AND user_id=?', a.id, req.user.id) || null;
      if (owner) a.submitted = q.get('SELECT COUNT(*) c FROM assignment_submissions WHERE assignment_id=?', a.id).c;
    }
    res.json({ items: rows });
  });

  r.post('/api/assignments/:id/submit', A.requireRole('student'), (req, res) => {
    const a = q.get('SELECT * FROM assignments WHERE id=?', L.int(req.params.id, { name: 'Assignment' })); if (!a) throw L.notFound();
    const c = loadClass(a.class_id);
    if (!isMember(req.user, c)) throw L.notFound();
    if (q.get('SELECT 1 FROM assignment_submissions WHERE assignment_id=? AND user_id=?', a.id, req.user.id)) throw L.bad('You have already submitted this assignment.');
    if (a.due_at && Date.parse(a.due_at) < Date.now()) throw L.bad('The deadline for this assignment has passed.');
    let answer = null; let score = null; let total = null;
    if (a.kind === 'quiz') {
      const qs = JSON.parse(a.quiz); const given = Array.isArray(req.body.answers) ? req.body.answers : [];
      score = qs.reduce((n, x, i) => n + (Number(given[i]) === x.correct ? 1 : 0), 0); total = qs.length;
      answer = JSON.stringify(given.slice(0, qs.length).map(Number));
    } else answer = L.str(req.body.answer, { min: 1, max: 10000, name: 'Answer', required: true });
    q.run('INSERT INTO assignment_submissions(assignment_id,user_id,answer,auto_score,auto_total) VALUES(?,?,?,?,?)', a.id, req.user.id, answer, score, total);
    res.json(201, { auto_score: score, auto_total: total });
  });

  r.get('/api/assignments/:id/submissions', A.requireUser, (req, res) => {
    const a = q.get('SELECT * FROM assignments WHERE id=?', L.int(req.params.id, { name: 'Assignment' })); if (!a) throw L.notFound();
    assertOwner(req, loadClass(a.class_id));
    res.json({ items: q.all(`SELECT s.id,s.user_id,u.full_name,s.answer,s.auto_score,s.auto_total,s.grade,s.feedback,s.submitted_at FROM assignment_submissions s JOIN users u ON u.id=s.user_id WHERE s.assignment_id=? ORDER BY u.full_name`, a.id) });
  });
  r.put('/api/assignment-submissions/:id/grade', A.requireUser, (req, res) => {
    const s = q.get('SELECT * FROM assignment_submissions WHERE id=?', L.int(req.params.id, { name: 'Submission' })); if (!s) throw L.notFound();
    const a = q.get('SELECT * FROM assignments WHERE id=?', s.assignment_id);
    assertOwner(req, loadClass(a.class_id));
    q.run("UPDATE assignment_submissions SET grade=?, feedback=?, graded_at=datetime('now') WHERE id=?", L.str(req.body.grade, { max: 20 }) || null, L.str(req.body.feedback, { max: 3000 }) || null, s.id);
    q.run('INSERT INTO notifications(user_id,title,body,link) VALUES(?,?,?,?)', s.user_id, 'Assignment marked', a.title, `#/class/${a.class_id}`);
    res.json({ ok: true });
  });

  // ---- moderated chat ---------------------------------------------------------------------------------
  r.get('/api/classes/:id/messages', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    const after = Number(req.query.after) || 0;
    const rows = q.all(`SELECT m.id,m.user_id,u.full_name,m.body,m.created_at, (u.id=?) mine FROM class_messages m JOIN users u ON u.id=m.user_id
      WHERE m.class_id=? AND m.deleted=0 AND m.id>? ORDER BY m.id DESC LIMIT 100`, req.user.id, c.id, after).reverse();
    res.json({ items: rows.map((m) => ({ ...m, mine: !!m.mine, is_teacher: m.user_id === c.teacher_id })) });
  });
  r.post('/api/classes/:id/messages', A.requireUser, L.rateLimit('chat', 30, 60e3, (req) => String(req.user && req.user.id)), (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    if (c.archived) throw L.forbidden('This class is archived.');
    if (!isOwner(req.user, c)) { const m = q.get('SELECT muted FROM class_members WHERE class_id=? AND user_id=? AND removed=0', c.id, req.user.id); if (!m) throw L.forbidden(); if (m.muted) throw L.forbidden('You have been muted in this class.'); }
    const body = L.str(req.body.body, { min: 1, max: 1000, name: 'Message', required: true });
    const ins = q.run('INSERT INTO class_messages(class_id,user_id,body) VALUES(?,?,?)', c.id, req.user.id, body);
    res.json(201, { id: Number(ins.lastInsertRowid) });
  });
  r.del('/api/classes/:id/messages/:mid', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    const m = q.get('SELECT * FROM class_messages WHERE id=? AND class_id=?', L.int(req.params.mid, { name: 'Message' }), c.id); if (!m) throw L.notFound();
    if (m.user_id !== req.user.id && !isOwner(req.user, c) && !A.isAdmin(req.user)) throw L.forbidden();
    q.run('UPDATE class_messages SET deleted=1 WHERE id=?', m.id);
    res.json({ ok: true });
  });
  r.post('/api/classes/:id/messages/:mid/report', A.requireUser, (req, res) => {
    const c = loadClass(req.params.id); assertAccess(req, c);
    const m = q.get('SELECT * FROM class_messages WHERE id=? AND class_id=?', L.int(req.params.mid, { name: 'Message' }), c.id); if (!m) throw L.notFound();
    q.run("INSERT INTO inbox(type,user_id,name,subject,message,ref_id) VALUES('message_report',?,?,?,?,?)", req.user.id, req.user.full_name, `Reported message in "${c.name}"`,
      `Message #${m.id} by user #${m.user_id}: ${m.body.slice(0, 300)}${req.body.reason ? '\nReason: ' + L.str(req.body.reason, { max: 500 }) : ''}`, m.id);
    res.json({ ok: true });
  });
};
