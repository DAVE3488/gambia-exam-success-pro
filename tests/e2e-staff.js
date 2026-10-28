'use strict';
/* Browser check of staff flows. Run: NODE_PATH=$(npm root -g) node tests/e2e-staff.js */
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ges-e2es-'));
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ges-shots2-'));
const PORT = 3298; const BASE = `http://127.0.0.1:${PORT}`; const CHIEF_PW = 'ChiefPassw0rd'; const root = path.resolve(__dirname, '..');
let failures = 0; const check = (c, m) => { if (!c) { failures++; console.log('  FAIL: ' + m); } else console.log('  ok:   ' + m); };
async function api(ctx, method, url, body, form) { const r = await ctx.request.fetch(BASE + url, { method, data: body, multipart: form, headers: form ? {} : { 'content-type': 'application/json' } }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; }
const dialogOk = async (p, name) => { await p.locator('.dialog, dialog, [role=dialog]').getByRole('button', { name }).last().click(); };
(async () => {
  execFileSync('node', ['scripts/provision-chief.js'], { cwd: root, env: { ...process.env, DATA_DIR: DATA, CHIEF_PASSWORD: CHIEF_PW }, stdio: 'ignore' });
  const srv = spawn('node', ['server/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning|trace-warnings/.test(s)) console.log('[server]', s.trim()); });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const browser = await chromium.launch(); const errors = [];
  const mk = async (label, vp) => { const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 860 } }); const page = await ctx.newPage(); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); }); page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`)); return { ctx, page }; };
  try {
    const chief = await mk('chief'); await api(chief.ctx, 'POST', '/api/auth/login', { identifier: 'jprothereal@gmail.com', password: CHIEF_PW });
    const cat = (await api(chief.ctx, 'GET', '/api/content/catalog')).json;
    const wassce = cat.exams.find((e) => e.code === 'WASSCE'); const subj = (n) => cat.subjects.find((s) => s.exam_id === wassce.id && s.name === n);
    const math = subj('Mathematics'), phys = subj('Physics');

    // teacher + supervisor register and apply (API), chief approves in the browser
    const T = await mk('teacher'); const S = await mk('supervisor');
    for (const [u, name, email] of [[T, 'Test Teacher', 'teacher@example.com'], [S, 'Test Supervisor', 'sup@example.com']]) {
      const r = await api(u.ctx, 'POST', '/api/auth/register', { full_name: name, school: 'Test School', email, password: 'Passw0rd-long' }); check(r.status === 201, `${name} registered`);
    }
    let r = await api(T.ctx, 'POST', '/api/applications', { kind: 'teacher', subject_ids: [math.id], qualifications: 'BSc Mathematics, 5 years teaching' }); check(r.status === 201, 'teacher application submitted');
    r = await api(S.ctx, 'POST', '/api/applications', { kind: 'supervisor', subject_ids: [math.id], qualifications: 'MSc Mathematics, examiner' }); check(r.status === 400, 'supervisor with one subject is refused');
    r = await api(S.ctx, 'POST', '/api/applications', { kind: 'supervisor', subject_ids: [math.id, phys.id], qualifications: 'MSc Mathematics, examiner' }); check(r.status === 201, 'supervisor application with two subjects accepted');

    const c = chief.page;
    for (const [kind, who] of [['teacher', 'Test Teacher'], ['supervisor', 'Test Supervisor']]) {
      await c.goto(BASE + '/#/admin/applications?kind=' + kind); await c.waitForFunction((w) => document.body.innerText.includes(w), who);
      if (kind === 'supervisor') await c.screenshot({ path: path.join(SHOTS, 's1-applications.png') });
      await c.getByRole('button', { name: 'Approve' }).first().click(); await c.getByRole('button', { name: 'Approve', exact: true }).last().click();
      await c.waitForTimeout(800);
    }
    const me1 = (await api(T.ctx, 'GET', '/api/auth/me')).json, me2 = (await api(S.ctx, 'GET', '/api/auth/me')).json;
    check((me1.user || me1).role === 'teacher', 'teacher approved in the browser'); check((me2.user || me2).role === 'supervisor', 'supervisor approved in the browser');

    // teacher uploads practice material and extracts
    r = await api(T.ctx, 'POST', '/api/content/submissions', undefined, { exam_id: String(wassce.id), subject_id: String(math.id), year: '2020', paper_type_id: String(cat.paper_types[0].id), content_type: 'practice_exercise', origin: 'teacher', title: 'TEST FIXTURE Practice Set', provenance: 'Written by the teacher', files: { name: 'p.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(__dirname, 'fixtures/sample-paper.pdf')) } });
    check(r.status === 201, 'teacher creates submission'); const id = r.json.id;
    const tp = T.page; await tp.goto(BASE + '/#/teacher/content'); await tp.waitForFunction(() => /TEST FIXTURE Practice Set/.test(document.body.innerText)); check(true, 'teacher sees own content list');
    await tp.getByRole('link', { name: /TEST FIXTURE Practice Set/ }).click(); await tp.waitForSelector('h1'); check(!/could not load/i.test(await tp.innerText('main')), 'teacher detail page renders');
    r = await api(T.ctx, 'POST', `/api/content/submissions/${id}/extract`, {}); check(r.status === 200, 'teacher extract works');
    r = await api(T.ctx, 'POST', `/api/content/submissions/${id}/publish`, {}); check([401, 403].includes(r.status), 'teacher cannot publish');

    // chief assigns supervisor in browser
    await c.goto(BASE + '/#/admin/content/' + id); await c.waitForSelector('.qedit');
    check((await c.locator('.qedit label', { hasText: 'Marks' }).count()) >= 1, 'question editor fields are labelled');
    await c.locator('select[aria-label=Supervisor]').selectOption({ label: 'Test Supervisor' }); await c.getByRole('button', { name: /Assign for review/ }).click(); await c.waitForTimeout(700);
    const sd = (await api(chief.ctx, 'GET', `/api/content/submissions/${id}`)).json; check(sd.submission.status === 'in_review' && sd.submission.supervisor_name === 'Test Supervisor', 'assigned to supervisor, status In Review');

    // the supervisor first tries to recommend approval with no answers prepared: must be refused
    r = await api(S.ctx, 'POST', `/api/content/submissions/${id}/review`, { action: 'recommend_approval' }); check(r.status === 400 || r.status === 409 || r.status === 422, 'recommending approval with unanswered questions is refused (' + r.status + ')');
    for (let i = 0; i < sd.questions.length; i++) { const qq = sd.questions[i]; const body = qq.type === 'theory' || !qq.options.length ? { model_answer: 'A prepared model answer.' } : { explanation: 'Explained.', options: qq.options.map((o, k) => ({ label: o.label, text: o.text, is_correct: k === 0 })) }; const rr = await api(S.ctx, 'PUT', `/api/content/questions/${qq.id}`, body); if (rr.status !== 200) console.log('  note: PUT q', qq.id, rr.status, JSON.stringify(rr.json)); }
    // supervisor reviews in browser
    const sp = S.page; await sp.goto(BASE + '/#/staff/review/' + id); await sp.waitForSelector('.qedit');
    await sp.screenshot({ path: path.join(SHOTS, 's2-supervisor-review.png') });
    check((await sp.getByRole('button', { name: 'Publish to students' }).count()) === 0, 'supervisor has no publish button');
    r = await api(S.ctx, 'POST', `/api/content/submissions/${id}/publish`, {}); check([401, 403].includes(r.status), 'supervisor cannot publish (server)');
    await sp.getByRole('button', { name: 'Recommend approval' }).click(); await sp.waitForTimeout(300); await sp.screenshot({ path: path.join(SHOTS, 's2b-review-dialog.png') }); await sp.getByRole('button', { name: 'Recommend approval', exact: true }).last().click(); await sp.waitForTimeout(900);
    const sd2 = (await api(chief.ctx, 'GET', `/api/content/submissions/${id}`)).json; check(sd2.submission.review_status && sd2.submission.review_status !== 'pending', 'supervisor review recorded: ' + sd2.submission.review_status);
    r = await api(S.ctx, 'GET', '/api/admin/users'); check([401, 403].includes(r.status), 'supervisor cannot reach admin API');

    // classes UI renders for teacher
    await tp.goto(BASE + '/#/classes'); await tp.waitForSelector('h1'); check(!/could not load/i.test(await tp.innerText('main')), 'classes page renders for teacher');
    await tp.screenshot({ path: path.join(SHOTS, 's3-classes.png') });
  } finally { await browser.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
  const real = errors.filter((e) => !/favicon|sw\.js|40[0-9] \(|status of 40/.test(e)); check(real.length === 0, `no unexpected console errors${real.length ? ': ' + real.slice(0, 5).join(' | ') : ''}`);
  console.log(`\nShots: ${SHOTS}\n${failures ? failures + ' FAILED' : 'ALL STAFF E2E CHECKS PASSED'}`); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed', e); process.exit(2); });
