'use strict';
const crypto = require('crypto');
const cfg = require('../config');
const { q, tx, audit, getSetting } = require('../db');
const L = require('../lib');
const A = require('../auth');
const INT = require('../integrations');
const { detail } = require('./content');

const MAX_ATTEMPTS = 2;
// Scoring: correct on 1st try = 1 point, correct on 2nd try = 0.5, answer revealed after 2 misses = 0.
const POINTS = { 1: 1, 2: 0.5 };

const ORIGIN_LABEL = {
  official: 'Official past examination paper',
  practice: 'Original practice material — not an official past examination paper.',
  teacher: 'Teacher-prepared practice material — not an official past examination paper.',
  ai: 'AI-generated practice — not an official past examination paper.',
};
const SOURCE_LABEL = {
  official_scheme: 'Verified against the official marking scheme',
  supervisor_verified: 'Verified by a subject supervisor',
  admin_verified: 'Verified by an administrator',
  teacher_prepared: 'Teacher-prepared answer',
  ai_draft: 'AI-generated, unverified',
  none: 'No answer available',
};

const publishedPaper = (id) => q.get("SELECT * FROM submissions WHERE id=? AND status='published' AND section='paper'", id);

/** Question as a student may see it BEFORE answering: no correct flags, no explanations for objectives. */
function studentQuestion(x, { reveal = false } = {}) {
  const base = { id: x.id, number: x.number, type: x.type, text: x.text, marks: x.marks, topic: x.topic, page_ref: x.page_ref, position: x.position,
    diagrams: q.all("SELECT id FROM files WHERE question_id=? AND role='diagram'", x.id).map((f) => f.id), answer_source: x.answer_source, answer_label: SOURCE_LABEL[x.answer_source] };
  if (x.type === 'objective') {
    base.options = q.all('SELECT id,label,text FROM options WHERE question_id=? ORDER BY label', x.id);
    if (reveal) {
      const ops = q.all('SELECT id,label,text,is_correct,why FROM options WHERE question_id=? ORDER BY label', x.id);
      base.correct_option_id = (ops.find((o) => o.is_correct) || {}).id;
      base.explanation = x.explanation; base.option_notes = Object.fromEntries(ops.map((o) => [o.id, o.why]));
    }
  } else {
    // Theory: the model answer is shown directly under the question by default.
    Object.assign(base, { model_answer: x.model_answer, marking_guide: x.marking_guide, explanation: x.explanation, common_mistakes: x.common_mistakes });
  }
  return base;
}

function sessionOwned(req, id) {
  const s = q.get('SELECT * FROM quiz_sessions WHERE id=? AND user_id=?', L.int(id, { name: 'Session' }), req.user.id);
  if (!s) throw L.notFound('Quiz session not found.');
  return s;
}
function sessionState(s) {
  const items = q.all('SELECT question_id,position FROM quiz_items WHERE session_id=? ORDER BY position', s.id);
  const results = Object.fromEntries(q.all('SELECT * FROM question_results WHERE session_id=?', s.id).map((r) => [r.question_id, r]));
  const questions = items.map((it) => {
    const x = q.get('SELECT * FROM questions WHERE id=?', it.question_id);
    const res = results[x.id];
    const out = studentQuestion(x, { reveal: !!(res && res.resolved) });
    out.result = res ? { attempts_used: res.attempts_used, resolved: !!res.resolved, correct: !!res.correct, points: res.points } : { attempts_used: 0, resolved: false, correct: false, points: 0 };
    out.tried_option_ids = q.all('SELECT option_id FROM attempts WHERE session_id=? AND question_id=? ORDER BY attempt_no', s.id, x.id).map((a) => a.option_id);
    return out;
  });
  const answered = questions.filter((x) => x.result.resolved).length;
  const score = questions.reduce((a, x) => a + x.result.points, 0);
  return { session: { id: s.id, kind: s.kind, timed: !!s.timed, deadline: s.deadline, started_at: s.started_at, finished_at: s.finished_at, total: s.total, submission_id: s.submission_id, subject_id: s.subject_id, topic: s.topic },
    questions, progress: { answered, total: questions.length, score } };
}

function createSession(user, { kind, subject_id = null, submission_id = null, topic = null, daily_date = null, timed = 0, limitMin = null, questionIds }) {
  return tx(() => {
    const now = Date.now();
    const ins = q.run('INSERT INTO quiz_sessions(user_id,kind,subject_id,submission_id,topic,daily_date,timed,deadline,started_at,total) VALUES(?,?,?,?,?,?,?,?,?,?)',
      user.id, kind, subject_id, submission_id, topic, daily_date, timed ? 1 : 0, timed && limitMin ? now + limitMin * 60e3 : null, now, questionIds.length);
    const id = Number(ins.lastInsertRowid);
    questionIds.forEach((qid, i) => q.run('INSERT INTO quiz_items(session_id,question_id,position) VALUES(?,?,?)', id, qid, i + 1));
    return id;
  });
}

const OBJ_POOL = `FROM questions qu JOIN submissions s ON s.id=qu.submission_id
  WHERE s.status='published' AND s.section='paper' AND qu.type='objective' AND qu.answer_source NOT IN('none','ai_draft')
  AND (SELECT COUNT(*) FROM options o WHERE o.question_id=qu.id AND o.is_correct=1)=1`;

function todayStr() { return new Date().toISOString().slice(0, 10); }

function finalize(s) {
  if (s.finished_at) return;
  const score = q.get('SELECT COALESCE(SUM(points),0) sc FROM question_results WHERE session_id=?', s.id).sc;
  q.run('UPDATE quiz_sessions SET finished_at=?, score=? WHERE id=? AND finished_at IS NULL', Date.now(), score, s.id);
}

module.exports = (r) => {
  // ================= LIBRARY (students; published content only) =======================
  r.get('/api/library/exams', A.requireUser, (req, res) => {
    const exams = q.all('SELECT id,code,name,grade,description FROM exams WHERE active=1 ORDER BY sort');
    for (const e of exams) {
      e.subjects = q.all(`SELECT s.id,s.name,
        (SELECT COUNT(*) FROM submissions p WHERE p.subject_id=s.id AND p.status='published' AND p.section='paper') papers,
        (SELECT COUNT(*) FROM submissions p WHERE p.subject_id=s.id AND p.status='published' AND p.section='material') materials
        FROM subjects s WHERE s.exam_id=? AND s.active=1 ORDER BY s.sort,s.name`, e.id);
    }
    res.json({ exams });
  });

  r.get('/api/library/subjects/:id', A.requireUser, (req, res) => {
    const sb = q.get('SELECT s.id,s.name,e.code exam_code,e.name exam_name FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE s.id=? AND s.active=1 AND e.active=1', L.int(req.params.id, { name: 'Subject' }));
    if (!sb) throw L.notFound('Subject not found.');
    const papers = q.all(`SELECT s.id,s.title,s.year,s.origin,s.content_type,s.time_limit_min,pt.name paper_type,
        (SELECT COUNT(*) FROM questions WHERE submission_id=s.id AND type='objective') objective_count,
        (SELECT COUNT(*) FROM questions WHERE submission_id=s.id AND type='theory') theory_count
      FROM submissions s LEFT JOIN paper_types pt ON pt.id=s.paper_type_id
      WHERE s.subject_id=? AND s.status='published' AND s.section='paper' ORDER BY s.year DESC, pt.sort`, sb.id);
    for (const p of papers) p.origin_label = ORIGIN_LABEL[p.origin];
    // only years that actually have published content appear (archive 2026 → 2000)
    const years = [...new Set(papers.map((p) => p.year))].sort((a, b) => b - a)
      .map((y) => ({ year: y, papers: papers.filter((p) => p.year === y) }));
    const materials = q.all(`SELECT id,title,content_type,topic,year,origin FROM submissions WHERE subject_id=? AND status='published' AND section='material' ORDER BY content_type,title`, sb.id);
    const topics = q.all(`SELECT DISTINCT COALESCE(qu.topic, s.topic) topic ${OBJ_POOL} AND s.subject_id=? AND COALESCE(qu.topic,s.topic) IS NOT NULL ORDER BY 1`, sb.id).map((t) => t.topic);
    const pool = q.get(`SELECT COUNT(*) c ${OBJ_POOL} AND s.subject_id=?`, sb.id).c;
    res.json({ subject: sb, years, materials, topics, quiz_pool: pool });
  });

  r.get('/api/library/papers/:id', A.requireUser, (req, res) => {
    const s = publishedPaper(L.int(req.params.id, { name: 'Paper' }));
    if (!s) throw L.notFound('This paper is not available.');
    q.run('INSERT INTO access_log(user_id,submission_id) VALUES(?,?)', req.user.id, s.id);
    const d = detail(s);
    const questions = q.all('SELECT * FROM questions WHERE submission_id=? ORDER BY position,id', s.id).map((x) => studentQuestion(x));
    const files = q.all("SELECT id,orig_name,mime,pages FROM files WHERE submission_id=? AND student_visible=1 AND role IN('original','answer_key')", s.id);
    const notes = Object.fromEntries(q.all('SELECT question_id,text FROM theory_notes WHERE user_id=? AND question_id IN (SELECT id FROM questions WHERE submission_id=?)', req.user.id, s.id).map((n) => [n.question_id, n.text]));
    res.json({
      paper: { id: d.id, title: d.title, exam_code: d.exam_code, subject_id: d.subject_id, subject_name: d.subject_name, year: d.year, paper_type: d.paper_type, origin: d.origin,
        origin_label: ORIGIN_LABEL[d.origin], provenance: d.provenance, time_limit_min: d.time_limit_min,
        reviewer_name: d.reviewer_name, approver_name: d.approver_name, published_at: d.published_at },
      questions, files, notes,
    });
  });

  r.get('/api/library/materials/:id', A.requireUser, (req, res) => {
    const s = q.get("SELECT * FROM submissions WHERE id=? AND status='published' AND section='material'", L.int(req.params.id, { name: 'Material' }));
    if (!s) throw L.notFound('This material is not available.');
    q.run('INSERT INTO access_log(user_id,submission_id) VALUES(?,?)', req.user.id, s.id);
    const d = detail(s);
    res.json({ material: { id: d.id, title: d.title, content_type: d.content_type, topic: d.topic, year: d.year, subject_name: d.subject_name, exam_code: d.exam_code,
      body: d.body, origin: d.origin, origin_label: ORIGIN_LABEL[d.origin], provenance: d.provenance, reviewer_name: d.reviewer_name, approver_name: d.approver_name },
      files: q.all("SELECT id,orig_name,mime,size FROM files WHERE submission_id=? AND student_visible=1", s.id) });
  });

  r.put('/api/library/questions/:id/note', A.requireUser, (req, res) => {
    const x = q.get("SELECT qu.id FROM questions qu JOIN submissions s ON s.id=qu.submission_id WHERE qu.id=? AND s.status='published'", L.int(req.params.id, { name: 'Question' }));
    if (!x) throw L.notFound();
    const text = L.str(req.body.text, { max: 8000, name: 'Answer' });
    if (!text) q.run('DELETE FROM theory_notes WHERE user_id=? AND question_id=?', req.user.id, x.id);
    else q.run(`INSERT INTO theory_notes(user_id,question_id,text) VALUES(?,?,?) ON CONFLICT(user_id,question_id) DO UPDATE SET text=excluded.text, updated_at=datetime('now')`, req.user.id, x.id, text);
    res.json({ ok: true });
  });

  // ================= QUIZ ENGINE ======================================================
  r.post('/api/quiz/start', A.requireUser, (req, res) => {
    const b = req.body; const kind = b.kind;
    const timed = b.timed ? 1 : 0;
    let questionIds = []; let meta = { kind };
    if (kind === 'paper') {
      const p = publishedPaper(L.int(b.submission_id, { name: 'Paper' }));
      if (!p) throw L.notFound('This paper is not available.');
      const open = q.get('SELECT * FROM quiz_sessions WHERE user_id=? AND submission_id=? AND kind=? AND finished_at IS NULL ORDER BY id DESC', req.user.id, p.id, 'paper');
      if (open && !b.fresh && !(open.deadline && open.deadline < Date.now())) return res.json({ resumed: true, ...sessionState(open) });
      questionIds = q.all(`SELECT qu.id FROM questions qu WHERE qu.submission_id=? AND qu.type='objective' AND qu.answer_source NOT IN('none','ai_draft')
        AND (SELECT COUNT(*) FROM options o WHERE o.question_id=qu.id AND o.is_correct=1)=1 ORDER BY qu.position`, p.id).map((x) => x.id);
      if (b.shuffle) questionIds.sort(() => Math.random() - 0.5);
      meta = { kind, submission_id: p.id, subject_id: p.subject_id, limitMin: p.time_limit_min || Math.max(5, Math.ceil(questionIds.length * 1.2)) };
    } else if (kind === 'topic' || kind === 'random') {
      const sub = L.int(b.subject_id, { name: 'Subject' });
      const topic = kind === 'topic' ? L.str(b.topic, { min: 1, max: 120, name: 'Topic', required: true }) : null;
      const n = L.int(b.count ?? 10, { min: 3, max: 50, name: 'Number of questions' });
      questionIds = q.all(`SELECT qu.id ${OBJ_POOL} AND s.subject_id=? ${topic ? 'AND COALESCE(qu.topic,s.topic)=?' : ''} ORDER BY RANDOM() LIMIT ?`, ...(topic ? [sub, topic, n] : [sub, n])).map((x) => x.id);
      meta = { kind, subject_id: sub, topic, limitMin: Math.max(3, Math.ceil(n * 1.2)) };
    } else if (kind === 'daily') {
      const day = todayStr();
      const done = q.get("SELECT * FROM quiz_sessions WHERE user_id=? AND kind='daily' AND daily_date=?", req.user.id, day);
      if (done) return res.json({ resumed: true, ...sessionState(done) });
      // same five questions for everyone on a given day (seeded by date)
      const pool = q.all(`SELECT qu.id ${OBJ_POOL}`).map((x) => x.id);
      const seed = (id) => crypto.createHash('sha1').update(day + ':' + id).digest('hex');
      questionIds = pool.sort((a, c) => (seed(a) < seed(c) ? -1 : 1)).slice(0, 5);
      meta = { kind, daily_date: day, limitMin: 10 };
    } else throw L.bad('Choose a quiz type.');
    if (!questionIds.length) throw L.bad('There are no verified objective questions available for this selection yet.');
    const id = createSession(req.user, { ...meta, timed, questionIds });
    res.json(201, { resumed: false, ...sessionState(q.get('SELECT * FROM quiz_sessions WHERE id=?', id)) });
  });

  r.get('/api/quiz/:id', A.requireUser, (req, res) => {
    const s = sessionOwned(req, req.params.id);
    if (!s.finished_at && s.deadline && s.deadline < Date.now()) finalize(s);
    res.json(sessionState(q.get('SELECT * FROM quiz_sessions WHERE id=?', s.id)));
  });

  r.post('/api/quiz/:id/answer', A.requireUser, (req, res) => {
    const sess = sessionOwned(req, req.params.id);
    const qid = L.int(req.body.question_id, { name: 'Question' });
    const oid = L.int(req.body.option_id, { name: 'Option' });
    const uid = req.body.client_uid ? L.str(req.body.client_uid, { max: 64 }) : null;
    // Deadline is checked (and the quiz auto-submitted) OUTSIDE the answer transaction: throwing inside it would roll the submission back.
    if (!sess.finished_at && sess.deadline && sess.deadline < Date.now()) {
      tx(() => finalize(q.get('SELECT * FROM quiz_sessions WHERE id=?', sess.id)));
      throw L.bad('Time is up. Your quiz has been submitted.');
    }
    const out = tx(() => {
      const s = q.get('SELECT * FROM quiz_sessions WHERE id=?', sess.id);
      if (s.finished_at) throw L.bad('This quiz is already finished.');
      if (!q.get('SELECT 1 FROM quiz_items WHERE session_id=? AND question_id=?', s.id, qid)) throw L.bad('That question is not part of this quiz.');
      const qu = q.get('SELECT * FROM questions WHERE id=?', qid);
      const opt = q.get('SELECT * FROM options WHERE id=? AND question_id=?', oid, qid);
      if (!opt) throw L.bad('That option does not belong to this question.');
      let rs = q.get('SELECT * FROM question_results WHERE session_id=? AND question_id=?', s.id, qid);
      if (!rs) { q.run('INSERT INTO question_results(session_id,question_id,user_id) VALUES(?,?,?)', s.id, qid, req.user.id); rs = q.get('SELECT * FROM question_results WHERE session_id=? AND question_id=?', s.id, qid); }
      const ops = q.all('SELECT id,label,text,is_correct,why FROM options WHERE question_id=? ORDER BY label', qid);
      const correctOpt = ops.find((o) => o.is_correct);
      const finish = (extra) => ({ ...extra, attempts_used: rs.attempts_used, attempts_left: Math.max(0, MAX_ATTEMPTS - rs.attempts_used), resolved: !!rs.resolved, points: rs.points });
      const reveal = () => ({ correct_option_id: correctOpt.id, correct_label: correctOpt.label, explanation: qu.explanation, option_notes: Object.fromEntries(ops.map((o) => [o.id, o.why])) });
      // idempotent: a retried request (double-tap, flaky network) never double counts
      if (uid && q.get('SELECT 1 FROM attempts WHERE user_id=? AND client_uid=?', req.user.id, uid)) {
        return finish({ duplicate: true, correct: !!rs.correct, ...(rs.resolved ? reveal() : {}) });
      }
      if (rs.resolved) return finish({ duplicate: true, correct: !!rs.correct, ...reveal() });
      if (!correctOpt) throw L.bad('This question has no verified answer.');
      if (q.get('SELECT 1 FROM attempts WHERE session_id=? AND question_id=? AND option_id=?', s.id, qid, oid)) throw L.bad('You already tried that option. Pick a different one.');
      const attemptNo = rs.attempts_used + 1;
      const isCorrect = opt.is_correct === 1;
      q.run('INSERT INTO attempts(session_id,question_id,user_id,attempt_no,option_id,correct,client_uid) VALUES(?,?,?,?,?,?,?)', s.id, qid, req.user.id, attemptNo, oid, isCorrect ? 1 : 0, uid);
      if (isCorrect) {
        q.run("UPDATE question_results SET attempts_used=?, resolved=1, correct=1, points=?, updated_at=datetime('now') WHERE session_id=? AND question_id=?", attemptNo, POINTS[attemptNo], s.id, qid);
        rs = q.get('SELECT * FROM question_results WHERE session_id=? AND question_id=?', s.id, qid);
        return finish({ correct: true, ...reveal() });
      }
      const exhausted = attemptNo >= MAX_ATTEMPTS;
      q.run("UPDATE question_results SET attempts_used=?, resolved=?, correct=0, points=0, updated_at=datetime('now') WHERE session_id=? AND question_id=?", attemptNo, exhausted ? 1 : 0, s.id, qid);
      rs = q.get('SELECT * FROM question_results WHERE session_id=? AND question_id=?', s.id, qid);
      const why = opt.why || 'That is not the right answer.';
      return finish({ correct: false, selected_feedback: why, ...(exhausted ? reveal() : {}) });
    });
    const prog = q.get('SELECT COUNT(*) n, COALESCE(SUM(points),0) sc FROM question_results WHERE session_id=? AND resolved=1', sess.id);
    res.json({ ...out, progress: { answered: prog.n, total: sess.total, score: prog.sc } });
  });

  r.post('/api/quiz/:id/finish', A.requireUser, (req, res) => {
    const s = sessionOwned(req, req.params.id);
    tx(() => finalize(q.get('SELECT * FROM quiz_sessions WHERE id=?', s.id)));
    res.json(summary(q.get('SELECT * FROM quiz_sessions WHERE id=?', s.id)));
  });
  r.get('/api/quiz/:id/summary', A.requireUser, (req, res) => {
    const s = sessionOwned(req, req.params.id);
    res.json(summary(s));
  });

  function summary(s) {
    const st = sessionState(s);
    const resolved = st.questions.filter((x) => x.result.resolved);
    const firstTry = resolved.filter((x) => x.result.correct && x.result.attempts_used === 1).length;
    const secondTry = resolved.filter((x) => x.result.correct && x.result.attempts_used === 2).length;
    const missed = resolved.filter((x) => !x.result.correct).length;
    const unanswered = st.questions.length - resolved.length;
    return { session: st.session, score: st.progress.score, total: st.questions.length, first_try: firstTry, second_try: secondTry, missed, unanswered,
      percent: st.questions.length ? Math.round((st.progress.score / st.questions.length) * 100) : 0,
      questions: st.questions.map((x) => ({ id: x.id, number: x.number, text: x.text, topic: x.topic, options: x.options, result: x.result, tried_option_ids: x.tried_option_ids,
        correct_option_id: x.correct_option_id, explanation: x.explanation, option_notes: x.option_notes })),
      scoring: 'Correct first try = 1 point, correct second try = 0.5, answer revealed after two misses = 0.' };
  }

  r.post('/api/quiz/:id/retry', A.requireUser, (req, res) => {
    const s = sessionOwned(req, req.params.id);
    let ids = q.all('SELECT question_id FROM quiz_items WHERE session_id=? ORDER BY position', s.id).map((x) => x.question_id);
    if (req.body.only_missed) ids = ids.filter((id) => { const rr = q.get('SELECT correct,attempts_used FROM question_results WHERE session_id=? AND question_id=?', s.id, id); return !rr || !rr.correct || rr.attempts_used > 1; });
    if (!ids.length) throw L.bad('Nothing to retry — you got everything right first time!');
    // retries are only allowed for questions that are still published
    ids = ids.filter((id) => q.get(`SELECT 1 FROM questions qu JOIN submissions p ON p.id=qu.submission_id WHERE qu.id=? AND p.status='published'`, id));
    if (!ids.length) throw L.bad('These questions are no longer available.');
    const kind = s.kind === 'daily' ? 'random' : s.kind;
    const id = createSession(req.user, { kind, subject_id: s.subject_id, submission_id: s.submission_id, topic: s.topic, timed: s.timed, limitMin: s.timed ? Math.max(3, Math.ceil(ids.length * 1.2)) : null, questionIds: ids });
    res.json(201, sessionState(q.get('SELECT * FROM quiz_sessions WHERE id=?', id)));
  });

  // ================= PROGRESS ===========================================================
  r.get('/api/progress', A.requireUser, (req, res) => {
    const uid = req.user.id;
    const tot = q.get(`SELECT COUNT(*) answered, COALESCE(SUM(CASE WHEN correct=1 AND attempts_used=1 THEN 1 ELSE 0 END),0) first_try,
      COALESCE(SUM(correct),0) correct, COALESCE(SUM(points),0) points FROM question_results WHERE user_id=? AND resolved=1`, uid);
    const sessions = q.get('SELECT COUNT(*) c FROM quiz_sessions WHERE user_id=?', uid).c;
    const bySubject = q.all(`SELECT sb.id subject_id, sb.name subject, e.code exam, COUNT(*) answered,
        SUM(CASE WHEN qr.correct=1 AND qr.attempts_used=1 THEN 1 ELSE 0 END) first_try, SUM(qr.correct) correct, SUM(qr.points) points
      FROM question_results qr JOIN questions qu ON qu.id=qr.question_id JOIN submissions s ON s.id=qu.submission_id
      JOIN subjects sb ON sb.id=s.subject_id JOIN exams e ON e.id=sb.exam_id
      WHERE qr.user_id=? AND qr.resolved=1 GROUP BY sb.id ORDER BY answered DESC`, uid);
    for (const s of bySubject) { s.accuracy = Math.round((s.points / s.answered) * 100); }
    const topics = q.all(`SELECT COALESCE(qu.topic, s.topic) topic, sb.name subject, sb.id subject_id, COUNT(*) answered, SUM(qr.points) points
      FROM question_results qr JOIN questions qu ON qu.id=qr.question_id JOIN submissions s ON s.id=qu.submission_id JOIN subjects sb ON sb.id=s.subject_id
      WHERE qr.user_id=? AND qr.resolved=1 AND COALESCE(qu.topic,s.topic) IS NOT NULL GROUP BY 1,sb.id HAVING answered>=3`, uid)
      .map((t) => ({ ...t, accuracy: Math.round((t.points / t.answered) * 100) })).sort((a, b) => a.accuracy - b.accuracy);
    const recent = q.all(`SELECT qs.id,qs.kind,qs.started_at,qs.finished_at,qs.total,qs.score,qs.topic, sb.name subject, s.title paper_title, s.year,
        (SELECT COUNT(*) FROM attempts a WHERE a.session_id=qs.id) attempts
      FROM quiz_sessions qs LEFT JOIN subjects sb ON sb.id=qs.subject_id LEFT JOIN submissions s ON s.id=qs.submission_id
      WHERE qs.user_id=? ORDER BY qs.started_at DESC LIMIT 20`, uid);
    const recentPapers = q.all(`SELECT DISTINCT s.id, s.title, s.year, s.section, MAX(a.accessed_at) last
      FROM access_log a JOIN submissions s ON s.id=a.submission_id WHERE a.user_id=? AND s.status='published' GROUP BY s.id ORDER BY last DESC LIMIT 8`, uid);
    const days = new Set(q.all('SELECT DISTINCT date(started_at/1000,\'unixepoch\') d FROM quiz_sessions WHERE user_id=? ORDER BY d DESC LIMIT 400', uid).map((x) => x.d));
    let streak = 0; const d = new Date();
    if (!days.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
    while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
    const marks = [10, 50, 100, 250, 500, 1000];
    const road = marks.map((m) => ({ target: m, reached: tot.answered >= m }));
    const next = marks.find((m) => tot.answered < m) || null;
    const daily = q.get("SELECT id,finished_at,score,total FROM quiz_sessions WHERE user_id=? AND kind='daily' AND daily_date=?", uid, todayStr());
    const weak = topics[0] || bySubject.slice().sort((a, b) => a.accuracy - b.accuracy)[0] || null;
    const mistakes = q.get('SELECT COUNT(*) c FROM question_results qr WHERE user_id=? AND resolved=1 AND (correct=0 OR attempts_used>1)', uid).c;
    res.json({
      totals: { answered: tot.answered, accuracy: tot.answered ? Math.round((tot.points / tot.answered) * 100) : 0, first_try_rate: tot.answered ? Math.round((tot.first_try / tot.answered) * 100) : 0, sessions },
      by_subject: bySubject, weak_topics: topics.slice(0, 5), strong_topics: topics.slice(-5).reverse().filter((t) => t.accuracy >= 70),
      recent_sessions: recent, recent_papers: recentPapers, streak_days: streak, road: { markers: road, next, answered: tot.answered },
      daily: { date: todayStr(), session: daily || null }, mistakes_to_review: mistakes,
      recommendation: weak ? (weak.topic ? { text: `Revise "${weak.topic}" in ${weak.subject} (${weak.accuracy}% so far).`, subject_id: weak.subject_id, topic: weak.topic } : { text: `Practise more ${weak.subject} (${weak.accuracy}% so far).`, subject_id: weak.subject_id }) : { text: 'Start with any paper to build your progress.' },
    });
  });

  r.get('/api/progress/mistakes', A.requireUser, (req, res) => {
    const where = ['qr.user_id=?', 'qr.resolved=1', '(qr.correct=0 OR qr.attempts_used>1)', "s.status='published'"]; const p = [req.user.id];
    if (req.query.subject_id) { where.push('s.subject_id=?'); p.push(Number(req.query.subject_id)); }
    const rows = q.all(`SELECT qu.id question_id, qu.number, qu.text, qu.explanation, qu.topic, s.id paper_id, s.title paper_title, s.year, sb.name subject, MAX(qr.updated_at) last, MIN(qr.correct) ever_missed
      FROM question_results qr JOIN questions qu ON qu.id=qr.question_id JOIN submissions s ON s.id=qu.submission_id JOIN subjects sb ON sb.id=s.subject_id
      WHERE ${where.join(' AND ')} GROUP BY qu.id ORDER BY last DESC LIMIT 100`, ...p);
    for (const x of rows) {
      const ops = q.all('SELECT id,label,text,is_correct,why FROM options WHERE question_id=? ORDER BY label', x.question_id);
      x.options = ops.map((o) => ({ id: o.id, label: o.label, text: o.text, is_correct: !!o.is_correct, why: o.why }));
      x.your_picks = q.all('SELECT option_id FROM attempts WHERE user_id=? AND question_id=? AND correct=0', req.user.id, x.question_id).map((a) => a.option_id);
    }
    res.json({ items: rows });
  });

  // ================= REPORTS, CONTACT, DONATIONS =================================================
  const contactLimit = L.rateLimit('contact', 5, 60 * 60e3);
  r.post('/api/contact', contactLimit, (req, res) => {
    const subject = L.str(req.body.subject, { min: 3, max: 150, name: 'Subject', required: true });
    const message = L.str(req.body.message, { min: 10, max: 4000, name: 'Message', required: true });
    const contact = L.str(req.body.contact, { min: 3, max: 150, name: 'Your email or phone', required: true });
    q.run("INSERT INTO inbox(type,user_id,name,contact,subject,message) VALUES('contact',?,?,?,?,?)", req.user ? req.user.id : null, L.str(req.body.name, { max: 100 }) || (req.user && req.user.full_name) || null, contact, subject, message);
    res.json(201, { ok: true });
  });
  r.post('/api/report', A.requireUser, L.rateLimit('report', 20, 60 * 60e3, (req) => String(req.user && req.user.id)), (req, res) => {
    const type = ['error_report', 'content_report', 'feedback'].includes(req.body.type) ? req.body.type : null;
    if (!type) throw L.bad('Choose what you are reporting.');
    const message = L.str(req.body.message, { min: 5, max: 3000, name: 'Message', required: true });
    let sid = null; let qid = null;
    if (req.body.question_id) { const x = q.get('SELECT id,submission_id FROM questions WHERE id=?', L.int(req.body.question_id, { name: 'Question' })); if (x) { qid = x.id; sid = x.submission_id; } }
    if (!sid && req.body.submission_id) { const s = q.get("SELECT id FROM submissions WHERE id=? AND status='published'", L.int(req.body.submission_id, { name: 'Content' })); if (s) sid = s.id; }
    q.run('INSERT INTO inbox(type,user_id,name,contact,subject,message,submission_id,question_id) VALUES(?,?,?,?,?,?,?,?)', type, req.user.id, req.user.full_name, req.user.email || req.user.phone,
      L.str(req.body.subject, { max: 150 }) || type.replace('_', ' '), message, sid, qid);
    res.json(201, { ok: true });
  });

  r.get('/api/donate/options', (req, res) => {
    const st = INT.status();
    res.json({ currency: 'GMD', symbol: 'D', amounts: cfg.DONATION_AMOUNTS, providers: [
      { id: 'wave', name: 'Wave', available: st.wave.configured }, { id: 'aps', name: 'APS', available: st.aps.configured } ],
      note: st.wave.configured || st.aps.configured ? null : 'Online donations are not switched on yet: no payment provider has been configured. Thank you for your interest!' });
  });
  r.post('/api/donate/initiate', L.rateLimit('donate', 10, 60 * 60e3), (req, res) => {
    const provider = req.body.provider; const st = INT.status();
    if (!['wave', 'aps'].includes(provider)) throw L.bad('Choose Wave or APS.');
    const amount = L.int(req.body.amount, { min: 1, max: 1000000, name: 'Amount' });
    if (!st[provider].configured) throw new L.HttpError(503, `${provider.toUpperCase()} is not configured on this server yet (needs ${st[provider].needs}). No payment was started.`);
    // Credentials exist, but the provider-specific checkout call is not implemented here: we never invent one.
    throw new L.HttpError(501, `${provider.toUpperCase()} credentials are present, but the checkout adapter has not been implemented. See docs/SETUP.md ("Donations"). No payment was started.`);
  });
  // Signed webhook: only a valid HMAC-SHA256 signature from the provider can mark a donation as confirmed.
  r.post('/api/donate/webhook/:provider', (req, res) => {
    const provider = req.params.provider; if (!['wave', 'aps'].includes(provider)) throw L.notFound();
    const secret = process.env[provider.toUpperCase() + '_WEBHOOK_SECRET'];
    if (!secret) throw new L.HttpError(503, 'Webhook secret not configured.');
    const sig = String(req.headers['x-signature'] || '');
    const calc = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    let ok = false; try { ok = sig.length === calc.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc)); } catch {}
    if (!ok) throw L.forbidden('Invalid signature.');
    const ref = L.str(req.body.reference, { min: 3, max: 100, required: true, name: 'Reference' });
    const d = q.get('SELECT * FROM donations WHERE provider=? AND provider_ref=?', provider, ref);
    if (!d) throw L.notFound();
    if (req.body.status === 'confirmed' && d.status !== 'confirmed') q.run("UPDATE donations SET status='confirmed', confirmed_at=datetime('now') WHERE id=?", d.id);
    res.json({ ok: true });
  });

  // ================= AI TUTOR ================================================================
  r.get('/api/tutor/status', A.requireUser, (req, res) => {
    const c = INT.status().ai.configured;
    res.json({ configured: c, message: c ? null : 'The AI tutor is not connected yet. An administrator needs to configure an AI provider (see docs/SETUP.md). Until then you can still use the model answers and explanations in each paper.' });
  });
  r.post('/api/tutor', A.requireUser, L.rateLimit('tutor', 20, 10 * 60e3, (req) => String(req.user && req.user.id)), async (req, res) => {
    if (!INT.status().ai.configured) throw new L.HttpError(503, 'The AI tutor is not connected yet. No answer was generated.');
    const message = L.str(req.body.message, { min: 2, max: 1500, name: 'Message', required: true });
    const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 1500) }));
    // ground the tutor in published material the student can see anyway
    const words = [...new Set(message.toLowerCase().match(/[a-z]{4,}/g) || [])].slice(0, 6);
    let sources = [];
    if (words.length) {
      const like = words.map(() => 'qu.text LIKE ?').join(' OR ');
      sources = q.all(`SELECT qu.id,qu.text,qu.type,qu.model_answer,qu.explanation,qu.answer_source,s.id paper_id,s.title,s.year FROM questions qu JOIN submissions s ON s.id=qu.submission_id
        WHERE s.status='published' AND qu.answer_source IN('official_scheme','supervisor_verified','admin_verified') AND (${like}) LIMIT 3`, ...words.map((w) => `%${w}%`));
    }
    const ctx = sources.map((s, i) => `[${i + 1}] ${s.title} (${s.year || 'n/a'}) Q: ${s.text.slice(0, 400)} Verified note: ${(s.model_answer || s.explanation || '').slice(0, 500)}`).join('\n');
    const out = await INT.chat([
      { role: 'system', content: 'You are a patient tutor for Gambian secondary-school students preparing for GABECE and WASSCE. Explain step by step in simple English. If you are unsure, say so. Do not claim your explanation is an official marking scheme.' + (ctx ? `\nVerified reference material:\n${ctx}` : '') },
      ...history, { role: 'user', content: message }]);
    if (!out.ok) throw new L.HttpError(502, 'The AI provider could not answer right now. Please try again later.');
    res.json({ answer: out.text, label: 'AI-generated explanation — not an official answer', sources: sources.map((s) => ({ paper_id: s.paper_id, title: s.title, year: s.year, label: SOURCE_LABEL[s.answer_source] })) });
  });
};
