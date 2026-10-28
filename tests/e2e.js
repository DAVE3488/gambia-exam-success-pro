'use strict';
/* Browser end-to-end check. Run:  NODE_PATH=$(npm root -g) node tests/e2e.js  (needs Playwright + Chromium) */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ges-shots-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ges-e2e-'));
const PORT = 3299; const BASE = `http://127.0.0.1:${PORT}`;
const CHIEF_PW = 'ChiefPassw0rd';
const root = path.resolve(__dirname, '..');
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL: ' + msg); } else console.log('  ok:   ' + msg); };

async function api(ctx, method, url, body, form) {
  const r = await ctx.request.fetch(BASE + url, { method, data: body, multipart: form, headers: form ? {} : { 'content-type': 'application/json' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status(), json: j };
}

(async () => {
  require('child_process').execFileSync('node', ['scripts/provision-chief.js'], { cwd: root, env: { ...process.env, DATA_DIR: DATA, CHIEF_PASSWORD: CHIEF_PW }, stdio: 'ignore' });
  const srv = spawn('node', ['server/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning|trace-warnings/.test(s)) console.log('[server]', s.trim()); });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/auth/me'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, label) => { page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); }); page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`)); };

  try {
    // ---------------- seed: chief uploads, extracts, answers, approves, publishes (via API)
    const adminCtx = await browser.newContext(); const admin = adminCtx;
    let r = await api(admin, 'POST', '/api/auth/login', { identifier: 'jprothereal@gmail.com', password: CHIEF_PW }); check(r.status === 200, 'chief can log in');
    const cat = (await api(admin, 'GET', '/api/content/catalog')).json;
    const wassce = cat.exams.find((e) => e.code === 'WASSCE'); const math = cat.subjects.find((s) => s.exam_id === wassce.id && s.name === 'Mathematics');
    r = await api(admin, 'POST', '/api/content/submissions', undefined, { exam_id: String(wassce.id), subject_id: String(math.id), year: '2019', paper_type_id: String(cat.paper_types[0].id), content_type: 'past_paper', origin: 'official', title: 'TEST FIXTURE Mathematics 2019 Paper 1', provenance: 'Fictional test fixture', files: { name: 'paper.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(__dirname, 'fixtures/sample-paper.pdf')) } });
    check(r.status === 201, 'PDF uploaded as draft'); const pid = r.json.id;
    r = await api(admin, 'POST', `/api/content/submissions/${pid}/extract`, {}); check(r.json.created === 5, 'five questions extracted');
    const det = (await api(admin, 'GET', `/api/content/submissions/${pid}`)).json;
    const letters = ['B', 'C', 'B'];
    for (let i = 0; i < 3; i++) { const q = det.questions[i]; await api(admin, 'PUT', `/api/content/questions/${q.id}`, { topic: i === 1 ? 'Number theory' : 'Arithmetic', explanation: `The answer is ${letters[i]}.`, options: q.options.map((o) => ({ label: o.label, text: o.text, is_correct: o.label === letters[i], why: o.label === letters[i] ? '' : `${o.text} is not the answer.` })) }); }
    await api(admin, 'PUT', `/api/content/questions/${det.questions[3].id}`, { model_answer: 'A prime number has exactly two distinct positive factors: 1 and itself.', marking_guide: '1 mark for the definition, 2 for examples.' });
    await api(admin, 'PUT', `/api/content/questions/${det.questions[4].id}`, { model_answer: 'The number 1 has only one positive factor.' });
    r = await api(admin, 'POST', `/api/content/submissions/${pid}/decide`, { decision: 'approve' }); check(r.status === 200, 'approved');
    r = await api(admin, 'POST', `/api/content/submissions/${pid}/publish`, {}); check(r.status === 200, 'published');

    // ---------------- mobile student journey
    const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await mctx.newPage(); watch(m, 'mobile');
    await m.goto(BASE + '/'); await m.waitForSelector('.welcome');
    await m.screenshot({ path: path.join(SHOTS, '01-welcome-mobile.png') });
    const wtext = await m.innerText('.welcome');
    check(/Learn today\. Succeed tomorrow\./.test(wtext) && /A brighter future for Gambian students/.test(wtext) && /~j pro/.test(wtext), 'welcome shows slogan, tagline and ~j pro');
    check(!/Mathematics|Physics|Biology|Chemistry/.test(wtext), 'welcome page lists no subjects');
    check((await m.locator('.welcome a[href="#/staff"]').count()) >= 1, 'STAFF entry point present');
    check((await m.locator('.welcome img').count()) === 0, 'no photographs on welcome');
    for (const label of ['Create student account', 'Log in', 'About', 'Contact and support', 'Support us']) check((await m.getByRole('link', { name: label }).count()) >= 1, `welcome link: ${label}`);

    await m.getByRole('link', { name: 'Create student account' }).click();
    await m.fill('input[autocomplete=name]', 'Fatou Jallow'); await m.fill('input[autocomplete=organization]', 'Test Senior School'); await m.fill('input[type=email]', 'fatou@example.com'); await m.fill('input[autocomplete=new-password]', 'Passw0rd123');
    await m.screenshot({ path: path.join(SHOTS, '02-register-mobile.png') });
    await m.getByRole('button', { name: 'Create account' }).click();
    await m.waitForSelector('.hello'); check(/Hello, Fatou/.test(await m.innerText('.hello')), 'registered and landed on student dashboard');
    await m.screenshot({ path: path.join(SHOTS, '03-student-home-mobile.png') });

    await m.getByRole('link', { name: 'Library' }).last().click(); await m.waitForSelector('.exam-tabs');
    await m.getByRole('button', { name: /WASSCE/ }).click(); await m.waitForSelector('.subj');
    check((await m.locator('.subj').count()) === 35, 'WASSCE shows 35 subjects'); await m.getByRole('button', { name: /GABECE/ }).click(); check((await m.locator('.subj').count()) === 17, 'GABECE shows 17 subjects');
    await m.getByRole('button', { name: /WASSCE/ }).click(); await m.screenshot({ path: path.join(SHOTS, '04-library-mobile.png') });
    await m.locator('.subj', { hasText: /^Mathematics/ }).first().click(); await m.waitForSelector('.area');
    const sub = await m.innerText('main'); check(/Past Questions & Answers/.test(sub) && /Track Your Progress/.test(sub) && /Get started →/.test(sub), 'subject page shows the two areas with the requested wording');
    await m.screenshot({ path: path.join(SHOTS, '05-subject-mobile.png') });
    await m.getByText('Past Questions & Answers').click(); await m.waitForSelector('.yearchips');
    check((await m.locator('.yearchips a').allInnerTexts()).join() === '2019', 'only the year with published content is listed');
    await m.locator('a.area').first().click(); await m.waitForSelector('.qcard');
    const head = await m.innerText('.paperhead'); check(/Reviewed by .* · Approved by/.test(head), 'reviewer and approver shown at top of paper');
    check(/Official past examination paper/.test(head), 'official label shown');
    await m.screenshot({ path: path.join(SHOTS, '06-paper-mobile.png') });

    // objective behaviour in the real UI
    const q1 = m.locator('#q' + det.questions[0].id);
    await q1.getByRole('button', { name: /Option A/ }).click(); await q1.locator('.opt.wrong').waitFor();
    check((await q1.locator('.opt.wrong').count()) === 1 && (await q1.locator('.opt.correct').count()) === 0, 'wrong pick turns red, correct answer not revealed yet');
    check(/one more try/i.test(await q1.innerText()), 'tells the student they have another try');
    await q1.getByRole('button', { name: /Option C/ }).click(); await q1.locator('.opt.correct').waitFor();
    check((await q1.locator('.opt.correct').innerText()).includes('4') && (await q1.locator('.opt.wrong').count()) === 2, 'after 2nd miss: correct shown green, both misses red');
    check(/The correct answer is B/.test(await q1.innerText()) && /Why your choice was wrong/.test(await q1.innerText()), 'reveals answer and explains the mistakes');
    check((await q1.locator('.opt:not([disabled])').count()) === 0, 'question resolved: options locked');
    const q2 = m.locator('#q' + det.questions[1].id); await q2.getByRole('button', { name: /Option C/ }).click(); await q2.locator('.opt.correct').waitFor();
    check(/Correct\./.test(await q2.innerText()), 'first-try correct shows green with explanation');
    check((await m.locator('#q' + det.questions[3].id + ' .model').innerText()).includes('exactly two distinct'), 'theory model answer visible directly under the question');
    await m.screenshot({ path: path.join(SHOTS, '07-paper-answered-mobile.png') });

    // page mode persists across reload
    await m.getByRole('button', { name: /^Page:/ }).click(); await m.waitForSelector('.pager:not([hidden])');
    check((await m.locator('.qcard').count()) === 1, 'page mode shows one question at a time');
    await m.reload(); await m.waitForSelector('.qcard'); check((await m.locator('.qcard').count()) === 1 && /Page: On/.test(await m.innerText('.paperhead')), 'page mode preference restored after reload');
    await m.getByRole('button', { name: /^Scroll:/ }).click(); await m.waitForFunction(() => document.querySelectorAll('.qcard').length > 1);
    check(true, 'scroll mode switches back');
    // finish → summary
    await m.getByRole('button', { name: 'Finish and see score' }).click(); await m.getByRole('button', { name: 'Finish and see score' }).last().click();
    await m.waitForSelector('.scorering'); const sum = await m.innerText('main');
    check(/1\.5 out of 3/.test(sum) || /out of 3 points/.test(sum), 'summary shows score'); await m.screenshot({ path: path.join(SHOTS, '08-summary-mobile.png') });
    await m.goto(BASE + '/#/progress'); await m.waitForSelector('.road'); await m.screenshot({ path: path.join(SHOTS, '09-progress-mobile.png') });
    check(/Questions answered/.test(await m.innerText('main')), 'progress dashboard renders');

    // student cannot reach staff pages
    await m.goto(BASE + '/#/admin'); await m.waitForTimeout(500); check(!/Administration/.test(await m.innerText('body')), 'student redirected away from admin dashboard');

    // ---------------- desktop admin journey
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const d = await dctx.newPage(); watch(d, 'desktop');
    await d.goto(BASE + '/#/login'); await d.fill('input[autocomplete=username]', 'jprothereal@gmail.com'); await d.fill('input[autocomplete=current-password]', CHIEF_PW); await d.getByRole('button', { name: 'Log in' }).click();
    await d.waitForSelector('.sidenav'); check(/Administration/.test(await d.innerText('main')), 'chief sees administration dashboard');
    await d.screenshot({ path: path.join(SHOTS, '10-admin-overview.png') });
    await d.goto(BASE + '/#/admin/content'); await d.waitForFunction(() => /^Content/.test(document.querySelector('h1')?.innerText || '') && !!document.querySelector('table')); check(/TEST FIXTURE/.test(await d.innerText('table')), 'content list shows the paper');
    await d.getByRole('link', { name: /TEST FIXTURE/ }).click(); await d.waitForSelector('.qedit');
    check((await d.locator('iframe.pdfframe').count()) === 1, 'original PDF previewed beside the questions');
    check((await d.locator('.qedit').count()) === 5, 'five editable questions');
    await d.screenshot({ path: path.join(SHOTS, '11-admin-content-detail.png'), fullPage: false });
    for (const p of ['upload', 'applications', 'users', 'supervisors', 'catalog', 'inbox', 'audit', 'settings']) { await d.goto(BASE + '/#/admin/' + p); await d.waitForSelector('h1'); await d.waitForTimeout(250); check(!/could not load/i.test(await d.innerText('main')), `admin page renders: ${p}`); }
    await d.screenshot({ path: path.join(SHOTS, '12-admin-settings.png') });
    await d.goto(BASE + '/#/admin/catalog'); await d.waitForFunction(() => /Subjects and papers/.test(document.querySelector('h1')?.innerText || '') && document.querySelectorAll('tbody tr').length > 10); check((await d.locator('tbody tr').count()) >= 52, 'catalog lists all 52 subjects for management');
    await d.goto(BASE + '/#/admin/audit'); await d.waitForFunction(() => /Audit log/.test(document.querySelector('h1')?.innerText || '') && !!document.querySelector('table')); { const t = await d.innerText('table'); if (!/published/.test(t)) console.log(t.slice(0, 700)); check(/published/.test(t), 'audit log shows the publication'); }
  } finally {
    await browser.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  }
  const real = errors.filter((e) => !/favicon|sw\.js/.test(e));
  check(real.length === 0, `no browser console errors${real.length ? ': ' + real.slice(0, 5).join(' | ') : ''}`);
  console.log(`\nScreenshots: ${SHOTS}\n${failures ? failures + ' FAILED' : 'ALL E2E CHECKS PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
