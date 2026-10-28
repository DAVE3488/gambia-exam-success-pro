'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');
const { q, tx, audit, notify, getSetting } = require('../db');
const L = require('../lib');
const A = require('../auth');
const X = require('../extract');
const INT = require('../integrations');

const STATUS_EDITABLE = ['draft', 'in_review'];
const OFFICIAL_OK_SOURCES = ['supervisor_verified', 'admin_verified', 'official_scheme'];
const contentTypes = () => JSON.parse(getSetting('content_types') || '[]');

// ---- access helpers -----------------------------------------------------------------
function load(id) {
  const s = q.get('SELECT * FROM submissions WHERE id=?', L.int(id, { name: 'Submission' }));
  if (!s) throw L.notFound('Submission not found.');
  return s;
}
function canView(u, s) {
  if (A.isAdmin(u)) return true;
  if (u.role === 'supervisor') return s.supervisor_id === u.id;
  if (u.role === 'teacher') return s.uploader_id === u.id;
  return false;
}
function assertView(req, s) { if (!canView(req.user, s)) throw L.notFound('Submission not found.'); } // 404, do not reveal existence
function canEdit(u, s) {
  if (A.isAdmin(u)) return STATUS_EDITABLE.includes(s.status);
  if (u.role === 'supervisor') return s.supervisor_id === u.id && s.status === 'in_review';
  if (u.role === 'teacher') return s.uploader_id === u.id && s.status === 'draft';
  return false;
}
function assertEdit(req, s) {
  assertView(req, s);
  if (!canEdit(req.user, s)) {
    if (['approved', 'published', 'archived'].includes(s.status)) throw L.forbidden(`This content is ${s.status} and locked. Reopen or unpublish it first.`);
    throw L.forbidden('You cannot edit this submission in its current state.');
  }
}

function snapshot(subId, userId, note) {
  const s = q.get('SELECT * FROM submissions WHERE id=?', subId);
  const qs = q.all('SELECT * FROM questions WHERE submission_id=? ORDER BY position,id', subId);
  for (const x of qs) x.options = q.all('SELECT label,text,is_correct,why FROM options WHERE question_id=? ORDER BY label', x.id);
  const v = (q.get('SELECT COALESCE(MAX(version),0) v FROM versions WHERE submission_id=?', subId).v) + 1;
  q.run('INSERT INTO versions(submission_id,version,snapshot,changed_by,note) VALUES(?,?,?,?,?)', subId, v,
    JSON.stringify({ meta: { title: s.title, status: s.status, year: s.year, topic: s.topic }, questions: qs }), userId, note || null);
  return v;
}
function event(subId, user, action, from, to, comment) {
  q.run('INSERT INTO review_events(submission_id,actor_id,action,from_status,to_status,comment) VALUES(?,?,?,?,?,?)', subId, user.id, action, from || null, to || null, comment || null);
}
function touch(id) { q.run("UPDATE submissions SET updated_at=datetime('now') WHERE id=?", id); }

function detail(s, { forStaff = true } = {}) {
  const names = (id) => (id ? (q.get('SELECT full_name FROM users WHERE id=?', id) || {}).full_name || null : null);
  const exam = q.get('SELECT code,name FROM exams WHERE id=?', s.exam_id);
  const subj = q.get('SELECT name FROM subjects WHERE id=?', s.subject_id);
  const pt = s.paper_type_id ? q.get('SELECT name FROM paper_types WHERE id=?', s.paper_type_id) : null;
  return {
    ...s, exam_code: exam.code, exam_name: exam.name, subject_name: subj.name, paper_type: pt && pt.name,
    uploader_name: names(s.uploader_id), supervisor_name: names(s.supervisor_id), reviewer_name: names(s.reviewer_id),
    approver_name: names(s.approver_id), publisher_name: names(s.published_by),
  };
}
function questionsOf(subId) {
  const qs = q.all('SELECT * FROM questions WHERE submission_id=? ORDER BY position,id', subId);
  for (const x of qs) {
    x.options = q.all('SELECT id,label,text,is_correct,why FROM options WHERE question_id=? ORDER BY label', x.id);
    x.diagrams = q.all("SELECT id FROM files WHERE question_id=? AND role='diagram'", x.id).map((f) => f.id);
  }
  return qs;
}

function validateQuestionInput(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.text !== undefined) out.text = L.str(b.text, { min: 2, max: 8000, name: 'Question text', required: true });
  if (!partial || b.type !== undefined) { if (!['objective', 'theory'].includes(b.type)) throw L.bad('Question type must be objective or theory.'); out.type = b.type; }
  for (const k of ['number', 'topic']) if (b[k] !== undefined) out[k] = L.str(b[k], { max: 60, name: k }) || null;
  for (const k of ['model_answer', 'marking_guide', 'explanation', 'common_mistakes']) if (b[k] !== undefined) out[k] = L.str(b[k], { max: 12000, name: k }) || null;
  if (b.marks !== undefined) out.marks = b.marks === '' || b.marks === null ? null : L.int(b.marks, { min: 0, max: 200, name: 'Marks' });
  if (b.page_ref !== undefined) out.page_ref = b.page_ref === '' || b.page_ref === null ? null : L.int(b.page_ref, { min: 1, max: 2000, name: 'Page' });
  if (b.answer_source !== undefined) {
    if (!['none', 'ai_draft', 'teacher_prepared', 'supervisor_verified', 'admin_verified', 'official_scheme'].includes(b.answer_source)) throw L.bad('Invalid answer source.');
    out.answer_source = b.answer_source;
  }
  return out;
}
function validateOptions(opts) {
  if (!Array.isArray(opts)) throw L.bad('Options must be a list.');
  if (opts.length < 2 || opts.length > 8) throw L.bad('Objective questions need 2 to 8 options.');
  const seen = new Set(); let correct = 0;
  const clean = opts.map((o) => {
    const label = L.str(o.label, { min: 1, max: 2, name: 'Option label', required: true }).toUpperCase();
    if (seen.has(label)) throw L.bad(`Duplicate option label ${label}.`);
    seen.add(label);
    if (o.is_correct) correct++;
    return { label, text: L.str(o.text, { min: 1, max: 1500, name: `Option ${label}`, required: true }), is_correct: o.is_correct ? 1 : 0, why: L.str(o.why, { max: 1500, name: 'Reason' }) || null };
  });
  if (correct > 1) throw L.bad('Only one option can be marked correct.');
  return clean;
}
function saveOptions(qid, opts) {
  q.run('DELETE FROM options WHERE question_id=?', qid);
  for (const o of opts) q.run('INSERT INTO options(question_id,label,text,is_correct,why) VALUES(?,?,?,?,?)', qid, o.label, o.text, o.is_correct, o.why);
}

/** Everything that must be true before a submission may be approved. Returns a list of problems. */
function approvalProblems(s) {
  const problems = [];
  if (s.section === 'paper') {
    const qs = questionsOf(s.id);
    if (!qs.length) problems.push('A paper needs at least one question.');
    for (const x of qs) {
      const tag = `Q${x.number || x.position + 1}`;
      if (x.type === 'objective') {
        if (x.options.length < 2) problems.push(`${tag}: needs at least two options.`);
        if (x.options.filter((o) => o.is_correct).length !== 1) problems.push(`${tag}: needs exactly one correct option.`);
      } else if (!x.model_answer) problems.push(`${tag}: needs a model answer.`);
      if (x.answer_source === 'ai_draft') problems.push(`${tag}: answer is an unverified AI draft. Verify or edit it first.`);
      else if (x.answer_source === 'none') problems.push(`${tag}: no answer has been prepared.`);
      else if (s.origin === 'official' && !OFFICIAL_OK_SOURCES.includes(x.answer_source)) problems.push(`${tag}: answers on an official paper must be verified (not just teacher-prepared).`);
    }
  } else {
    const hasFile = q.get('SELECT 1 FROM files WHERE submission_id=?', s.id);
    if (!(s.body && s.body.trim()) && !hasFile) problems.push('Learning material needs a file or typed content.');
  }
  if (!s.provenance || s.provenance.trim().length < 5) problems.push('Source / provenance details are required.');
  return problems;
}

async function storeFiles(files, { sub, uploader, role = 'original', questionId = null, allowDocx = false, studentVisible = 0 }) {
  const saved = [];
  for (const f of files) {
    if (f.data.length > cfg.MAX_UPLOAD_BYTES) throw L.bad(`"${f.filename}" is larger than ${cfg.MAX_UPLOAD_BYTES / 1048576} MB.`);
    if (!f.data.length) throw L.bad(`"${f.filename}" is empty.`);
    const t = L.sniff(f.data);
    if (!t || (t.ext === '.docx' && !allowDocx)) throw L.bad(`"${f.filename}" is not an allowed file type (PDF, PNG, JPEG, WebP${allowDocx ? ', DOCX' : ''}).`);
    if (role === 'diagram' && !t.mime.startsWith('image/')) throw L.bad('Diagrams must be images.');
    const stored = crypto.randomBytes(18).toString('hex') + t.ext;
    fs.writeFileSync(path.join(cfg.PRIVATE_DIR, stored), f.data, { mode: 0o600 });
    const pages = t.mime === 'application/pdf' ? await X.pdfPageCount(path.join(cfg.PRIVATE_DIR, stored)) : 1;
    const orig = path.basename(f.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file' + t.ext;
    const ins = q.run('INSERT INTO files(submission_id,question_id,role,orig_name,stored_name,mime,size,sha256,pages,uploader_id,student_visible) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      sub, questionId, role, orig, stored, t.mime, f.data.length, L.sha256(f.data.toString('latin1')), pages, uploader.id, studentVisible);
    saved.push({ id: Number(ins.lastInsertRowid), orig_name: orig, mime: t.mime, size: f.data.length, pages });
  }
  return saved;
}

module.exports = (r) => {
  // ---- catalog for upload forms (staff + teachers) --------------------------------------
  r.get('/api/content/catalog', A.requireStaffOrTeacher, (req, res) => {
    res.json({
      exams: q.all('SELECT id,code,name,grade FROM exams WHERE active=1 ORDER BY sort'),
      subjects: q.all('SELECT s.id,s.name,s.exam_id FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE s.active=1 AND e.active=1 ORDER BY s.sort,s.name'),
      paper_types: q.all('SELECT id,name FROM paper_types WHERE active=1 ORDER BY sort'),
      content_types: contentTypes(), year_min: Number(getSetting('year_min')), year_max: Number(getSetting('year_max')),
      services: { ai: INT.status().ai.configured, ocr: INT.status().ocr.configured, pdf_text: INT.status().pdf_text.configured },
    });
  });

  // ---- create (upload) ----------------------------------------------------------------------
  r.post('/api/content/submissions', A.requireStaffOrTeacher, async (req, res) => {
    if (req.user.role === 'supervisor') throw L.forbidden('Supervisors review content; they do not upload it.');
    const b = req.body;
    const exam_id = L.int(b.exam_id, { name: 'Examination' });
    const subject_id = L.int(b.subject_id, { name: 'Subject' });
    const subj = q.get('SELECT * FROM subjects WHERE id=? AND active=1', subject_id);
    if (!subj || subj.exam_id !== exam_id) throw L.bad('That subject does not belong to the selected examination.');
    const ct = contentTypes().find((c) => c.id === b.content_type);
    if (!ct) throw L.bad('Choose a content type.');
    const yMin = Number(getSetting('year_min')); const yMax = Number(getSetting('year_max'));
    const year = b.year === '' || b.year == null ? null : L.int(b.year, { min: yMin, max: yMax, name: 'Year' });
    if (ct.section === 'paper' && year == null) throw L.bad('Examination year is required for papers.');
    let paper_type_id = null;
    if (b.paper_type_id) { paper_type_id = L.int(b.paper_type_id, { name: 'Paper' }); if (!q.get('SELECT 1 FROM paper_types WHERE id=? AND active=1', paper_type_id)) throw L.bad('Unknown paper type.'); }
    if (ct.section === 'paper' && !paper_type_id) throw L.bad('Choose the paper (e.g. Paper 1).');
    const origin = req.user.role === 'teacher' ? 'teacher' : (['official', 'practice', 'teacher', 'ai'].includes(b.origin) ? b.origin : 'official');
    if (req.user.role === 'teacher' && ct.id === 'past_paper') throw L.forbidden('Teachers submit practice material, not official past papers. Choose "Practice Exercise" or a learning-material type.');
    const title = L.str(b.title, { min: 3, max: 200, name: 'Title', required: true });
    const provenance = L.str(b.provenance, { min: 5, max: 2000, name: 'Source / provenance', required: true });
    const body = L.str(b.body, { max: 200000, name: 'Typed content' });
    if (!req.files.length && !body && ct.section === 'material') throw L.bad('Attach a file or type the content.');
    if (!req.files.length && !body && ct.section === 'paper') throw L.bad('Attach the paper (PDF or photos) or paste the typed questions.');
    let id;
    try {
      id = tx(() => {
        const ins = q.run(`INSERT INTO submissions(title,exam_id,subject_id,year,paper_type_id,content_type,section,origin,topic,body,provenance,uploader_id,time_limit_min)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, title, exam_id, subject_id, year, paper_type_id, ct.id, ct.section, origin,
          L.str(b.topic, { max: 120 }) || null, body || null, provenance, req.user.id, b.time_limit_min ? L.int(b.time_limit_min, { min: 1, max: 360, name: 'Time limit' }) : null);
        const sid = Number(ins.lastInsertRowid);
        event(sid, req.user, 'created', null, 'draft', null);
        return sid;
      });
      await storeFiles(req.files, { sub: id, uploader: req.user, allowDocx: ct.section === 'material' });
    } catch (e) {
      if (id) { // do not leave a half-created submission behind a failed upload
        for (const f of q.all('SELECT stored_name FROM files WHERE submission_id=?', id)) fs.rm(path.join(cfg.PRIVATE_DIR, f.stored_name), () => {});
        q.run('DELETE FROM submissions WHERE id=?', id);
      }
      throw e;
    }
    snapshot(id, req.user.id, 'Created');
    audit(req.user, 'submission_created', 'submission', id, { title, files: req.files.length }, 'content', req.ip);
    res.json(201, { id });
  });

  // ---- list ------------------------------------------------------------------------------------------
  r.get('/api/content/submissions', A.requireStaffOrTeacher, (req, res) => {
    const where = []; const p = []; const Q = req.query;
    if (req.user.role === 'supervisor') { where.push('s.supervisor_id=?'); p.push(req.user.id); }
    else if (req.user.role === 'teacher') { where.push('s.uploader_id=?'); p.push(req.user.id); }
    const eq = (col, v) => { if (v !== undefined && v !== '') { where.push(`${col}=?`); p.push(v); } };
    eq('s.exam_id', Q.exam_id); eq('s.subject_id', Q.subject_id); eq('s.year', Q.year); eq('s.status', Q.status);
    eq('s.uploader_id', Q.uploader_id); eq('s.supervisor_id', Q.supervisor_id); eq('s.review_status', Q.review_status); eq('s.section', Q.section);
    if (Q.stage === 'awaiting_review') where.push("s.status='in_review' AND s.review_status='pending'");
    if (Q.stage === 'awaiting_approval') where.push("s.status='in_review' AND s.review_status IN('recommend_approval','recommend_rejection','corrections_requested')");
    if (Q.q) { where.push('s.title LIKE ?'); p.push(`%${String(Q.q).slice(0, 80)}%`); }
    const rows = q.all(`SELECT s.id,s.title,s.status,s.review_status,s.section,s.content_type,s.origin,s.year,s.updated_at,s.created_at,
        e.code exam_code, sb.name subject_name, pt.name paper_type, u.full_name uploader_name, sv.full_name supervisor_name, s.supervisor_id, s.assigned_at,
        (SELECT COUNT(*) FROM questions WHERE submission_id=s.id) question_count
      FROM submissions s JOIN exams e ON e.id=s.exam_id JOIN subjects sb ON sb.id=s.subject_id
      LEFT JOIN paper_types pt ON pt.id=s.paper_type_id JOIN users u ON u.id=s.uploader_id LEFT JOIN users sv ON sv.id=s.supervisor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.updated_at DESC, s.id DESC LIMIT 300`, ...p);
    res.json({ items: rows });
  });

  // ---- detail -------------------------------------------------------------------------------------------
  r.get('/api/content/submissions/:id', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertView(req, s);
    res.json({
      submission: detail(s), questions: questionsOf(s.id), can_edit: canEdit(req.user, s),
      files: q.all('SELECT id,role,orig_name,mime,size,pages,student_visible,question_id,created_at FROM files WHERE submission_id=? ORDER BY id', s.id),
      events: q.all('SELECT e.*, u.full_name actor_name FROM review_events e JOIN users u ON u.id=e.actor_id WHERE submission_id=? ORDER BY e.id DESC', s.id),
      versions: q.all('SELECT v.id,v.version,v.note,v.created_at,u.full_name changed_by_name FROM versions v LEFT JOIN users u ON u.id=v.changed_by WHERE submission_id=? ORDER BY version DESC', s.id),
      problems: s.status === 'draft' || s.status === 'in_review' ? approvalProblems(s) : [],
      eligible_supervisors: A.isAdmin(req.user) ? q.all(`SELECT u.id,u.full_name FROM users u JOIN supervisor_subjects ss ON ss.user_id=u.id
        WHERE ss.subject_id=? AND u.role='supervisor' AND u.status='active' AND u.id!=?`, s.subject_id, s.uploader_id) : [],
    });
  });
  r.get('/api/content/submissions/:id/versions/:vid', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertView(req, s);
    const v = q.get('SELECT * FROM versions WHERE id=? AND submission_id=?', L.int(req.params.vid, { name: 'Version' }), s.id);
    if (!v) throw L.notFound();
    res.json({ version: v.version, created_at: v.created_at, snapshot: JSON.parse(v.snapshot) });
  });

  // ---- original files (private; streamed only after an authorisation check) ----------------------------------
  r.get('/api/files/:id', A.requireUser, (req, res) => {
    const f = q.get('SELECT * FROM files WHERE id=?', L.int(req.params.id, { name: 'File' }));
    if (!f) throw L.notFound();
    const s = f.submission_id ? q.get('SELECT * FROM submissions WHERE id=?', f.submission_id) : null;
    let ok = false;
    if (s && canView(req.user, s)) ok = true;
    else if (s && s.status === 'published' && (f.student_visible || f.role === 'diagram')) ok = true; // students: published + cleared for distribution only
    if (!ok) throw L.notFound();
    res.sendFile(path.join(cfg.PRIVATE_DIR, path.basename(f.stored_name)), {
      'Content-Type': f.mime, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${f.orig_name.replace(/"/g, '')}"`,
      'Cache-Control': s && s.status === 'published' ? 'private, max-age=3600' : 'private, no-store',
    });
  });
  r.put('/api/content/files/:id', A.requireAdmin, (req, res) => {
    const f = q.get('SELECT * FROM files WHERE id=?', L.int(req.params.id, { name: 'File' })); if (!f) throw L.notFound();
    q.run('UPDATE files SET student_visible=? WHERE id=?', req.body.student_visible ? 1 : 0, f.id);
    audit(req.user, req.body.student_visible ? 'file_cleared_for_students' : 'file_hidden_from_students', 'file', f.id, null, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/content/submissions/:id/files', A.requireStaffOrTeacher, async (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    if (!req.files.length) throw L.bad('Choose a file.');
    const role = ['original', 'answer_key', 'material'].includes(req.body.role) ? req.body.role : 'original';
    const saved = await storeFiles(req.files, { sub: s.id, uploader: req.user, role, allowDocx: s.section === 'material' });
    touch(s.id); audit(req.user, 'file_added', 'submission', s.id, saved.map((f) => f.orig_name), 'content', req.ip);
    res.json(201, { files: saved });
  });
  r.post('/api/content/questions/:id/diagram', A.requireStaffOrTeacher, async (req, res) => {
    const qu = q.get('SELECT * FROM questions WHERE id=?', L.int(req.params.id, { name: 'Question' })); if (!qu) throw L.notFound();
    const s = load(qu.submission_id); assertEdit(req, s);
    if (!req.files.length) throw L.bad('Choose an image.');
    const saved = await storeFiles(req.files.slice(0, 1), { sub: s.id, uploader: req.user, role: 'diagram', questionId: qu.id });
    audit(req.user, 'diagram_added', 'question', qu.id, null, 'content', req.ip);
    res.json(201, { file: saved[0] });
  });
  r.del('/api/content/files/:id', A.requireStaffOrTeacher, (req, res) => {
    const f = q.get('SELECT * FROM files WHERE id=?', L.int(req.params.id, { name: 'File' })); if (!f) throw L.notFound();
    const s = load(f.submission_id); assertEdit(req, s);
    if (f.role === 'original' && !q.get("SELECT 1 FROM files WHERE submission_id=? AND role='original' AND id!=?", s.id, f.id) && s.section === 'paper')
      throw L.bad('A paper must keep its original source file.');
    q.run('DELETE FROM files WHERE id=?', f.id);
    fs.rm(path.join(cfg.PRIVATE_DIR, path.basename(f.stored_name)), () => {});
    audit(req.user, 'file_removed', 'submission', s.id, f.orig_name, 'content', req.ip);
    res.json({ ok: true });
  });

  // ---- metadata edit ------------------------------------------------------------------------------------------------
  r.put('/api/content/submissions/:id', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    const b = req.body;
    const title = L.str(b.title ?? s.title, { min: 3, max: 200, name: 'Title', required: true });
    const provenance = L.str(b.provenance ?? s.provenance, { min: 5, max: 2000, name: 'Provenance', required: true });
    const topic = b.topic === undefined ? s.topic : (L.str(b.topic, { max: 120 }) || null);
    const body = b.body === undefined ? s.body : (L.str(b.body, { max: 200000 }) || null);
    let origin = s.origin;
    if (b.origin !== undefined && A.isAdmin(req.user)) { if (!['official', 'practice', 'teacher', 'ai'].includes(b.origin)) throw L.bad('Invalid origin.'); origin = b.origin; }
    const tl = b.time_limit_min === undefined ? s.time_limit_min : (b.time_limit_min ? L.int(b.time_limit_min, { min: 1, max: 360, name: 'Time limit' }) : null);
    q.run("UPDATE submissions SET title=?,provenance=?,topic=?,body=?,origin=?,time_limit_min=?,updated_at=datetime('now') WHERE id=?", title, provenance, topic, body, origin, tl, s.id);
    audit(req.user, 'submission_edited', 'submission', s.id, { before: { title: s.title, origin: s.origin, topic: s.topic } }, 'content', req.ip);
    res.json({ ok: true });
  });
  r.del('/api/content/submissions/:id', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertView(req, s);
    if (s.status !== 'draft') throw L.forbidden('Only drafts can be deleted. Archive anything else.');
    if (!(A.isAdmin(req.user) || s.uploader_id === req.user.id)) throw L.forbidden();
    for (const f of q.all('SELECT stored_name FROM files WHERE submission_id=?', s.id)) fs.rm(path.join(cfg.PRIVATE_DIR, f.stored_name), () => {});
    audit(req.user, 'draft_deleted', 'submission', s.id, s.title, 'content', req.ip);
    q.run('DELETE FROM submissions WHERE id=?', s.id);
    res.json({ ok: true });
  });

  // ---- extraction -------------------------------------------------------------------------------------------------------------
  r.post('/api/content/submissions/:id/extract', A.requireStaffOrTeacher, async (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    if (s.section !== 'paper') throw L.bad('Extraction applies to papers and exercises.');
    const replace = !!req.body.replace;
    const files = q.all("SELECT * FROM files WHERE submission_id=? AND role='original' ORDER BY id", s.id);
    let pages = []; const warnings = []; const methods = [];
    let offset = 0;
    for (const f of files) {
      const ex = await X.extractFile(path.join(cfg.PRIVATE_DIR, path.basename(f.stored_name)), f.mime);
      warnings.push(...ex.warnings.map((w) => `${f.orig_name}: ${w}`)); methods.push(ex.method);
      pages = pages.concat(ex.pages); offset += ex.pages.length;
    }
    if (s.body && s.body.trim() && !files.length) pages = [s.body];
    const drafts = X.parseQuestions(pages);
    if (!drafts.length) warnings.push('No questions were detected. Add them manually or paste typed questions.');
    tx(() => {
      if (replace) q.run('DELETE FROM questions WHERE submission_id=?', s.id);
      let pos = q.get('SELECT COALESCE(MAX(position),0) m FROM questions WHERE submission_id=?', s.id).m;
      for (const d of drafts) {
        const ins = q.run('INSERT INTO questions(submission_id,position,number,type,text,marks,page_ref) VALUES(?,?,?,?,?,?,?)', s.id, ++pos, d.number, d.type, d.text, d.marks, d.page_ref);
        if (d.type === 'objective') for (const o of d.options) q.run('INSERT INTO options(question_id,label,text) VALUES(?,?,?)', Number(ins.lastInsertRowid), o.label, o.text);
      }
      // keep raw extracted text beside the original so reviewers can compare
      q.run("UPDATE submissions SET body=COALESCE(?,body), updated_at=datetime('now') WHERE id=?", pages.length && files.length ? pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join('\n') : null, s.id);
      snapshot(s.id, req.user.id, `Extraction (${methods.join(',') || 'text'}): ${drafts.length} questions`);
    });
    audit(req.user, 'extraction_run', 'submission', s.id, { questions: drafts.length, methods }, 'content', req.ip);
    res.json({ created: drafts.length, methods, warnings, ocr: INT.status().ocr.configured });
  });

  // typed / pasted questions use the same parser
  r.post('/api/content/submissions/:id/import-text', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    const text = L.str(req.body.text, { min: 5, max: 200000, name: 'Text', required: true });
    const drafts = X.parseQuestions([text]);
    if (!drafts.length) throw L.bad('No numbered questions found. Start each question with "1.", "2." and so on; options as "A.", "B.".');
    tx(() => {
      let pos = q.get('SELECT COALESCE(MAX(position),0) m FROM questions WHERE submission_id=?', s.id).m;
      for (const d of drafts) {
        const ins = q.run('INSERT INTO questions(submission_id,position,number,type,text,marks) VALUES(?,?,?,?,?,?)', s.id, ++pos, d.number, d.type, d.text, d.marks);
        if (d.type === 'objective') for (const o of d.options) q.run('INSERT INTO options(question_id,label,text) VALUES(?,?,?)', Number(ins.lastInsertRowid), o.label, o.text);
      }
      snapshot(s.id, req.user.id, `Typed import: ${drafts.length} questions`);
    });
    touch(s.id); audit(req.user, 'text_imported', 'submission', s.id, { questions: drafts.length }, 'content', req.ip);
    res.json({ created: drafts.length });
  });

  // ---- question CRUD ---------------------------------------------------------------------------------------------------------------------
  r.post('/api/content/submissions/:id/questions', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    const f = validateQuestionInput(req.body);
    const opts = f.type === 'objective' ? validateOptions(req.body.options) : null;
    const id = tx(() => {
      const pos = q.get('SELECT COALESCE(MAX(position),0)+1 p FROM questions WHERE submission_id=?', s.id).p;
      const hasAns = opts ? opts.some((o) => o.is_correct) : !!f.model_answer;
      const src = f.answer_source || (hasAns ? (A.isAdmin(req.user) ? 'admin_verified' : req.user.role === 'supervisor' ? 'supervisor_verified' : 'teacher_prepared') : 'none');
      const ins = q.run('INSERT INTO questions(submission_id,position,number,type,text,marks,topic,page_ref,model_answer,marking_guide,explanation,common_mistakes,answer_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        s.id, pos, f.number ?? String(pos), f.type, f.text, f.marks ?? null, f.topic ?? null, f.page_ref ?? null, f.model_answer ?? null, f.marking_guide ?? null, f.explanation ?? null, f.common_mistakes ?? null, src);
      if (opts) saveOptions(Number(ins.lastInsertRowid), opts);
      return Number(ins.lastInsertRowid);
    });
    touch(s.id); audit(req.user, 'question_added', 'question', id, { submission: s.id }, 'content', req.ip);
    res.json(201, { id });
  });

  r.put('/api/content/questions/:id', A.requireStaffOrTeacher, (req, res) => {
    const old = q.get('SELECT * FROM questions WHERE id=?', L.int(req.params.id, { name: 'Question' })); if (!old) throw L.notFound();
    const s = load(old.submission_id); assertEdit(req, s);
    const f = validateQuestionInput(req.body, { partial: true });
    const type = f.type || old.type;
    const before = { text: old.text, model_answer: old.model_answer, explanation: old.explanation, answer_source: old.answer_source, options: q.all('SELECT label,text,is_correct FROM options WHERE question_id=?', old.id) };
    tx(() => {
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(f)) { sets.push(`${k}=?`); vals.push(v); }
      const answerTouched = ['model_answer', 'marking_guide', 'explanation'].some((k) => k in f) || req.body.options !== undefined;
      if (answerTouched && f.answer_source === undefined) {
        // a human edited the answer: it stops being a raw AI draft, but is not "verified" until someone verifies it
        const prep = A.isAdmin(req.user) ? 'admin_verified' : req.user.role === 'supervisor' ? 'supervisor_verified' : 'teacher_prepared';
        sets.push('answer_source=?'); vals.push(prep);
      }
      if (sets.length) q.run(`UPDATE questions SET ${sets.join(',')}, updated_at=datetime('now') WHERE id=?`, ...vals, old.id);
      if (type === 'objective' && req.body.options !== undefined) saveOptions(old.id, validateOptions(req.body.options));
      if (type === 'theory') q.run('DELETE FROM options WHERE question_id=?', old.id);
      touch(s.id);
    });
    audit(req.user, 'question_edited', 'question', old.id, { submission: s.id, before }, 'content', req.ip);
    res.json({ ok: true });
  });

  r.del('/api/content/questions/:id', A.requireStaffOrTeacher, (req, res) => {
    const old = q.get('SELECT * FROM questions WHERE id=?', L.int(req.params.id, { name: 'Question' })); if (!old) throw L.notFound();
    const s = load(old.submission_id); assertEdit(req, s);
    for (const f of q.all("SELECT stored_name FROM files WHERE question_id=?", old.id)) fs.rm(path.join(cfg.PRIVATE_DIR, f.stored_name), () => {});
    q.run('DELETE FROM files WHERE question_id=?', old.id);
    q.run('DELETE FROM questions WHERE id=?', old.id);
    touch(s.id); audit(req.user, 'question_removed', 'question', old.id, { submission: s.id, text: old.text.slice(0, 200) }, 'content', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/content/submissions/:id/reorder', A.requireStaffOrTeacher, (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    const ids = Array.isArray(req.body.order) ? req.body.order.map(Number) : [];
    const have = q.all('SELECT id FROM questions WHERE submission_id=?', s.id).map((x) => x.id);
    if (ids.length !== have.length || ids.some((i) => !have.includes(i)) || new Set(ids).size !== ids.length) throw L.bad('The new order must list every question exactly once.');
    tx(() => ids.forEach((qid, i) => q.run('UPDATE questions SET position=? WHERE id=?', i + 1, qid)));
    touch(s.id); res.json({ ok: true });
  });

  // marks an answer as checked by the current user (supervisor or admin)
  r.post('/api/content/questions/:id/verify', A.requireStaff, (req, res) => {
    const old = q.get('SELECT * FROM questions WHERE id=?', L.int(req.params.id, { name: 'Question' })); if (!old) throw L.notFound();
    const s = load(old.submission_id); assertEdit(req, s);
    const full = old.type === 'objective' ? q.all('SELECT is_correct FROM options WHERE question_id=?', old.id).some((o) => o.is_correct) : !!old.model_answer;
    if (!full) throw L.bad('There is no answer to verify yet.');
    q.run("UPDATE questions SET answer_source=?, updated_at=datetime('now') WHERE id=?", A.isAdmin(req.user) ? 'admin_verified' : 'supervisor_verified', old.id);
    audit(req.user, 'answer_verified', 'question', old.id, { submission: s.id }, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/content/submissions/:id/verify-all', A.requireStaff, (req, res) => {
    const s = load(req.params.id); assertEdit(req, s);
    const src = A.isAdmin(req.user) ? 'admin_verified' : 'supervisor_verified';
    let n = 0;
    tx(() => {
      for (const x of q.all("SELECT * FROM questions WHERE submission_id=? AND answer_source IN('ai_draft','teacher_prepared')", s.id)) {
        const full = x.type === 'objective' ? q.all('SELECT is_correct FROM options WHERE question_id=?', x.id).some((o) => o.is_correct) : !!x.model_answer;
        if (full) { q.run('UPDATE questions SET answer_source=? WHERE id=?', src, x.id); n++; }
      }
    });
    audit(req.user, 'answers_verified_bulk', 'submission', s.id, { count: n }, 'content', req.ip);
    res.json({ verified: n });
  });

  // ---- AI-assisted answer preparation (only if a provider is configured; output is always an unverified draft) ----------------
  async function aiPrepare(qu) {
    const opts = q.all('SELECT label,text FROM options WHERE question_id=? ORDER BY label', qu.id);
    const prompt = qu.type === 'objective'
      ? `You are helping prepare a model answer for a West African exam. Question: ${qu.text}\nOptions:\n${opts.map((o) => `${o.label}. ${o.text}`).join('\n')}\nReply ONLY with JSON: {"correct":"<letter>","explanation":"why it is correct","why":{"<letter>":"why this option is wrong"}}`
      : `You are helping prepare a model answer for a West African exam. Question: ${qu.text}${qu.marks ? ` (${qu.marks} marks)` : ''}\nReply ONLY with JSON: {"model_answer":"...","marking_guide":"...","explanation":"...","common_mistakes":"..."}`;
    const out = await INT.chat([{ role: 'user', content: prompt }], { maxTokens: 900 });
    if (!out.ok) return out;
    const m = /\{[\s\S]*\}/.exec(out.text); if (!m) return { ok: false, reason: 'unparseable' };
    let j; try { j = JSON.parse(m[0]); } catch { return { ok: false, reason: 'unparseable' }; }
    return { ok: true, data: j, opts };
  }
  r.post('/api/content/questions/:id/ai-draft', A.requireAdmin, async (req, res) => {
    if (!INT.status().ai.configured) throw new L.HttpError(503, 'AI assistance is not configured on this server (needs AI_API_URL, AI_API_KEY, AI_MODEL). Prepare the answer manually.');
    const qu = q.get('SELECT * FROM questions WHERE id=?', L.int(req.params.id, { name: 'Question' })); if (!qu) throw L.notFound();
    const s = load(qu.submission_id); assertEdit(req, s);
    const out = await aiPrepare(qu);
    if (!out.ok) throw new L.HttpError(502, `The AI provider did not return a usable answer (${out.reason}). Nothing was saved.`);
    const j = out.data;
    tx(() => {
      if (qu.type === 'objective') {
        const letter = String(j.correct || '').trim().toUpperCase().slice(0, 1);
        if (!out.opts.some((o) => o.label === letter)) throw L.bad('The AI proposed an option that does not exist. Nothing was saved.');
        for (const o of out.opts) q.run('UPDATE options SET is_correct=?, why=? WHERE question_id=? AND label=?', o.label === letter ? 1 : 0, o.label === letter ? null : String((j.why && j.why[o.label]) || '').slice(0, 1500) || null, qu.id, o.label);
        q.run("UPDATE questions SET explanation=?, answer_source='ai_draft', updated_at=datetime('now') WHERE id=?", String(j.explanation || '').slice(0, 12000) || null, qu.id);
      } else {
        q.run("UPDATE questions SET model_answer=?, marking_guide=?, explanation=?, common_mistakes=?, answer_source='ai_draft', updated_at=datetime('now') WHERE id=?",
          String(j.model_answer || '').slice(0, 12000) || null, String(j.marking_guide || '').slice(0, 12000) || null, String(j.explanation || '').slice(0, 12000) || null, String(j.common_mistakes || '').slice(0, 12000) || null, qu.id);
      }
    });
    audit(req.user, 'ai_draft_generated', 'question', qu.id, null, 'content', req.ip);
    res.json({ ok: true, label: 'AI draft — not verified' });
  });
  r.post('/api/content/submissions/:id/ai-draft', A.requireAdmin, async (req, res) => {
    if (!INT.status().ai.configured) throw new L.HttpError(503, 'AI assistance is not configured on this server (needs AI_API_URL, AI_API_KEY, AI_MODEL). Prepare the answers manually.');
    const s = load(req.params.id); assertEdit(req, s);
    let done = 0; let failed = 0;
    for (const qu of q.all("SELECT * FROM questions WHERE submission_id=? AND answer_source='none' ORDER BY position LIMIT 30", s.id)) {
      const out = await aiPrepare(qu);
      if (!out.ok) { failed++; continue; }
      try {
        const j = out.data;
        if (qu.type === 'objective') {
          const letter = String(j.correct || '').trim().toUpperCase().slice(0, 1);
          if (!out.opts.some((o) => o.label === letter)) { failed++; continue; }
          for (const o of out.opts) q.run('UPDATE options SET is_correct=?, why=? WHERE question_id=? AND label=?', o.label === letter ? 1 : 0, o.label === letter ? null : String((j.why && j.why[o.label]) || '').slice(0, 1500) || null, qu.id, o.label);
          q.run("UPDATE questions SET explanation=?, answer_source='ai_draft' WHERE id=?", String(j.explanation || '').slice(0, 12000) || null, qu.id);
        } else q.run("UPDATE questions SET model_answer=?, marking_guide=?, explanation=?, common_mistakes=?, answer_source='ai_draft' WHERE id=?",
          String(j.model_answer || '').slice(0, 12000) || null, String(j.marking_guide || '').slice(0, 12000) || null, String(j.explanation || '').slice(0, 12000) || null, String(j.common_mistakes || '').slice(0, 12000) || null, qu.id);
        done++;
      } catch { failed++; }
    }
    audit(req.user, 'ai_draft_batch', 'submission', s.id, { done, failed }, 'content', req.ip);
    res.json({ drafted: done, failed, label: 'AI drafts — not verified' });
  });

  // ---- assignment / review / decisions ------------------------------------------------------------------------------------------------------
  r.post('/api/content/submissions/:id/assign', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (!['draft', 'in_review'].includes(s.status)) throw L.bad('Only drafts or items in review can be assigned.');
    const sup = q.get("SELECT * FROM users WHERE id=? AND role='supervisor' AND status='active'", L.int(req.body.supervisor_id, { name: 'Supervisor' }));
    if (!sup) throw L.bad('Choose an active supervisor.');
    if (!q.get('SELECT 1 FROM supervisor_subjects WHERE user_id=? AND subject_id=?', sup.id, s.subject_id)) throw L.bad('That supervisor is not assigned to this subject.');
    if (sup.id === s.uploader_id) throw L.bad('A supervisor cannot review content they uploaded.');
    if (s.section === 'paper' && !q.get('SELECT 1 FROM questions WHERE submission_id=?', s.id)) throw L.bad('Add or extract at least one question before assigning a review.');
    const from = s.status;
    tx(() => {
      q.run("UPDATE submissions SET status='in_review', supervisor_id=?, assigned_at=datetime('now'), assigned_by=?, review_status='pending', reviewer_id=NULL, reviewed_at=NULL, review_comment=NULL, updated_at=datetime('now') WHERE id=?", sup.id, req.user.id, s.id);
      event(s.id, req.user, 'assigned', from, 'in_review', `Assigned to ${sup.full_name}${req.body.note ? ': ' + L.str(req.body.note, { max: 500 }) : ''}`);
      snapshot(s.id, req.user.id, 'Assigned for review');
    });
    notify(sup.id, 'New content to review', s.title, `#/staff/review/${s.id}`);
    audit(req.user, 'review_assigned', 'submission', s.id, { supervisor: sup.id }, 'content', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/content/submissions/:id/review', A.requireRole('supervisor'), (req, res) => {
    const s = load(req.params.id); assertView(req, s);
    if (s.status !== 'in_review') throw L.bad('This submission is not awaiting review.');
    const map = { recommend_approval: 'recommend_approval', request_corrections: 'corrections_requested', recommend_rejection: 'recommend_rejection' };
    const rs = map[req.body.action]; if (!rs) throw L.bad('Choose a review outcome.');
    const comment = L.str(req.body.comment, { max: 3000, name: 'Comment' });
    if (rs !== 'recommend_approval' && comment.length < 5) throw L.bad('Please explain what needs correcting or why you recommend rejection.');
    if (rs === 'recommend_approval') {
      const p = approvalProblems(s).filter((x) => !/provenance/i.test(x));
      if (p.length) throw L.bad('Resolve these before recommending approval:', { problems: p });
    }
    tx(() => {
      q.run("UPDATE submissions SET review_status=?, reviewer_id=?, reviewed_at=datetime('now'), review_comment=?, updated_at=datetime('now') WHERE id=?", rs, req.user.id, comment || null, s.id);
      event(s.id, req.user, 'reviewed:' + rs, 'in_review', 'in_review', comment);
      snapshot(s.id, req.user.id, 'Review: ' + rs);
    });
    const notifyIds = new Set([s.assigned_by, s.uploader_id].filter(Boolean));
    for (const id of notifyIds) notify(id, 'Review submitted', `${req.user.full_name}: ${rs.replace(/_/g, ' ')} — ${s.title}`, `#/admin/content/${s.id}`);
    audit(req.user, 'review_submitted', 'submission', s.id, { outcome: rs }, 'content', req.ip);
    res.json({ ok: true });
  });

  r.post('/api/content/submissions/:id/decide', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (!['draft', 'in_review'].includes(s.status)) throw L.bad('This submission has already been decided.');
    const d = req.body.decision;
    const comment = L.str(req.body.comment, { max: 3000, name: 'Comment' });
    if (d === 'approve') {
      const problems = approvalProblems(s);
      if (problems.length) throw L.bad('This submission cannot be approved yet.', { problems });
      if (s.status === 'in_review' && s.review_status === 'pending' && s.supervisor_id && !req.body.override_pending_review)
        throw L.bad('A supervisor review is still pending. Wait for it, reassign, or explicitly override.');
      if (s.review_status === 'corrections_requested' && s.supervisor_id) throw L.bad('The supervisor requested corrections. Return it to draft or reassign it.');
      tx(() => {
        const reviewer = s.reviewer_id || req.user.id; // an administrator reviewing for themselves is recorded as such
        q.run("UPDATE submissions SET status='approved', approver_id=?, approved_at=datetime('now'), reviewer_id=?, reviewed_at=COALESCE(reviewed_at,datetime('now')), updated_at=datetime('now') WHERE id=?", req.user.id, reviewer, s.id);
        event(s.id, req.user, 'approved', s.status, 'approved', comment);
        snapshot(s.id, req.user.id, 'Approved (not yet published)');
      });
      notify(s.uploader_id, 'Your submission was approved', `${s.title} — awaiting publication.`, '#/');
    } else if (d === 'reject') {
      if (comment.length < 5) throw L.bad('Please give a reason for rejection.');
      tx(() => {
        q.run("UPDATE submissions SET status='rejected', rejection_reason=?, updated_at=datetime('now') WHERE id=?", comment, s.id);
        event(s.id, req.user, 'rejected', s.status, 'rejected', comment); snapshot(s.id, req.user.id, 'Rejected');
      });
      notify(s.uploader_id, 'Your submission was rejected', `${s.title}: ${comment}`, '#/');
    } else if (d === 'return') {
      if (comment.length < 5) throw L.bad('Please say what needs correcting.');
      tx(() => {
        q.run("UPDATE submissions SET status='draft', correction_note=?, review_status='none', supervisor_id=NULL, updated_at=datetime('now') WHERE id=?", comment, s.id);
        event(s.id, req.user, 'returned_for_corrections', s.status, 'draft', comment); snapshot(s.id, req.user.id, 'Returned for corrections');
      });
      notify(s.uploader_id, 'Corrections requested', `${s.title}: ${comment}`, '#/');
    } else if (d === 'reassign') {
      return res.json({ redirect: 'assign' });
    } else throw L.bad('Invalid decision.');
    audit(req.user, 'decision_' + d, 'submission', s.id, { comment }, 'content', req.ip);
    res.json({ ok: true });
  });

  // reopen a rejected / approved item for further work (clears the approval; history is preserved in events + versions)
  r.post('/api/content/submissions/:id/reopen', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (!['rejected', 'approved'].includes(s.status)) throw L.bad('Only rejected or approved (unpublished) items can be reopened. Unpublish published items first.');
    tx(() => {
      q.run("UPDATE submissions SET status='draft', approver_id=NULL, approved_at=NULL, review_status='none', supervisor_id=NULL, reviewer_id=NULL, reviewed_at=NULL, updated_at=datetime('now') WHERE id=?", s.id);
      event(s.id, req.user, 'reopened', s.status, 'draft', L.str(req.body.comment, { max: 1000 }) || null);
      snapshot(s.id, req.user.id, 'Reopened');
    });
    audit(req.user, 'submission_reopened', 'submission', s.id, { from: s.status }, 'content', req.ip);
    res.json({ ok: true });
  });

  // ---- publishing: a separate, explicit act after approval ---------------------------------------------------------------------------------------------
  r.post('/api/content/submissions/:id/publish', A.requirePublisher, (req, res) => {
    const s = load(req.params.id);
    if (s.status !== 'approved') throw L.bad('Only approved content can be published.');
    const problems = approvalProblems(s); if (problems.length) throw L.bad('Content no longer meets the publishing requirements.', { problems });
    tx(() => {
      q.run("UPDATE submissions SET status='published', published_by=?, published_at=datetime('now'), updated_at=datetime('now') WHERE id=?", req.user.id, s.id);
      event(s.id, req.user, 'published', 'approved', 'published', null); snapshot(s.id, req.user.id, 'Published');
    });
    audit(req.user, 'published', 'submission', s.id, { title: s.title }, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/content/submissions/:id/unpublish', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (s.status !== 'published') throw L.bad('Only published content can be unpublished.');
    const comment = L.str(req.body.comment, { min: 3, max: 1000, name: 'Reason', required: true });
    tx(() => {
      q.run("UPDATE submissions SET status='approved', updated_at=datetime('now') WHERE id=?", s.id);
      event(s.id, req.user, 'unpublished', 'published', 'approved', comment); snapshot(s.id, req.user.id, 'Unpublished');
    });
    audit(req.user, 'unpublished', 'submission', s.id, { comment }, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/content/submissions/:id/archive', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (s.status === 'archived') throw L.bad('Already archived.');
    const comment = L.str(req.body.comment, { max: 1000 });
    tx(() => {
      q.run("UPDATE submissions SET status='archived', updated_at=datetime('now') WHERE id=?", s.id);
      event(s.id, req.user, 'archived', s.status, 'archived', comment); snapshot(s.id, req.user.id, 'Archived');
    });
    audit(req.user, 'archived', 'submission', s.id, { from: s.status }, 'content', req.ip);
    res.json({ ok: true });
  });
  r.post('/api/content/submissions/:id/restore', A.requireAdmin, (req, res) => {
    const s = load(req.params.id);
    if (s.status !== 'archived') throw L.bad('Only archived items can be restored.');
    tx(() => {
      q.run("UPDATE submissions SET status='draft', approver_id=NULL, approved_at=NULL, published_by=NULL, published_at=NULL, review_status='none', supervisor_id=NULL, updated_at=datetime('now') WHERE id=?", s.id);
      event(s.id, req.user, 'restored', 'archived', 'draft', null);
    });
    audit(req.user, 'restored', 'submission', s.id, null, 'content', req.ip);
    res.json({ ok: true });
  });
};

module.exports.detail = detail;
module.exports.questionsOf = questionsOf;
