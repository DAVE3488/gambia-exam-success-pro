'use strict';
/*
 * Database layer (SQLite via Node's built-in node:sqlite — no npm packages needed).
 *
 * Integrity that must hold even if application code has a bug is enforced HERE with
 * constraints and triggers:
 *   - role caps (5 main admins incl. chief, 200 supervisors, 5,000 teachers, 4 subjects per supervisor)
 *   - the Chief Administrator cannot be demoted, blocked, re-emailed or deleted; only one chief exists
 *   - a submission can only become 'published' from 'approved', and 'approved' needs an approver
 *   - questions of a published submission cannot be modified (no silent edits to live content)
 *   - audit_log rows cannot be updated or deleted
 */
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA, { recursive: true });
fs.mkdirSync(cfg.PRIVATE_DIR, { recursive: true });
fs.mkdirSync(cfg.AVATAR_DIR, { recursive: true });

const db = new DatabaseSync(cfg.DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

const MAIN = "('main_admin','chief')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  school TEXT,
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN('student','teacher','supervisor','admin','main_admin','chief')),
  is_chief INTEGER NOT NULL DEFAULT 0,
  can_publish INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','blocked')),
  blocked_reason TEXT, blocked_at TEXT, blocked_by INTEGER,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(email IS NOT NULL OR phone IS NOT NULL),
  CHECK((role='chief') = (is_chief=1))
);

CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ip TEXT, ua TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS reset_tokens(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS prefs(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scroll_mode INTEGER NOT NULL DEFAULT 1,
  page_mode INTEGER NOT NULL DEFAULT 0,
  font_scale REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS exams(
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grade TEXT,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subjects(
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(exam_id, name)
);
CREATE TABLE IF NOT EXISTS paper_types(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS applications(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('teacher','supervisor','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','info_requested')),
  subject_ids TEXT NOT NULL DEFAULT '[]',
  qualifications TEXT, experience TEXT, message TEXT, institution TEXT,
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status, kind);

CREATE TABLE IF NOT EXISTS supervisor_subjects(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, subject_id)
);

CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  year INTEGER,
  paper_type_id INTEGER REFERENCES paper_types(id),
  content_type TEXT NOT NULL,
  section TEXT NOT NULL CHECK(section IN('paper','material')),
  origin TEXT NOT NULL DEFAULT 'official' CHECK(origin IN('official','practice','teacher','ai')),
  topic TEXT,
  body TEXT,
  provenance TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','in_review','approved','published','rejected','archived')),
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  supervisor_id INTEGER REFERENCES users(id),
  assigned_at TEXT, assigned_by INTEGER REFERENCES users(id),
  review_status TEXT NOT NULL DEFAULT 'none' CHECK(review_status IN('none','pending','recommend_approval','corrections_requested','recommend_rejection')),
  reviewer_id INTEGER REFERENCES users(id), reviewed_at TEXT, review_comment TEXT,
  approver_id INTEGER REFERENCES users(id), approved_at TEXT,
  published_by INTEGER REFERENCES users(id), published_at TEXT,
  rejection_reason TEXT, correction_note TEXT,
  time_limit_min INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sub_lookup ON submissions(status, exam_id, subject_id, year);
CREATE INDEX IF NOT EXISTS idx_sub_sup ON submissions(supervisor_id);

CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  question_id INTEGER,
  role TEXT NOT NULL DEFAULT 'original' CHECK(role IN('original','answer_key','diagram','material')),
  orig_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  pages INTEGER,
  student_visible INTEGER NOT NULL DEFAULT 0,
  uploader_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions(
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  number TEXT,
  type TEXT NOT NULL DEFAULT 'objective' CHECK(type IN('objective','theory')),
  text TEXT NOT NULL,
  marks INTEGER,
  topic TEXT,
  page_ref INTEGER,
  model_answer TEXT, marking_guide TEXT, explanation TEXT, common_mistakes TEXT,
  answer_source TEXT NOT NULL DEFAULT 'none' CHECK(answer_source IN('none','ai_draft','teacher_prepared','supervisor_verified','admin_verified','official_scheme')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_q_sub ON questions(submission_id, position);

CREATE TABLE IF NOT EXISTS options(
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  why TEXT,
  UNIQUE(question_id, label)
);

CREATE TABLE IF NOT EXISTS review_events(
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  from_status TEXT, to_status TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(submission_id, version)
);

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT, target_id INTEGER,
  detail TEXT,
  scope TEXT NOT NULL DEFAULT 'content' CHECK(scope IN('content','user','security')),
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS quiz_sessions(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('paper','topic','random','daily')),
  subject_id INTEGER REFERENCES subjects(id),
  submission_id INTEGER REFERENCES submissions(id),
  topic TEXT,
  daily_date TEXT,
  timed INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  score REAL
);
CREATE INDEX IF NOT EXISTS idx_qs_user ON quiz_sessions(user_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qs_daily ON quiz_sessions(user_id, daily_date) WHERE kind='daily';

CREATE TABLE IF NOT EXISTS quiz_items(
  session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  position INTEGER NOT NULL,
  PRIMARY KEY(session_id, question_id)
);
-- exactly ONE row per (session, question): this is what prevents duplicate scoring.
CREATE TABLE IF NOT EXISTS question_results(
  session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 2),
  resolved INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  points REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(session_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_qr_user ON question_results(user_id);
CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK(attempt_no IN(1,2)),
  option_id INTEGER NOT NULL REFERENCES options(id),
  correct INTEGER NOT NULL,
  client_uid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, question_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_uid ON attempts(user_id, client_uid) WHERE client_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS access_log(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_user ON access_log(user_id, accessed_at);

CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

CREATE TABLE IF NOT EXISTS inbox(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN('contact','error_report','content_report','feedback','message_report')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT, contact TEXT, subject TEXT, message TEXT NOT NULL,
  submission_id INTEGER, question_id INTEGER, ref_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN('new','in_progress','resolved','dismissed')),
  handled_by INTEGER REFERENCES users(id), handled_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donations(
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  amount_gmd INTEGER NOT NULL CHECK(amount_gmd > 0),
  status TEXT NOT NULL DEFAULT 'initiated' CHECK(status IN('initiated','confirmed','failed','cancelled')),
  provider_ref TEXT UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS theory_notes(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, question_id)
);

CREATE TABLE IF NOT EXISTS classes(
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'class' CHECK(kind IN('class','group')),
  subject_id INTEGER REFERENCES subjects(id),
  join_code TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS class_members(
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(class_id, user_id)
);
CREATE TABLE IF NOT EXISTS assignments(
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('written','quiz')),
  title TEXT NOT NULL, instructions TEXT,
  due_at TEXT,
  paper_id INTEGER REFERENCES submissions(id),
  quiz TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assignment_submissions(
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer TEXT, auto_score REAL, auto_total INTEGER,
  grade TEXT, feedback TEXT, graded_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(assignment_id, user_id)
);
CREATE TABLE IF NOT EXISTS class_messages(
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cm ON class_messages(class_id, id);
`;

const TRIGGERS = `
-- role caps ---------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_cap_main_ins BEFORE INSERT ON users
WHEN NEW.role IN ${MAIN} AND (SELECT COUNT(*) FROM users WHERE role IN ${MAIN}) >= ${cfg.LIMITS.MAIN_ADMINS}
BEGIN SELECT RAISE(ABORT,'limit:main_admins'); END;
CREATE TRIGGER IF NOT EXISTS trg_cap_main_upd BEFORE UPDATE OF role ON users
WHEN NEW.role IN ${MAIN} AND OLD.role NOT IN ${MAIN} AND (SELECT COUNT(*) FROM users WHERE role IN ${MAIN}) >= ${cfg.LIMITS.MAIN_ADMINS}
BEGIN SELECT RAISE(ABORT,'limit:main_admins'); END;

CREATE TRIGGER IF NOT EXISTS trg_cap_sup_ins BEFORE INSERT ON users
WHEN NEW.role='supervisor' AND (SELECT COUNT(*) FROM users WHERE role='supervisor') >= ${cfg.LIMITS.SUPERVISORS}
BEGIN SELECT RAISE(ABORT,'limit:supervisors'); END;
CREATE TRIGGER IF NOT EXISTS trg_cap_sup_upd BEFORE UPDATE OF role ON users
WHEN NEW.role='supervisor' AND OLD.role!='supervisor' AND (SELECT COUNT(*) FROM users WHERE role='supervisor') >= ${cfg.LIMITS.SUPERVISORS}
BEGIN SELECT RAISE(ABORT,'limit:supervisors'); END;

CREATE TRIGGER IF NOT EXISTS trg_cap_teach_ins BEFORE INSERT ON users
WHEN NEW.role='teacher' AND (SELECT COUNT(*) FROM users WHERE role='teacher') >= ${cfg.LIMITS.TEACHERS}
BEGIN SELECT RAISE(ABORT,'limit:teachers'); END;
CREATE TRIGGER IF NOT EXISTS trg_cap_teach_upd BEFORE UPDATE OF role ON users
WHEN NEW.role='teacher' AND OLD.role!='teacher' AND (SELECT COUNT(*) FROM users WHERE role='teacher') >= ${cfg.LIMITS.TEACHERS}
BEGIN SELECT RAISE(ABORT,'limit:teachers'); END;

CREATE TRIGGER IF NOT EXISTS trg_cap_supsub BEFORE INSERT ON supervisor_subjects
WHEN (SELECT COUNT(*) FROM supervisor_subjects WHERE user_id=NEW.user_id) >= ${cfg.LIMITS.SUPERVISOR_SUBJECTS}
BEGIN SELECT RAISE(ABORT,'limit:supervisor_subjects'); END;

-- chief administrator protection ---------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_one_chief_ins BEFORE INSERT ON users
WHEN NEW.is_chief=1 AND EXISTS(SELECT 1 FROM users WHERE is_chief=1)
BEGIN SELECT RAISE(ABORT,'chief_exists'); END;
CREATE TRIGGER IF NOT EXISTS trg_chief_no_promote BEFORE UPDATE OF is_chief, role ON users
WHEN OLD.is_chief=0 AND (NEW.is_chief=1 OR NEW.role='chief')
BEGIN SELECT RAISE(ABORT,'chief_not_assignable'); END;
CREATE TRIGGER IF NOT EXISTS trg_chief_protect BEFORE UPDATE ON users
WHEN OLD.is_chief=1 AND (NEW.role!='chief' OR NEW.is_chief!=1 OR NEW.status!='active' OR NEW.email IS NOT OLD.email)
BEGIN SELECT RAISE(ABORT,'chief_protected'); END;
CREATE TRIGGER IF NOT EXISTS trg_chief_no_delete BEFORE DELETE ON users
WHEN OLD.is_chief=1
BEGIN SELECT RAISE(ABORT,'chief_protected'); END;

-- workflow integrity --------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_sub_publish_gate BEFORE UPDATE OF status ON submissions
WHEN NEW.status='published' AND OLD.status!='approved'
BEGIN SELECT RAISE(ABORT,'workflow:publish_requires_approved'); END;
CREATE TRIGGER IF NOT EXISTS trg_sub_approve_gate BEFORE UPDATE OF status ON submissions
WHEN NEW.status IN('approved','published') AND NEW.approver_id IS NULL
BEGIN SELECT RAISE(ABORT,'workflow:approver_required'); END;
CREATE TRIGGER IF NOT EXISTS trg_sub_publish_by BEFORE UPDATE OF status ON submissions
WHEN NEW.status='published' AND NEW.published_by IS NULL
BEGIN SELECT RAISE(ABORT,'workflow:publisher_required'); END;
CREATE TRIGGER IF NOT EXISTS trg_sub_no_direct_insert BEFORE INSERT ON submissions
WHEN NEW.status NOT IN('draft')
BEGIN SELECT RAISE(ABORT,'workflow:must_start_as_draft'); END;

CREATE TRIGGER IF NOT EXISTS trg_q_frozen_ins BEFORE INSERT ON questions
WHEN (SELECT status FROM submissions WHERE id=NEW.submission_id) IN('published','approved','archived')
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;
CREATE TRIGGER IF NOT EXISTS trg_q_frozen_upd BEFORE UPDATE ON questions
WHEN (SELECT status FROM submissions WHERE id=OLD.submission_id) IN('published','approved','archived')
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;
CREATE TRIGGER IF NOT EXISTS trg_q_frozen_del BEFORE DELETE ON questions
WHEN EXISTS(SELECT 1 FROM submissions WHERE id=OLD.submission_id AND status IN('published','approved','archived'))
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;
CREATE TRIGGER IF NOT EXISTS trg_o_frozen_ins BEFORE INSERT ON options
WHEN (SELECT s.status FROM questions q JOIN submissions s ON s.id=q.submission_id WHERE q.id=NEW.question_id) IN('published','approved','archived')
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;
CREATE TRIGGER IF NOT EXISTS trg_o_frozen_upd BEFORE UPDATE ON options
WHEN (SELECT s.status FROM questions q JOIN submissions s ON s.id=q.submission_id WHERE q.id=OLD.question_id) IN('published','approved','archived')
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;
CREATE TRIGGER IF NOT EXISTS trg_o_frozen_del BEFORE DELETE ON options
WHEN (SELECT s.status FROM questions q JOIN submissions s ON s.id=q.submission_id WHERE q.id=OLD.question_id) IN('published','approved','archived')
AND EXISTS(SELECT 1 FROM questions WHERE id=OLD.question_id)
BEGIN SELECT RAISE(ABORT,'frozen:content_not_editable'); END;

-- audit trail is append-only ------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit:immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit:immutable'); END;
`;

const GABECE = [
  'Mathematics', 'English Language', 'Science', 'Social and Environmental Studies (SES)', 'Arabic', 'French',
  'Literature-in-English', 'Islamic Studies', 'Christian Religious Education', 'Agricultural Science',
  'Physical Education', 'Engineering Science', 'Home Economics', 'Art and Craft', 'Technical Drawing',
  'Metalwork', 'Woodwork',
];
const WASSCE = [
  'Agricultural Science', 'Arabic', 'Animal Husbandry', 'Biology', 'Business Management', 'Chemistry',
  'Christian Religious Studies', 'Civic Education', 'Commerce', 'Crop Husbandry', 'Economics',
  'English Language', 'Entrepreneurship', 'Foods and Nutrition', 'French', 'Further Mathematics', 'Geography',
  'Government', 'Health Science', 'History', 'Home Management', 'Information and Communication Technology (ICT)',
  'Insurance', 'Islamic Studies', 'Literature-in-English', 'Marketing', 'Mathematics', 'Metalwork',
  'Physical Education', 'Physics', 'Principles of Cost Accounting', 'Science', 'Technical Drawing',
  'Visual Arts', 'Woodwork',
];

const DEFAULT_SETTINGS = {
  admin_recruitment_enabled: '0',
  require_phone_verification: '0',
  year_min: String(cfg.YEAR_MIN),
  year_max: String(cfg.YEAR_MAX),
  content_types: JSON.stringify([
    { id: 'past_paper', label: 'Past Paper', section: 'paper' },
    { id: 'practice_exercise', label: 'Practice Exercise', section: 'paper' },
    { id: 'answer_key', label: 'Answer Key', section: 'material' },
    { id: 'worked_solution', label: 'Worked Solution', section: 'material' },
    { id: 'notes', label: 'Notes', section: 'material' },
    { id: 'formula_sheet', label: 'Formula Sheet', section: 'material' },
    { id: 'topic_summary', label: 'Topic Summary', section: 'material' },
    { id: 'worked_example', label: 'Worked Example', section: 'material' },
    { id: 'revision_guide', label: 'Revision Guide', section: 'material' },
    { id: 'diagram', label: 'Diagram / Illustration', section: 'material' },
    { id: 'other', label: 'Other Teaching Resource', section: 'material' },
  ]),
};

function migrate() {
  db.exec(SCHEMA);
  db.exec(TRIGGERS);
  seed();
}

function seed() {
  const has = db.prepare('SELECT 1 FROM meta WHERE key=?').get('seeded_v1');
  if (has) return;
  db.exec('BEGIN');
  try {
    const insExam = db.prepare('INSERT OR IGNORE INTO exams(code,name,grade,description,sort) VALUES(?,?,?,?,?)');
    insExam.run('GABECE', 'GABECE', 'Grade 9', 'Gambia Basic Education Certificate Examination', 1);
    insExam.run('WASSCE', 'WASSCE', 'Grade 12', 'West African Senior School Certificate Examination', 2);
    const g = db.prepare("SELECT id FROM exams WHERE code='GABECE'").get().id;
    const w = db.prepare("SELECT id FROM exams WHERE code='WASSCE'").get().id;
    const insSub = db.prepare('INSERT OR IGNORE INTO subjects(exam_id,name,sort) VALUES(?,?,?)');
    GABECE.forEach((n, i) => insSub.run(g, n, i + 1));
    WASSCE.forEach((n, i) => insSub.run(w, n, i + 1));
    const insPT = db.prepare('INSERT OR IGNORE INTO paper_types(name,sort) VALUES(?,?)');
    insPT.run('Paper 1', 1); insPT.run('Paper 2', 2);
    const insSet = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, v);
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('seeded_v1', new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Run fn inside a transaction. Rolls back on any throw. */
let txDepth = 0;
function tx(fn) {
  // Re-entrant: an inner tx() joins the outer transaction, so any failure rolls back the whole unit of work.
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  finally { txDepth--; }
}

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function getMeta(key) { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? r.value : null; }
function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function audit(actor, action, targetType, targetId, detail, scope = 'content', ip = null) {
  db.prepare('INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,detail,scope,ip) VALUES(?,?,?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? actor.full_name : 'system', action, targetType || null, targetId || null,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), scope, ip);
}

function notify(userId, title, body, link) {
  db.prepare('INSERT INTO notifications(user_id,title,body,link) VALUES(?,?,?,?)').run(userId, title, body || null, link || null);
}

migrate();

module.exports = { db, q, tx, audit, notify, getSetting, setSetting, getMeta, setMeta, migrate, GABECE, WASSCE };
