'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { db, L, multipart, newStudent, newStaff, Client, fixture } = H;
const q = db.q;

const CHIEF_PW = 'ChiefPassw0rd';
let chief; let admin; let mainAdmin; let sup; let sup2; let teacher; let s1; let s2;
let mathWassce; let engWassce; let physWassce; let bioWassce; let wassceId; let paper1; let paperId;

test.before(async () => { await H.start(); H.auth.provisionChief(CHIEF_PW); });
test.after(() => H.stop());

const subj = (exam, name) => q.get('SELECT s.id FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE e.code=? AND s.name=?', exam, name).id;

test('seed: 17 GABECE + 35 WASSCE subjects, no invented past papers', () => {
  assert.equal(q.get("SELECT COUNT(*) c FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE e.code='GABECE'").c, 17);
  assert.equal(q.get("SELECT COUNT(*) c FROM subjects s JOIN exams e ON e.id=s.exam_id WHERE e.code='WASSCE'").c, 35);
  assert.equal(q.get('SELECT COUNT(*) c FROM submissions').c, 0);
  mathWassce = subj('WASSCE', 'Mathematics'); engWassce = subj('WASSCE', 'English Language'); physWassce = subj('WASSCE', 'Physics'); bioWassce = subj('WASSCE', 'Biology');
  wassceId = q.get("SELECT id FROM exams WHERE code='WASSCE'").id;
  paper1 = q.get("SELECT id FROM paper_types WHERE name='Paper 1'").id;
});

// ---------------------------------------------------------------- 1. accounts
test('AT1 student registers, logs in by email AND phone, session persists', async () => {
  s1 = await newStudent('Alice');
  const me = await s1.get('/api/auth/me');
  assert.equal(me.json.user.role, 'student');
  const ph = new Client('phone');
  L.resetRateLimits();
  const reg = await ph.post('/api/auth/register', { full_name: 'Phone User', school: 'X School', phone: '+220 701 2345', password: 'Passw0rd1' });
  assert.equal(reg.status, 201);
  const out = new Client('x'); const lg = await out.login('7012345', 'Passw0rd1');
  assert.equal(lg.status, 200, 'login by bare 7-digit number');
  assert.equal((await out.login('+2207012345', 'Passw0rd1')).status, 200);
  assert.equal((await out.login('+2207012345', 'wrong')).status, 401);
});

test('registration validation: weak password, bad phone, duplicate, reserved chief email', async () => {
  L.resetRateLimits();
  const c = new Client('v');
  const base = { full_name: 'Val Idator', school: 'S School' };
  assert.equal((await c.post('/api/auth/register', { ...base, email: 'v1@example.com', password: 'short1' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...base, email: 'v1@example.com', password: 'onlyletters' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...base, phone: '12345', password: 'Passw0rd1' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...base, password: 'Passw0rd1' })).status, 400, 'needs email or phone');
  assert.equal((await c.post('/api/auth/register', { ...base, email: s1.email, password: 'Passw0rd1' })).status, 400, 'duplicate');
  const r = await c.post('/api/auth/register', { ...base, email: 'JProTheReal@gmail.com', password: 'Passw0rd1' });
  assert.equal(r.status, 400, 'chief email cannot be registered publicly');
  assert.equal(q.get("SELECT COUNT(*) c FROM users WHERE role='chief'").c, 1);
});

test('chief logs in; chief account provisioned only via operator script', async () => {
  chief = new Client('chief');
  const r = await chief.login('jprothereal@gmail.com', CHIEF_PW);
  assert.equal(r.status, 200); assert.equal(r.json.user.role, 'chief');
  assert.throws(() => H.auth.provisionChief(CHIEF_PW), /already exists/);
});

test('SMS verification is honestly reported as unavailable', async () => {
  const r = await s1.post('/api/auth/verify-phone', {});
  assert.equal(r.status, 501); assert.match(r.json.error, /not available|not configured/i);
  const st = await chief.put('/api/admin/settings', { require_phone_verification: true });
  assert.equal(st.status, 400, 'cannot require SMS when no provider');
});

// ---------------------------------------------------------------- 2. applications & roles
test('AT10/11 teacher + supervisor applications reach admin area; supervisor needs ≥2 subjects (max 4)', async () => {
  teacher = await newStudent('Tina');
  const bad = await teacher.post('/api/applications', { kind: 'teacher', subject_ids: [], qualifications: 'BSc Mathematics, 5 years teaching' });
  assert.equal(bad.status, 400);
  const ok = await teacher.post('/api/applications', { kind: 'teacher', subject_ids: [mathWassce], qualifications: 'BSc Mathematics, 5 years teaching' });
  assert.equal(ok.status, 201);

  const sa = await newStudent('Sam'); const sb = await newStudent('Sue');
  const one = await sa.post('/api/applications', { kind: 'supervisor', subject_ids: [mathWassce], qualifications: 'MSc Mathematics, examiner' });
  assert.equal(one.status, 400); assert.match(one.json.error, /at least two/i);
  const five = await sa.post('/api/applications', { kind: 'supervisor', subject_ids: [1, 2, 3, 4, 5], qualifications: 'MSc Mathematics, examiner' });
  assert.equal(five.status, 400); assert.match(five.json.error, /at most 4/i);
  assert.equal((await sa.post('/api/applications', { kind: 'supervisor', subject_ids: [mathWassce, physWassce], qualifications: 'MSc Mathematics, examiner' })).status, 201);
  assert.equal((await sb.post('/api/applications', { kind: 'supervisor', subject_ids: [engWassce, bioWassce], qualifications: 'MA English, examiner' })).status, 201);
  sup = sa; sup2 = sb;
  assert.equal((await sa.post('/api/applications', { kind: 'supervisor', subject_ids: [mathWassce, physWassce], qualifications: 'dup application text' })).status, 400, 'no duplicate open application');
  assert.equal((await sa.post('/api/applications', { kind: 'admin', qualifications: 'I want to be admin please' })).status, 403, 'admin recruitment closed by default');

  // pending applicants must NOT have privileges yet
  assert.equal((await teacher.get('/api/content/submissions')).status, 403);
  assert.equal((await sup.get('/api/content/submissions')).status, 403);
});

test('students/teachers cannot use admin endpoints (server-side RBAC)', async () => {
  for (const c of [s1, teacher, sup]) {
    for (const [m, u] of [['get', '/api/admin/overview'], ['get', '/api/admin/applications'], ['get', '/api/admin/users'], ['get', '/api/admin/audit']]) {
      assert.equal((await c[m](u)).status, 403, `${c.label} ${u}`);
    }
  }
  assert.equal((await new Client('anon').get('/api/admin/overview')).status, 401);
});

test('admin recruitment: chief enables, admin applies, only main admins decide', async () => {
  assert.equal((await chief.put('/api/admin/settings', { admin_recruitment_enabled: true })).status, 200);
  const a = await newStudent('Adam');
  assert.equal((await a.post('/api/applications', { kind: 'admin', qualifications: 'Education officer, 8 years' })).status, 201);
  const list = await chief.get('/api/admin/applications?kind=admin');
  assert.equal(list.json.items.length, 1);
  const dec = await chief.post(`/api/admin/applications/${list.json.items[0].id}/decide`, { decision: 'approve' });
  assert.equal(dec.status, 200);
  await a.login(a.email, a.password);
  assert.equal((await a.get('/api/admin/overview')).status, 200);
  admin = a;
  // a plain admin cannot decide an admin application
  const b = await newStudent('Bella');
  await b.post('/api/applications', { kind: 'admin', qualifications: 'Education officer, 3 years' });
  const l2 = await admin.get('/api/admin/applications?kind=admin');
  assert.equal((await admin.post(`/api/admin/applications/${l2.json.items[0].id}/decide`, { decision: 'approve' })).status, 403);
  // reject requires a reason and is recorded
  assert.equal((await chief.post(`/api/admin/applications/${l2.json.items[0].id}/decide`, { decision: 'reject' })).status, 400);
  assert.equal((await chief.post(`/api/admin/applications/${l2.json.items[0].id}/decide`, { decision: 'reject', reason: 'Not enough experience' })).status, 200);
  const rej = q.get('SELECT status,decided_by,decision_reason FROM applications WHERE id=?', l2.json.items[0].id);
  assert.equal(rej.status, 'rejected'); assert.equal(rej.decided_by, chief.id || q.get('SELECT id FROM users WHERE is_chief=1').id);
  assert.equal((await b.get('/api/admin/overview')).status, 403);
});

test('admin approves teacher + supervisor applications; supervisors get their subjects', async () => {
  const apps = (await admin.get('/api/admin/applications')).json.items;
  assert.ok(apps.some((x) => x.kind === 'teacher') && apps.filter((x) => x.kind === 'supervisor').length === 2);
  for (const a of apps) assert.equal((await admin.post(`/api/admin/applications/${a.id}/decide`, { decision: 'approve' })).status, 200);
  for (const c of [teacher, sup, sup2]) await c.login(c.email, c.password);
  assert.equal((await sup.get('/api/content/submissions')).status, 200);
  assert.equal(q.get('SELECT COUNT(*) c FROM supervisor_subjects WHERE user_id=?', sup.id).c, 2);
  assert.equal((await admin.get('/api/admin/supervisors')).json.items.find((x) => x.id === sup.id).subjects.length, 2);
  // admin cannot decide it twice, nor their own application
  assert.equal((await admin.post(`/api/admin/applications/${apps[0].id}/decide`, { decision: 'approve' })).status, 400);
});

test('AT12 role limits enforced by the database itself (not just the UI)', () => {
  // supervisor → max 4 subjects
  const supId = sup.id;
  q.run('INSERT INTO supervisor_subjects(user_id,subject_id) VALUES(?,?)', supId, bioWassce);
  q.run('INSERT INTO supervisor_subjects(user_id,subject_id) VALUES(?,?)', supId, engWassce);
  assert.throws(() => q.run('INSERT INTO supervisor_subjects(user_id,subject_id) VALUES(?,?)', supId, subj('WASSCE', 'Chemistry')), /limit:supervisor_subjects/);
  q.run('DELETE FROM supervisor_subjects WHERE user_id=? AND subject_id IN(?,?)', supId, bioWassce, engWassce);
  // main admins → max 5 including chief
  const mk = (email, role) => q.run('INSERT INTO users(full_name,email,pass_hash,role) VALUES(?,?,?,?)', 'X', email, 'h', role);
  for (let i = 0; i < 4; i++) mk(`ma${i}@example.com`, 'main_admin');
  assert.throws(() => mk('ma5@example.com', 'main_admin'), /limit:main_admins/);
  const stu = mk('promote@example.com', 'student');
  assert.throws(() => q.run("UPDATE users SET role='main_admin' WHERE id=?", Number(stu.lastInsertRowid)), /limit:main_admins/);
  q.run("DELETE FROM users WHERE email LIKE 'ma_@example.com' OR email='promote@example.com'");
  // chief protection
  const cid = q.get('SELECT id FROM users WHERE is_chief=1').id;
  assert.throws(() => q.run("UPDATE users SET role='student', is_chief=0 WHERE id=?", cid), /chief_protected/);
  assert.throws(() => q.run("UPDATE users SET status='blocked' WHERE id=?", cid), /chief_protected/);
  assert.throws(() => q.run('DELETE FROM users WHERE id=?', cid), /chief_protected/);
  assert.throws(() => q.run("UPDATE users SET is_chief=1, role='chief' WHERE id=?", s1.id), /chief_not_assignable/);
});

test('AT12 teacher (5,000) and supervisor (200) caps', () => {
  const ins = db.db.prepare("INSERT INTO users(full_name,email,pass_hash,role) VALUES('bulk',?,?, ?)");
  const t0 = q.get("SELECT COUNT(*) c FROM users WHERE role='teacher'").c;
  db.db.exec('BEGIN');
  for (let i = 0; i < 5000 - t0; i++) ins.run(`bt${i}@bulk.test`, 'h', 'teacher');
  db.db.exec('COMMIT');
  assert.throws(() => ins.run('bt-over@bulk.test', 'h', 'teacher'), /limit:teachers/);
  const s0 = q.get("SELECT COUNT(*) c FROM users WHERE role='supervisor'").c;
  db.db.exec('BEGIN');
  for (let i = 0; i < 200 - s0; i++) ins.run(`bs${i}@bulk.test`, 'h', 'supervisor');
  db.db.exec('COMMIT');
  assert.throws(() => ins.run('bs-over@bulk.test', 'h', 'supervisor'), /limit:supervisors/);
  q.run("DELETE FROM users WHERE email LIKE '%@bulk.test'");
});

test('role changes: only main admins; only chief appoints main admins; chief untouchable', async () => {
  const victim = await newStudent('Victor');
  assert.equal((await admin.post(`/api/admin/users/${victim.id}/role`, { role: 'teacher' })).status, 403, 'plain admin cannot change roles');
  assert.equal((await victim.post(`/api/admin/users/${victim.id}/role`, { role: 'admin' })).status, 403, 'no self-escalation');
  const cid = q.get('SELECT id FROM users WHERE is_chief=1').id;
  assert.equal((await chief.post(`/api/admin/users/${cid}/role`, { role: 'student' })).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${cid}/block`, { reason: 'try to block chief' })).status, 403);
  // chief appoints a main admin; main admin cannot appoint another
  const ma = await newStudent('Maya');
  assert.equal((await chief.post(`/api/admin/users/${ma.id}/role`, { role: 'main_admin' })).status, 200);
  await ma.login(ma.email, ma.password); mainAdmin = ma;
  assert.equal((await ma.post(`/api/admin/users/${victim.id}/role`, { role: 'main_admin' })).status, 403);
  assert.equal((await ma.post(`/api/admin/users/${victim.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await ma.post(`/api/admin/users/${cid}/block`, { reason: 'nope nope' })).status, 403);
  assert.equal((await ma.put('/api/admin/settings', { admin_recruitment_enabled: false })).status, 403, 'settings are chief-only');
});

// ---------------------------------------------------------------- 3. content workflow
let sub; let origFile;
test('AT3 admin uploads a PDF and views the original file; invalid uploads are rejected', async () => {
  const fields = { exam_id: wassceId, subject_id: mathWassce, year: 2019, paper_type_id: paper1, content_type: 'past_paper', origin: 'official', title: 'TEST FIXTURE Mathematics 2019 Paper 1', provenance: 'Fictional test fixture, not a real paper' };
  const pdf = fixture('sample-paper.pdf');
  const r = await admin.post('/api/content/submissions', undefined, { form: multipart(fields, [{ name: 'paper.pdf', type: 'application/pdf', data: pdf }]) });
  assert.equal(r.status, 201, JSON.stringify(r.json)); paperId = r.json.id;
  assert.equal(q.get('SELECT status FROM submissions WHERE id=?', paperId).status, 'draft');
  const det = await admin.get(`/api/content/submissions/${paperId}`);
  origFile = det.json.files[0];
  const f = await admin.req('GET', `/api/files/${origFile.id}`, undefined, { raw: true });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await f.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // failure cases
  const fake = await admin.post('/api/content/submissions', undefined, { form: multipart(fields, [{ name: 'evil.pdf', type: 'application/pdf', data: Buffer.from('<html><script>alert(1)</script>') }]) });
  assert.equal(fake.status, 400); assert.match(fake.json.error, /not an allowed file type/);
  const exe = await admin.post('/api/content/submissions', undefined, { form: multipart(fields, [{ name: 'x.pdf', type: 'application/pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]) }]) });
  assert.equal(exe.status, 400);
  const huge = await admin.post('/api/content/submissions', undefined, { form: multipart(fields, [{ name: 'big.pdf', type: 'application/pdf', data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(31 * 1024 * 1024)]) }]) });
  assert.equal(huge.status, 400); assert.match(huge.json.error, /larger than/);
  assert.equal((await admin.post('/api/content/submissions', undefined, { form: multipart({ ...fields, year: 1999 }, [{ name: 'p.pdf', data: pdf }]) })).status, 400, 'year out of range');
  assert.equal((await admin.post('/api/content/submissions', undefined, { form: multipart({ ...fields, subject_id: engWassce, exam_id: q.get("SELECT id FROM exams WHERE code='GABECE'").id }, [{ name: 'p.pdf', data: pdf }]) })).status, 400, 'subject/exam mismatch');
  assert.equal((await admin.post('/api/content/submissions', undefined, { form: multipart({ ...fields, provenance: '' }, [{ name: 'p.pdf', data: pdf }]) })).status, 400, 'provenance required');
  assert.equal(q.get('SELECT COUNT(*) c FROM submissions').c, 1, 'failed uploads leave nothing behind');
  assert.equal(q.get('SELECT COUNT(*) c FROM files').c, 1);
});

test('AT2/18 students and others cannot see drafts or their files', async () => {
  assert.equal((await s1.get(`/api/content/submissions/${paperId}`)).status, 403);
  assert.equal((await s1.get(`/api/files/${origFile.id}`)).status, 404);
  assert.equal((await s1.get(`/api/library/papers/${paperId}`)).status, 404);
  assert.equal((await teacher.get(`/api/files/${origFile.id}`)).status, 404, 'unrelated teacher');
  assert.equal((await sup.get(`/api/files/${origFile.id}`)).status, 404, 'unassigned supervisor');
  assert.equal((await new Client('anon').get(`/api/files/${origFile.id}`)).status, 401);
  const stored = q.get('SELECT stored_name FROM files WHERE id=?', origFile.id).stored_name;
  const anon = new Client('anon');
  for (const u of [`/data/private/${stored}`, `/private/${stored}`, `/../data/private/${stored}`, '/..%2Fdata%2Fapp.db', '/data/app.db']) {
    const r = await anon.req('GET', u, undefined, { raw: true });
    const ct = r.headers.get('content-type') || ''; const body = Buffer.from(await r.arrayBuffer());
    assert.ok(!ct.includes('pdf') && !body.subarray(0, 5).toString().startsWith('%PDF') && !body.subarray(0, 6).toString().startsWith('SQLite'), `no direct access via ${u}`);
  }
  assert.equal((await s1.get('/api/library/subjects/' + mathWassce)).json.years.length, 0, 'library empty until published');
});

test('AT4 extraction creates editable draft questions (PDF text) and OCR path works on a scan', async () => {
  const r = await admin.post(`/api/content/submissions/${paperId}/extract`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.created, 5); assert.deepEqual(r.json.methods, ['pdf-text']);
  const det = (await admin.get(`/api/content/submissions/${paperId}`)).json;
  assert.equal(det.questions.length, 5);
  assert.equal(det.questions.filter((x) => x.type === 'objective').length, 3);
  assert.ok(det.questions.every((x) => x.answer_source === 'none'), 'nothing is pre-answered or pre-verified');
  assert.equal(det.questions[0].page_ref, 1); assert.equal(det.questions[3].page_ref, 2);
  assert.ok(det.problems.length > 0, 'cannot be approved with no answers');
  // OCR on an image-only submission
  const f2 = { exam_id: wassceId, subject_id: mathWassce, year: 2018, paper_type_id: paper1, content_type: 'past_paper', origin: 'official', title: 'TEST SCAN', provenance: 'Fictional fixture' };
  const up = await admin.post('/api/content/submissions', undefined, { form: multipart(f2, [{ name: 'scan.png', type: 'image/png', data: fixture('scan.png') }]) });
  assert.equal(up.status, 201);
  const ex = await admin.post(`/api/content/submissions/${up.json.id}/extract`, {});
  assert.equal(ex.status, 200); assert.deepEqual(ex.json.methods, ['ocr']); assert.equal(ex.json.created, 3);
  await admin.del(`/api/content/submissions/${up.json.id}`);
});

test('typed questions can be imported and edited; reorder works', async () => {
  const f = { exam_id: wassceId, subject_id: mathWassce, year: 2017, paper_type_id: paper1, content_type: 'practice_exercise', origin: 'practice', title: 'TEST typed', provenance: 'Written by tester', body: '' };
  const up = await admin.post('/api/content/submissions', undefined, { form: multipart({ ...f, body: '1. Typed Q?\nA. yes\nB. no\n2. Another?' }, []) });
  assert.equal(up.status, 201);
  const im = await admin.post(`/api/content/submissions/${up.json.id}/import-text`, { text: '1. Typed Q?\nA. yes\nB. no\n2. Another?' });
  assert.equal(im.json.created, 2);
  const qs = (await admin.get(`/api/content/submissions/${up.json.id}`)).json.questions;
  assert.equal((await admin.post(`/api/content/submissions/${up.json.id}/reorder`, { order: [qs[1].id, qs[0].id] })).status, 200);
  assert.equal((await admin.post(`/api/content/submissions/${up.json.id}/reorder`, { order: [qs[1].id] })).status, 400);
  assert.equal((await admin.put(`/api/content/questions/${qs[0].id}`, { text: 'Edited typed question?' })).status, 200);
  assert.equal((await admin.del(`/api/content/questions/${qs[1].id}`)).status, 200);
  assert.equal((await admin.del(`/api/content/submissions/${up.json.id}`)).status, 200);
});

test('AI answer preparation reports "not configured" rather than inventing answers', async () => {
  const qid = q.get('SELECT id FROM questions WHERE submission_id=? LIMIT 1', paperId).id;
  const r = await admin.post(`/api/content/questions/${qid}/ai-draft`, {});
  assert.equal(r.status, 503); assert.match(r.json.error, /not configured/i);
  assert.equal(q.get('SELECT answer_source FROM questions WHERE id=?', qid).answer_source, 'none');
  assert.equal((await s1.get('/api/tutor/status')).json.configured, false);
  assert.equal((await s1.post('/api/tutor', { message: 'Explain primes' })).status, 503);
});

test('AT4 answers can be edited; AI drafts / unanswered questions block approval', async () => {
  const qs = (await admin.get(`/api/content/submissions/${paperId}`)).json.questions;
  // simulate an unverified AI draft landing in the DB: it must block approval
  q.run("UPDATE questions SET answer_source='ai_draft' WHERE id=?", qs[0].id);
  const ap0 = await admin.post(`/api/content/submissions/${paperId}/decide`, { decision: 'approve' });
  assert.equal(ap0.status, 400); assert.ok(ap0.json.problems.length >= 5);
  const mark = (o, label) => o.map((x) => ({ label: x.label, text: x.text, is_correct: x.label === label, why: x.label === label ? null : `${x.text} is not correct.` }));
  const correct = ['B', 'C', 'B'];
  for (let i = 0; i < 3; i++) {
    const r = await admin.put(`/api/content/questions/${qs[i].id}`, { options: mark(qs[i].options, correct[i]), explanation: `Because the answer is ${correct[i]}.`, topic: i === 1 ? 'Number theory' : 'Arithmetic' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await admin.put(`/api/content/questions/${qs[0].id}`, { options: [{ label: 'A', text: 'x', is_correct: true }, { label: 'B', text: 'y', is_correct: true }] })).status, 400, 'two correct options rejected');
  assert.equal((await admin.put(`/api/content/questions/${qs[3].id}`, { model_answer: 'A prime number has exactly two distinct positive factors: 1 and itself.', marking_guide: '1 mark definition, 2 marks examples', common_mistakes: 'Saying 1 is prime.' })).status, 200);
  assert.equal((await admin.put(`/api/content/questions/${qs[4].id}`, { model_answer: 'The number 1 has only one positive factor, so it does not satisfy the definition.' })).status, 200);
  // editing an answer turns an AI draft into a human-edited answer, not "official"
  assert.equal(q.get('SELECT answer_source FROM questions WHERE id=?', qs[0].id).answer_source, 'admin_verified');
});

test('AT5/6 assignment: only a supervisor with matching subject; supervisor reviews', async () => {
  // sup2 covers English + Biology, not Mathematics
  const bad = await admin.post(`/api/content/submissions/${paperId}/assign`, { supervisor_id: sup2.id });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /not assigned to this subject/);
  assert.equal((await admin.post(`/api/content/submissions/${paperId}/assign`, { supervisor_id: teacher.id })).status, 400, 'must be a supervisor');
  const det = (await admin.get(`/api/content/submissions/${paperId}`)).json;
  assert.deepEqual(det.eligible_supervisors.map((x) => x.id), [sup.id]);
  assert.equal((await admin.post(`/api/content/submissions/${paperId}/assign`, { supervisor_id: sup.id, note: 'Please check carefully' })).status, 200);
  const row = q.get('SELECT status,review_status,supervisor_id,assigned_by FROM submissions WHERE id=?', paperId);
  assert.deepEqual({ ...row }, { status: 'in_review', review_status: 'pending', supervisor_id: sup.id, assigned_by: admin.id || row.assigned_by });
  // supervisor sees it; other supervisor / teacher / student do not
  assert.equal((await sup.get(`/api/content/submissions/${paperId}`)).status, 200);
  assert.equal((await sup.get('/api/content/submissions')).json.items.length, 1);
  assert.equal((await sup2.get(`/api/content/submissions/${paperId}`)).status, 404);
  assert.equal((await sup2.get('/api/content/submissions')).json.items.length, 0);
  // supervisor can view original, and cannot approve/publish
  assert.equal((await sup.get(`/api/files/${origFile.id}`)).status, 200);
  assert.equal((await sup.post(`/api/content/submissions/${paperId}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await sup.post(`/api/content/submissions/${paperId}/publish`, {})).status, 403);
  // review: corrections require comment, then recommend approval
  assert.equal((await sup.post(`/api/content/submissions/${paperId}/review`, { action: 'request_corrections' })).status, 400);
  assert.equal((await sup.post(`/api/content/submissions/${paperId}/review`, { action: 'request_corrections', comment: 'Q2 answer looks wrong, please recheck' })).status, 200);
  assert.equal(q.get('SELECT review_status FROM submissions WHERE id=?', paperId).review_status, 'corrections_requested');
  // admin cannot approve while corrections are outstanding
  assert.equal((await admin.post(`/api/content/submissions/${paperId}/decide`, { decision: 'approve' })).status, 400);
  assert.equal((await sup.post(`/api/content/submissions/${paperId}/review`, { action: 'recommend_approval', comment: 'All good now' })).status, 200);
  const r = q.get('SELECT reviewer_id,reviewed_at,review_comment FROM submissions WHERE id=?', paperId);
  assert.equal(r.reviewer_id, sup.id); assert.equal(r.review_comment, 'All good now');
});

test('AT7/8 approval is separate from publishing; frozen after approval; reviewer ≠ approver stored', async () => {
  assert.equal((await admin.post(`/api/content/submissions/${paperId}/publish`, {})).status, 403, 'plain admin may not publish');
  const ap = await admin.post(`/api/content/submissions/${paperId}/decide`, { decision: 'approve', comment: 'Verified' });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const s = q.get('SELECT status,reviewer_id,approver_id,published_by FROM submissions WHERE id=?', paperId);
  assert.equal(s.status, 'approved'); assert.equal(s.reviewer_id, sup.id); assert.notEqual(s.approver_id, s.reviewer_id); assert.equal(s.published_by, null);
  // still invisible to students
  assert.equal((await s1.get(`/api/library/papers/${paperId}`)).status, 404);
  assert.equal((await s1.get('/api/library/subjects/' + mathWassce)).json.years.length, 0);
  // locked
  const qid = q.get('SELECT id FROM questions WHERE submission_id=? LIMIT 1', paperId).id;
  assert.equal((await admin.put(`/api/content/questions/${qid}`, { text: 'sneaky edit' })).status, 403);
  assert.throws(() => q.run('UPDATE questions SET text=? WHERE id=?', 'sneaky', qid), /frozen/, 'DB trigger also blocks it');
  assert.throws(() => q.run('UPDATE options SET is_correct=1 WHERE question_id=?', qid), /frozen/);
  // DB gate: cannot jump a draft to published
  const other = q.run("INSERT INTO submissions(title,exam_id,subject_id,content_type,section,provenance,uploader_id) VALUES('t',?,?,'notes','material','p',?)", wassceId, mathWassce, admin.id || 1);
  assert.throws(() => q.run("UPDATE submissions SET status='published', published_by=1, approver_id=1 WHERE id=?", Number(other.lastInsertRowid)), /publish_requires_approved/);
  assert.throws(() => q.run("INSERT INTO submissions(title,exam_id,subject_id,content_type,section,provenance,uploader_id,status) VALUES('t',?,?,'notes','material','p',1,'published')", wassceId, mathWassce), /must_start_as_draft/);
  q.run('DELETE FROM submissions WHERE id=?', Number(other.lastInsertRowid));
});

test('AT8/9 main admin publishes; content appears in the right exam/subject/year/paper', async () => {
  const pub = await mainAdmin.post(`/api/content/submissions/${paperId}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const lib = (await s1.get('/api/library/subjects/' + mathWassce)).json;
  assert.equal(lib.years.length, 1); assert.equal(lib.years[0].year, 2019);
  assert.equal(lib.years[0].papers[0].paper_type, 'Paper 1');
  assert.equal(lib.years[0].papers[0].objective_count, 3); assert.equal(lib.years[0].papers[0].theory_count, 2);
  assert.equal((await s1.get('/api/library/subjects/' + engWassce)).json.years.length, 0, 'not in other subjects');
  const ex = (await s1.get('/api/library/exams')).json.exams;
  assert.equal(ex.find((e) => e.code === 'WASSCE').subjects.find((x) => x.id === mathWassce).papers, 1);
  assert.equal(ex.find((e) => e.code === 'GABECE').subjects.reduce((n, x) => n + x.papers, 0), 0);
  // the original file stays hidden until an admin clears it for distribution
  assert.equal((await s1.get(`/api/files/${origFile.id}`)).status, 404);
  assert.equal((await admin.put(`/api/content/files/${origFile.id}`, { student_visible: true })).status, 200);
  assert.equal((await s1.get(`/api/files/${origFile.id}`)).status, 200);
});

test('AT15 student paper view: no answer leaks for objectives, theory model answer shown by default, reviewer+approver on top', async () => {
  const p = (await s1.get(`/api/library/papers/${paperId}`)).json;
  assert.ok(p.paper.reviewer_name && p.paper.approver_name);
  assert.equal(p.paper.origin_label, 'Official past examination paper');
  const raw = JSON.stringify(p.questions.filter((x) => x.type === 'objective'));
  assert.ok(!raw.includes('is_correct') && !raw.includes('explanation') && !raw.includes('correct_option_id'), 'no objective answers before attempting');
  const th = p.questions.filter((x) => x.type === 'theory');
  assert.equal(th.length, 2); assert.match(th[0].model_answer, /exactly two distinct/); assert.match(th[0].marking_guide, /1 mark/);
  assert.ok(th[0].answer_label);
});

// ---------------------------------------------------------------- 4. quiz engine
let sess; let qA; let qB; let qC;
test('AT13 objective engine: wrong → retry → reveal after two misses, repeated selection never freezes', async () => {
  const st = await s1.post('/api/quiz/start', { kind: 'paper', submission_id: paperId });
  assert.equal(st.status, 201); sess = st.json.session.id;
  assert.equal(st.json.questions.length, 3);
  [qA, qB, qC] = st.json.questions;
  assert.ok(!JSON.stringify(st.json).includes('is_correct'));
  const L1 = qA.options.find((o) => o.label === 'A'); const L2 = qA.options.find((o) => o.label === 'C'); const OK = qA.options.find((o) => o.label === 'B');
  const w1 = await s1.post(`/api/quiz/${sess}/answer`, { question_id: qA.id, option_id: L1.id });
  assert.equal(w1.json.correct, false); assert.equal(w1.json.attempts_left, 1); assert.equal(w1.json.resolved, false);
  assert.equal(w1.json.correct_option_id, undefined, 'correct answer not revealed after first miss');
  assert.match(w1.json.selected_feedback, /not correct/);
  assert.equal((await s1.post(`/api/quiz/${sess}/answer`, { question_id: qA.id, option_id: L1.id })).status, 400, 'same wrong option twice is refused without burning an attempt');
  const w2 = await s1.post(`/api/quiz/${sess}/answer`, { question_id: qA.id, option_id: L2.id });
  assert.equal(w2.json.resolved, true); assert.equal(w2.json.attempts_left, 0); assert.equal(w2.json.correct_option_id, OK.id); assert.match(w2.json.explanation, /answer is B/);
  assert.equal(w2.json.points, 0);
  // further clicks after resolution do nothing and never double count
  const again = await s1.post(`/api/quiz/${sess}/answer`, { question_id: qA.id, option_id: OK.id });
  assert.equal(again.json.duplicate, true); assert.equal(again.json.points, 0); assert.equal(again.json.attempts_used, 2);
  assert.equal(q.get('SELECT COUNT(*) c FROM attempts WHERE session_id=? AND question_id=?', sess, qA.id).c, 2);
});

test('AT14 scoring: first-try 1, second-try 0.5, no duplicates under double-taps and parallel requests', async () => {
  const okB = qB.options.find((o) => o.label === 'C');
  const uid = 'client-uid-1';
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => s1.post(`/api/quiz/${sess}/answer`, { question_id: qB.id, option_id: okB.id, client_uid: uid })));
  const oks = [r1, r2, r3].filter((r) => r.status === 200);
  assert.ok(oks.length >= 1);
  assert.equal(q.get('SELECT COUNT(*) c FROM attempts WHERE session_id=? AND question_id=?', sess, qB.id).c, 1, 'parallel duplicate requests record ONE attempt');
  const rs = q.get('SELECT * FROM question_results WHERE session_id=? AND question_id=?', sess, qB.id);
  assert.equal(rs.points, 1); assert.equal(rs.correct, 1); assert.equal(rs.attempts_used, 1);
  // Q3: wrong then right = 0.5
  const wrong = qC.options.find((o) => o.label === 'D'); const right = qC.options.find((o) => o.label === 'B');
  const a = await s1.post(`/api/quiz/${sess}/answer`, { question_id: qC.id, option_id: wrong.id }); assert.equal(a.json.correct, false);
  const b = await s1.post(`/api/quiz/${sess}/answer`, { question_id: qC.id, option_id: right.id });
  assert.equal(b.json.correct, true); assert.equal(b.json.points, 0.5); assert.equal(b.json.progress.score, 1.5); assert.equal(b.json.progress.answered, 3);
  // hammering: parallel wrong picks on a fresh session cannot exceed 2 attempts
  const s2sess = (await s1.post('/api/quiz/start', { kind: 'paper', submission_id: paperId, fresh: true })).json;
  const qq = s2sess.questions[0];
  await Promise.all(qq.options.map((o) => s1.post(`/api/quiz/${s2sess.session.id}/answer`, { question_id: qq.id, option_id: o.id })));
  const n = q.get('SELECT COUNT(*) c FROM attempts WHERE session_id=? AND question_id=?', s2sess.session.id, qq.id).c;
  assert.ok(n <= 2, `at most two attempts recorded, got ${n}`);
  assert.ok(q.get('SELECT attempts_used FROM question_results WHERE session_id=? AND question_id=?', s2sess.session.id, qq.id).attempts_used <= 2);
  await s1.post(`/api/quiz/${s2sess.session.id}/finish`, {});
});

test('AT14 finish + summary + retry missed + progress records stay consistent', async () => {
  const fin = await s1.post(`/api/quiz/${sess}/finish`, {});
  assert.equal(fin.json.score, 1.5); assert.equal(fin.json.total, 3); assert.equal(fin.json.first_try, 1); assert.equal(fin.json.second_try, 1); assert.equal(fin.json.missed, 1); assert.equal(fin.json.percent, 50);
  const fin2 = await s1.post(`/api/quiz/${sess}/finish`, {});
  assert.equal(fin2.json.score, 1.5, 'finishing twice is idempotent');
  assert.equal((await s1.post(`/api/quiz/${sess}/answer`, { question_id: qB.id, option_id: qB.options[0].id })).status, 400, 'finished quiz is closed');
  const retry = await s1.post(`/api/quiz/${sess}/retry`, { only_missed: true });
  assert.equal(retry.status, 201); assert.equal(retry.json.questions.length, 2, 'missed + second-try questions');
  const prog = (await s1.get('/api/progress')).json;
  const answered = q.get('SELECT COUNT(*) c FROM question_results WHERE user_id=? AND resolved=1', s1.id).c;
  assert.equal(prog.totals.answered, answered);
  assert.equal(prog.by_subject[0].subject, 'Mathematics');
  assert.ok(prog.recent_sessions.length >= 2);
  assert.ok(prog.mistakes_to_review >= 2);
  const mist = (await s1.get('/api/progress/mistakes')).json.items;
  assert.ok(mist.length >= 2 && mist[0].options.some((o) => o.is_correct), 'mistake review shows the correct answers of resolved questions');
});

test('quiz sessions are private to their owner; unavailable content cannot be started', async () => {
  s2 = await newStudent('Bob');
  assert.equal((await s2.get(`/api/quiz/${sess}`)).status, 404);
  assert.equal((await s2.post(`/api/quiz/${sess}/answer`, { question_id: qA.id, option_id: qA.options[0].id })).status, 404);
  assert.equal((await s2.post('/api/quiz/start', { kind: 'paper', submission_id: 99999 })).status, 404);
  assert.equal((await s2.get('/api/progress')).json.totals.answered, 0, "another student's progress is separate");
  const d = await s1.post('/api/quiz/start', { kind: 'daily' });
  assert.equal(d.status, 201); assert.ok(d.json.questions.length >= 1);
  assert.equal((await s1.post('/api/quiz/start', { kind: 'daily' })).json.resumed, true, 'one daily challenge per day');
});

test('timed quiz expires server-side', async () => {
  const st = (await s2.post('/api/quiz/start', { kind: 'paper', submission_id: paperId, timed: true })).json;
  q.run('UPDATE quiz_sessions SET deadline=? WHERE id=?', Date.now() - 1000, st.session.id);
  const r = await s2.post(`/api/quiz/${st.session.id}/answer`, { question_id: st.questions[0].id, option_id: st.questions[0].options[0].id });
  assert.equal(r.status, 400); assert.match(r.json.error, /time is up/i);
  assert.ok(q.get('SELECT finished_at FROM quiz_sessions WHERE id=?', st.session.id).finished_at);
});

test('unpublishing removes access; students keep their history; republish restores', async () => {
  assert.equal((await admin.post(`/api/content/submissions/${paperId}/unpublish`, { comment: 'Checking an error report' })).status, 200);
  assert.equal((await s1.get(`/api/library/papers/${paperId}`)).status, 404);
  assert.equal((await s1.get(`/api/files/${origFile.id}`)).status, 404);
  assert.equal((await s2.post('/api/quiz/start', { kind: 'paper', submission_id: paperId })).status, 404);
  assert.ok((await s1.get('/api/progress')).json.totals.answered >= 3);
  assert.equal((await mainAdmin.post(`/api/content/submissions/${paperId}/publish`, {})).status, 200);
  const ev = q.all('SELECT action FROM review_events WHERE submission_id=? ORDER BY id', paperId).map((e) => e.action);
  for (const a of ['created', 'assigned', 'reviewed:corrections_requested', 'reviewed:recommend_approval', 'approved', 'published', 'unpublished']) assert.ok(ev.includes(a), a);
  assert.ok(q.get('SELECT COUNT(*) c FROM versions WHERE submission_id=?', paperId).c >= 5);
});

test('report an error: lands in the staff inbox', async () => {
  const r = await s1.post('/api/report', { type: 'error_report', question_id: qA.id, message: 'I think the answer to this is wrong' });
  assert.equal(r.status, 201);
  const inbox = (await admin.get('/api/admin/inbox?type=error_report')).json.items;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].question_id, qA.id);
  assert.equal((await admin.put(`/api/admin/inbox/${inbox[0].id}`, { status: 'resolved', note: 'checked, fine' })).status, 200);
  assert.equal((await s1.get('/api/admin/inbox')).status, 403);
});

// ---------------------------------------------------------------- 5. teacher + materials
test('teacher submits material for review; cannot publish official papers or bypass approval', async () => {
  const f = { exam_id: wassceId, subject_id: mathWassce, content_type: 'notes', title: 'Quadratic equations notes', provenance: 'Written by the teacher', topic: 'Algebra', body: 'Factorise, complete the square, or use the formula.' };
  const r = await teacher.post('/api/content/submissions', undefined, { form: multipart(f, []) });
  assert.equal(r.status, 201);
  const id = r.json.id;
  assert.equal(q.get('SELECT origin FROM submissions WHERE id=?', id).origin, 'teacher');
  assert.equal((await teacher.post(`/api/content/submissions/${id}/publish`, {})).status, 403);
  assert.equal((await teacher.post(`/api/content/submissions/${id}/decide`, { decision: 'approve' })).status, 403);
  const pp = await teacher.post('/api/content/submissions', undefined, { form: multipart({ ...f, content_type: 'past_paper', year: 2019, paper_type_id: paper1 }, [{ name: 'p.pdf', data: fixture('sample-paper.pdf') }]) });
  assert.equal(pp.status, 403, 'teachers cannot submit official past papers');
  assert.equal((await teacher.get('/api/content/submissions')).json.items.length, 1, 'teacher sees only own work');
  assert.equal((await admin.post(`/api/content/submissions/${id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal((await s1.get(`/api/library/materials/${id}`)).status, 404, 'approved is not published');
  assert.equal((await mainAdmin.post(`/api/content/submissions/${id}/publish`, {})).status, 200);
  const mat = (await s1.get(`/api/library/materials/${id}`)).json;
  assert.match(mat.material.origin_label, /not an official past examination paper/);
  assert.ok((await s1.get('/api/library/subjects/' + mathWassce)).json.materials.length === 1);
  assert.equal((await admin.post(`/api/content/submissions/${id}/archive`, { comment: 'old' })).status, 200);
  assert.equal((await s1.get(`/api/library/materials/${id}`)).status, 404);
  assert.equal(q.get('SELECT COUNT(*) c FROM review_events WHERE submission_id=?', id).c >= 4, true, 'archive keeps history');
});

// ---------------------------------------------------------------- 6. preferences, blocking, sessions, audit
test('AT16 scroll/page preference persists across sessions (default scroll ON, page OFF)', async () => {
  const me = (await s1.get('/api/auth/me')).json;
  assert.equal(me.prefs.scroll_mode, 1); assert.equal(me.prefs.page_mode, 0);
  assert.equal((await s1.put('/api/prefs', { scroll_mode: false, page_mode: true, font_scale: 1.2 })).status, 200);
  const fresh = new Client('s1-again'); await fresh.login(s1.email, s1.password);
  const me2 = (await fresh.get('/api/auth/me')).json;
  assert.equal(me2.prefs.scroll_mode, 0); assert.equal(me2.prefs.page_mode, 1); assert.equal(me2.prefs.font_scale, 1.2);
});

test('AT17 block/unblock with recorded reasons; blocked users are cut off immediately; audit trail', async () => {
  const bad = await newStudent('Mallory');
  assert.equal((await bad.get('/api/library/exams')).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${bad.id}/block`, {})).status, 400, 'reason required');
  assert.equal((await admin.post(`/api/admin/users/${bad.id}/block`, { reason: 'Harassing other students' })).status, 200);
  assert.equal((await bad.get('/api/library/exams')).status, 401, 'existing session is revoked');
  const lg = await bad.login(bad.email, bad.password);
  assert.equal(lg.status, 403); assert.match(lg.json.error, /blocked/i);
  assert.equal((await admin.post(`/api/admin/users/${bad.id}/unblock`, { reason: 'Appeal accepted' })).status, 200);
  assert.equal((await bad.login(bad.email, bad.password)).status, 200);
  // cannot block self or higher roles
  assert.equal((await admin.post(`/api/admin/users/${admin.id}/block`, { reason: 'self block test' })).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${mainAdmin.id}/block`, { reason: 'higher role test' })).status, 403);
  const log = (await admin.get('/api/admin/audit?action=user_')).json.items;
  assert.ok(log.some((l) => l.action === 'user_blocked' && l.target_id === bad.id && /Harassing/.test(l.detail)));
  assert.ok(log.some((l) => l.action === 'user_unblocked' && l.target_id === bad.id));
  assert.ok(log[0].actor_name);
  // audit is append-only, even for someone with DB access through the app
  assert.throws(() => q.run("UPDATE audit_log SET action='x' WHERE id=1"), /immutable/);
  assert.throws(() => q.run('DELETE FROM audit_log'), /immutable/);
  // security-scope events are for main administrators only
  assert.ok(!(await admin.get('/api/admin/audit?scope=security')).json.items.some((l) => l.scope === 'security'));
  assert.ok((await chief.get('/api/admin/audit?scope=security')).json.items.some((l) => l.scope === 'security'));
});

test('supervisor/admin sessions end after 5 hours idle; student sessions persist', async () => {
  const hours = (h) => Date.now() - h * 3600e3;
  const all = q.all('SELECT id FROM sessions WHERE user_id=? AND revoked=0', sup.id);
  q.run('UPDATE sessions SET last_seen=? WHERE user_id=?', hours(4.9), sup.id);
  assert.equal((await sup.get('/api/content/submissions')).status, 200, 'still valid at 4.9h');
  q.run('UPDATE sessions SET last_seen=? WHERE user_id=?', hours(5.1), sup.id);
  const r = await sup.get('/api/content/submissions');
  assert.equal(r.status, 401); assert.match(r.json.error, /expired/i);
  // the first call after idling (e.g. reopening the app) is told the session expired, so the UI can explain why
  await sup.login(sup.email, sup.password);
  q.run('UPDATE sessions SET last_seen=? WHERE user_id=? AND revoked=0', hours(5.1), sup.id);
  const me = (await sup.get('/api/auth/me')).json;
  assert.equal(me.user, null); assert.equal(me.session_expired, true);
  q.run('UPDATE sessions SET last_seen=? WHERE user_id=?', hours(5.1), admin.id || q.get('SELECT id FROM users WHERE role=?', 'admin').id);
  assert.equal((await admin.get('/api/admin/overview')).status, 401);
  q.run('UPDATE sessions SET last_seen=? WHERE user_id=?', hours(200), s1.id);
  assert.equal((await s1.get('/api/auth/me')).json.user.role, 'student', 'students stay logged in until they log out');
  await sup.login(sup.email, sup.password); await admin.login(admin.email, admin.password);
  assert.ok(all.length >= 0);
});

test('password reset: admin-issued one-time link; old sessions die; link works once', async () => {
  const u = await newStudent('Rita');
  assert.equal((await new Client('a').post('/api/auth/forgot', { identifier: u.email })).status, 200);
  assert.ok((await admin.get('/api/admin/inbox')).json.items.some((i) => /Password reset/.test(i.subject)));
  const link = await admin.post(`/api/admin/users/${u.id}/reset-link`, {});
  const token = link.json.path.split('/').pop();
  assert.equal((await new Client('a').post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await new Client('a').post('/api/auth/reset', { token, password: 'NewPassw0rd9' })).status, 200);
  assert.equal((await new Client('a').post('/api/auth/reset', { token, password: 'Another1Pass' })).status, 400, 'single use');
  assert.equal((await u.get('/api/auth/me')).json.user, null, 'old session revoked');
  assert.equal((await new Client('b').login(u.email, 'NewPassw0rd9')).status, 200);
  assert.equal((await admin.post(`/api/admin/users/${q.get('SELECT id FROM users WHERE is_chief=1').id}/reset-link`, {})).status, 403, "nobody can issue a reset for the chief");
});

test('login is rate limited and does not reveal whether an account exists', async () => {
  L.resetRateLimits();
  const c = new Client('rl'); let last;
  for (let i = 0; i < 12; i++) last = await c.post('/api/auth/login', { identifier: 'nobody@example.com', password: 'whatever1' });
  assert.equal(last.status, 429);
  L.resetRateLimits();
  const a = await new Client('x').post('/api/auth/login', { identifier: 'nobody@example.com', password: 'whatever1' });
  const b = await new Client('x').post('/api/auth/login', { identifier: s1.email, password: 'wrongpass1' });
  assert.equal(a.json.error, b.json.error);
});

test('security hygiene: headers, XSS stored as text, SQL injection inert, cross-site POST blocked, bodies bounded', async () => {
  const anon = new Client('anon');
  const r = await anon.req('GET', '/', undefined, { raw: true });
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  L.resetRateLimits();
  const inj = await anon.login("' OR 1=1 --", "' OR 1=1 --"); assert.equal(inj.status, 401);
  const x = await newStudent('Xss');
  await x.put('/api/profile', { full_name: '<img src=x onerror=alert(1)>', school: 'S' });
  assert.equal(q.get('SELECT full_name FROM users WHERE id=?', x.id).full_name, '<img src=x onerror=alert(1)>', 'stored verbatim; the UI escapes on render');
  const cross = await x.req('POST', '/api/prefs', { scroll_mode: true }, { headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const big = await anon.req('POST', '/api/contact', undefined, { headers: { 'content-type': 'application/json' }, raw: false });
  assert.ok([400, 413].includes(big.status));
  const avatarBad = await x.post('/api/profile/avatar', undefined, { form: multipart({}, [{ field: 'avatar', name: 'a.png', type: 'image/png', data: Buffer.from('<svg onload=alert(1)>') }]) });
  assert.equal(avatarBad.status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await x.post('/api/profile/avatar', undefined, { form: multipart({}, [{ field: 'avatar', name: 'a.png', type: 'image/png', data: png }]) })).status, 200);
  assert.equal((await x.req('GET', `/api/profile/avatar/${x.id}`, undefined, { raw: true })).status, 200);
  assert.equal((await s2.req('GET', `/api/profile/avatar/${x.id}`, undefined, { raw: true })).status, 403, 'avatars are private');
});

// ---------------------------------------------------------------- 7. classes, contact, donations
test('classes: join by code, roster privacy, quiz answers stay server-side, auto-grading, moderation', async () => {
  const cls = await teacher.post('/api/classes', { name: 'Form 5 Maths', kind: 'class', subject_id: mathWassce });
  assert.equal(cls.status, 201); const cid = cls.json.id;
  const code = (await teacher.get(`/api/classes/${cid}`)).json.class.join_code;
  assert.equal((await s1.post('/api/classes/join', { code: 'NOPE' })).status, 400);
  assert.equal((await s1.post('/api/classes/join', { code })).status, 200);
  assert.equal((await s2.get(`/api/classes/${cid}`)).status, 404, 'non-member cannot see the class');
  const asStudent = (await s1.get(`/api/classes/${cid}`)).json;
  assert.equal(asStudent.members, undefined, 'students do not get the roster'); assert.equal(asStudent.class.join_code, undefined);
  assert.equal((await teacher.get(`/api/classes/${cid}`)).json.members.length, 1);
  assert.equal((await s1.post(`/api/classes/${cid}/assignments`, { title: 'hack', kind: 'written' })).status, 403);
  const as = await teacher.post(`/api/classes/${cid}/assignments`, { kind: 'quiz', title: 'Quick quiz', questions: [{ text: '2+2?', options: ['3', '4'], correct: 1 }, { text: '3+3?', options: ['6', '7'], correct: 0 }] });
  assert.equal(as.status, 201);
  const list = (await s1.get(`/api/classes/${cid}/assignments`)).json.items;
  assert.ok(!JSON.stringify(list).includes('"correct"'), 'answers never sent to students');
  const sub = await s1.post(`/api/assignments/${as.json.id}/submit`, { answers: [1, 1] });
  assert.equal(sub.json.auto_score, 1); assert.equal(sub.json.auto_total, 2);
  assert.equal((await s1.post(`/api/assignments/${as.json.id}/submit`, { answers: [1, 0] })).status, 400, 'one submission only');
  assert.equal((await s2.post(`/api/assignments/${as.json.id}/submit`, { answers: [1, 0] })).status, 404);
  // chat + moderation
  const m = await s1.post(`/api/classes/${cid}/messages`, { body: 'Hello sir' }); assert.equal(m.status, 201);
  assert.equal((await s2.get(`/api/classes/${cid}/messages`)).status, 404);
  assert.equal((await teacher.post(`/api/classes/${cid}/members/${s1.id}/mute`, {})).status, 200);
  assert.equal((await s1.post(`/api/classes/${cid}/messages`, { body: 'muted?' })).status, 403);
  assert.equal((await teacher.del(`/api/classes/${cid}/messages/${m.json.id}`)).status, 200);
  assert.equal((await s1.post(`/api/classes/${cid}/messages/${m.json.id}/report`, { reason: 'x' })).status, 200);
});

test('contact form + donations: no fake payments', async () => {
  const anon = new Client('anon'); L.resetRateLimits();
  assert.equal((await anon.post('/api/contact', { subject: 'Hello', message: 'I would like to help with content.', contact: 'me@example.com' })).status, 201);
  assert.equal((await anon.post('/api/contact', { subject: 'x', message: 'short', contact: '' })).status, 400);
  assert.ok((await admin.get('/api/admin/inbox?type=contact')).json.items.some((i) => i.subject === 'Hello'));
  const o = (await anon.get('/api/donate/options')).json;
  assert.deepEqual(o.amounts, [10, 20, 30, 40, 50]); assert.equal(o.currency, 'GMD'); assert.ok(o.providers.every((p) => p.available === false)); assert.match(o.note, /not switched on|not been configured|not configured/i);
  const d = await anon.post('/api/donate/initiate', { provider: 'wave', amount: 20 });
  assert.equal(d.status, 503); assert.equal(q.get('SELECT COUNT(*) c FROM donations').c, 0, 'nothing recorded without a provider');
  const wh = await anon.post('/api/donate/webhook/wave', { reference: 'abc', status: 'confirmed' });
  assert.ok([403, 503].includes(wh.status));
  // with a secret configured, only a correctly signed webhook can confirm a donation
  process.env.WAVE_WEBHOOK_SECRET = 'whsec_test'; process.env.WAVE_API_KEY = 'k';
  q.run("INSERT INTO donations(provider,amount_gmd,provider_ref) VALUES('wave',20,'ref-1')");
  const body = JSON.stringify({ reference: 'ref-1', status: 'confirmed' });
  const bad = await anon.req('POST', '/api/donate/webhook/wave', undefined, { headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, form: { body, contentType: 'application/json' } });
  assert.equal(bad.status, 403); assert.equal(q.get("SELECT status FROM donations WHERE provider_ref='ref-1'").status, 'initiated');
  const sig = require('crypto').createHmac('sha256', 'whsec_test').update(body).digest('hex');
  const good = await anon.req('POST', '/api/donate/webhook/wave', undefined, { headers: { 'x-signature': sig }, form: { body, contentType: 'application/json' } });
  assert.equal(good.status, 200); assert.equal(q.get("SELECT status FROM donations WHERE provider_ref='ref-1'").status, 'confirmed');
  delete process.env.WAVE_WEBHOOK_SECRET; delete process.env.WAVE_API_KEY;
});

test('catalog management from the UI: add exam, subject, paper type, deactivate; no code change', async () => {
  const ex = await admin.post('/api/admin/exams', { code: 'NEWEXAM', name: 'New Exam', grade: 'Grade 10' }); assert.equal(ex.status, 201);
  const sb = await admin.post('/api/admin/subjects', { exam_id: ex.json.id, name: 'Test Subject' }); assert.equal(sb.status, 201);
  assert.equal((await admin.post('/api/admin/subjects', { exam_id: ex.json.id, name: 'test subject' })).status, 400, 'duplicate (case-insensitive)');
  assert.equal((await admin.post('/api/admin/paper-types', { name: 'Paper 3' })).status, 201);
  assert.equal((await admin.put(`/api/admin/subjects/${sb.json.id}`, { active: false })).status, 200);
  const lib = (await s1.get('/api/library/exams')).json.exams.find((e) => e.code === 'NEWEXAM');
  assert.equal(lib.subjects.length, 0, 'deactivated subjects are hidden from students');
  assert.equal((await s1.post('/api/admin/exams', { code: 'X', name: 'X' })).status, 403);
});
