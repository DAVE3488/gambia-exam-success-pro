'use strict';
(function (G) {
  const { el, toast, field, submitting, pill } = G;
  const NS = 'http://www.w3.org/2000/svg';
  const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  G.savePrefs = async (patch) => {
    G.prefs = { ...G.prefs, ...patch };
    try { await G.put('/api/prefs', G.prefs); } catch (e) { toast('Could not save your preference: ' + e.message, 'bad'); }
  };

  const SOURCE_WARN = new Set(['teacher_prepared', 'ai_draft']);

  // ---------------------------------------------------------------- road to success (river)
  function roadSvg(markers, answered) {
    const W = 600, H = 120; const n = markers.length;
    const pts = markers.map((m, i) => [30 + (W - 60) * (i / (n - 1)), 62 + (i % 2 ? -30 : 30)]);
    let d = `M0 62 C ${pts[0][0] / 2} 62, ${pts[0][0] / 2} ${pts[0][1]}, ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < n; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const mx = (x0 + x1) / 2; d += ` C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`; }
    d += ` S ${W} 62, ${W} 62`;
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', `0 0 ${W} ${H}`); s.setAttribute('role', 'img');
    s.setAttribute('aria-label', `Road to Success: ${answered} questions answered`);
    const mk = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt) e.textContent = txt; s.appendChild(e); return e; };
    mk('path', { d, fill: 'none', stroke: '#13315C', 'stroke-width': 16, 'stroke-linecap': 'round', opacity: '.14' });
    mk('path', { d, fill: 'none', stroke: '#13315C', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-dasharray': '1 8' });
    markers.forEach((m, i) => {
      const [x, y] = pts[i];
      mk('circle', { cx: x, cy: y, r: 13, fill: m.reached ? '#D9A21B' : '#fff', stroke: m.reached ? '#9A6F00' : '#13315C', 'stroke-width': 2 });
      mk('text', { x, y: y + 4, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#0B2545', 'font-family': 'system-ui' }, m.reached ? '✓' : '');
      mk('text', { x, y: y + (i % 2 ? -20 : 32), 'text-anchor': 'middle', 'font-size': 11, fill: '#56657A', 'font-family': 'system-ui' }, String(m.target));
    });
    return s;
  }

  // ---------------------------------------------------------------- shared: objective question card
  function objectiveCard(q, st, sid, hooks = {}) {
    const card = el('article', { class: 'qcard', id: 'q' + q.id, 'aria-label': `Question ${q.number || q.position}` });
    let busy = false; let last = null; // last = {correct, text}
    const label = (id) => (q.options.find((o) => o.id === id) || {}).label;
    function feedback() {
      if (st.resolved && st.correct) return el('div', { class: 'feedback ok', role: 'status' }, el('b', { text: 'Correct. ' }), st.explanation || '', el('div', { class: 'hint', text: st.attempts_used === 1 ? 'First try: 1 point.' : 'Second try: half a point.' }));
      if (st.resolved) {
        const wrongNotes = (st.tried || []).map((id) => ({ l: label(id), why: (st.option_notes || {})[id] })).filter((x) => x.why);
        return el('div', { class: 'feedback bad', role: 'status' }, el('b', { text: `The correct answer is ${label(st.correct_option_id)}. ` }), st.explanation || '',
          wrongNotes.length ? el('div', { style: 'margin-top:8px' }, el('b', { text: 'Why your choice was wrong' }), el('ul', { style: 'margin:4px 0 0;padding-left:18px' }, wrongNotes.map((x) => el('li', { text: `${x.l}: ${x.why}` })))) : null,
          el('div', { class: 'hint', text: 'No points for this question. You can retry it from your mistakes list.' }));
      }
      if (last && !last.correct) return el('div', { class: 'feedback bad', role: 'status' }, el('b', { text: 'Not quite. ' }), last.text || '', ' You have one more try. Choose a different option.');
      if ((st.tried || []).length) return el('div', { class: 'feedback info', text: 'You have one more try. Choose a different option.' });
      return null;
    }
    async function pick(o) {
      if (busy || st.resolved) return; busy = true; draw();
      try {
        const r = await G.post(`/api/quiz/${sid}/answer`, { question_id: q.id, option_id: o.id, client_uid: uid() });
        (st.tried = st.tried || []).includes(o.id) || st.tried.push(o.id);
        Object.assign(st, { attempts_used: r.attempts_used, resolved: r.resolved, correct: r.resolved ? r.correct : false, points: r.points });
        if (r.resolved) Object.assign(st, { correct_option_id: r.correct_option_id, explanation: r.explanation, option_notes: r.option_notes });
        last = { correct: r.correct, text: r.selected_feedback };
        hooks.onProgress && hooks.onProgress(r.progress, q, st);
      } catch (e) { toast(e.offline ? 'Quizzes need an internet connection.' : e.message, 'bad'); if (/time is up/i.test(e.message)) hooks.onExpired && hooks.onExpired(); }
      busy = false; draw();
      if (st.resolved && hooks.onResolved) hooks.onResolved(q, st);
    }
    function draw() {
      G.clear(card);
      card.append(
        el('div', { class: 'qn' }, `Question ${q.number || q.position}`, q.topic && el('span', { class: 'srclabel', text: q.topic }), SOURCE_WARN.has(q.answer_source) && el('span', { class: 'srclabel warn', text: q.answer_label })),
        el('div', { class: 'qtext', text: q.text }),
        q.diagrams.map((fid) => el('img', { class: 'qimg', src: `/api/files/${fid}`, alt: 'Diagram for this question', loading: 'lazy' })),
        el('div', { role: 'group', 'aria-label': 'Answer options' }, q.options.map((o) => {
          const isCorrect = st.resolved && o.id === st.correct_option_id;
          const isWrong = (st.tried || []).includes(o.id) && !isCorrect;
          return el('button', { type: 'button', class: 'opt' + (isCorrect ? ' correct' : isWrong ? ' wrong' : ''), disabled: busy || st.resolved || isWrong, 'aria-label': `Option ${o.label}: ${o.text}${isCorrect ? ' (correct)' : isWrong ? ' (incorrect)' : ''}`, on: { click: () => pick(o) } },
            el('span', { class: 'lt', text: o.label }), el('span', { text: o.text }));
        })), feedback(),
        el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn ghost sm', type: 'button', on: { click: () => reportQuestion(q) }, text: 'Report an error' })));
    }
    draw();
    return card;
  }
  async function reportQuestion(q) {
    const msg = await G.promptBox('Report an error', 'What looks wrong with this question or its answer?', { okLabel: 'Send report' });
    if (!msg) return;
    try { await G.post('/api/report', { type: 'error_report', question_id: q.id, message: msg }); toast('Thank you. Staff will check it.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  }

  function theoryCard(q, note) {
    const card = el('article', { class: 'qcard', id: 'q' + q.id, 'aria-label': `Question ${q.number || q.position}` });
    const ta = el('textarea', { placeholder: 'Optional: write your own answer here first. The model answer is shown below.', 'aria-label': 'Your own answer', value: note || '' });
    ta.addEventListener('blur', async () => { try { await G.put(`/api/library/questions/${q.id}/note`, { text: ta.value }); } catch (e) { if (!e.offline) toast(e.message, 'bad'); } });
    const sec = (t, v) => v ? el('section', null, el('h5', { text: t }), el('div', { text: v })) : null;
    card.append(
      el('div', { class: 'qn' }, `Question ${q.number || q.position}`, q.marks ? el('span', { class: 'srclabel', text: `${q.marks} marks` }) : null, q.topic && el('span', { class: 'srclabel', text: q.topic }), SOURCE_WARN.has(q.answer_source) && el('span', { class: 'srclabel warn', text: q.answer_label })),
      el('div', { class: 'qtext', text: q.text }), q.diagrams.map((fid) => el('img', { class: 'qimg', src: `/api/files/${fid}`, alt: 'Diagram for this question', loading: 'lazy' })),
      ta,
      el('div', { class: 'model' }, el('h4', { text: 'Model answer' }), q.model_answer ? el('div', { text: q.model_answer }) : el('div', { class: 'muted', text: 'No model answer is available yet.' }),
        el('div', { class: 'srclabel', style: 'margin:8px 0 0', text: q.answer_label }),
        sec('Marking guide', q.marking_guide), sec('Explanation', q.explanation), sec('Common mistakes', q.common_mistakes)),
      el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn ghost sm', type: 'button', on: { click: () => reportQuestion(q) }, text: 'Report an error' })));
    return card;
  }

  // ---------------------------------------------------------------- library
  G.views.library = async ({ query }) => {
    const { exams } = await G.get('/api/library/exams');
    let cur = query.exam || (exams[0] && exams[0].code);
    const body = el('div'); const search = el('input', { type: 'search', placeholder: 'Search subjects', 'aria-label': 'Search subjects' });
    const list = el('div', { class: 'grid g3' });
    const tabs = el('div', { class: 'exam-tabs', role: 'group', 'aria-label': 'Examination' });
    const draw = () => {
      G.clear(tabs).append(exams.map((e) => el('button', { 'aria-pressed': e.code === cur, on: { click: () => { cur = e.code; draw(); } } }, e.name, el('small', { text: e.grade }))));
      const e = exams.find((x) => x.code === cur); const q = search.value.trim().toLowerCase();
      const subs = (e ? e.subjects : []).filter((s) => !q || s.name.toLowerCase().includes(q));
      G.clear(list).append(subs.length ? subs.map((s) => el('a', { class: 'subj', href: `#/subject/${s.id}` }, el('b', { text: s.name }),
        el('small', { text: s.papers || s.materials ? `${s.papers} paper${s.papers === 1 ? '' : 's'} · ${s.materials} resource${s.materials === 1 ? '' : 's'}` : 'Content coming soon' }))) : G.empty('No subjects match', 'Try a different search.'));
    };
    search.addEventListener('input', draw); draw();
    const saved = G.offlineList();
    body.append(el('h1', { text: 'Library' }), tabs, el('div', { style: 'margin-bottom:12px' }, search), list,
      saved.length ? el('div', { class: 'card', style: 'margin-top:16px' }, el('h3', { text: 'Saved on this device' }), saved.map((p) => el('p', { style: 'margin:4px 0' }, el('a', { href: `#/paper/${p.id}`, text: `${p.subject} ${p.year} — ${p.title}` })))) : null);
    return { body };
  };

  G.views.subject = async ({ id, query }) => {
    const d = await G.get(`/api/library/subjects/${id}`);
    const body = el('div');
    const view = query.view || '';
    if (view === 'papers') {
      body.append(el('p', null, el('a', { href: `#/subject/${id}`, text: '‹ ' + d.subject.name })), el('h1', { text: 'Past questions and answers' }),
        d.years.length ? null : G.empty('Nothing published yet', 'Verified papers for this subject will appear here once they have been reviewed and approved.'),
        d.years.length ? el('div', { class: 'yearchips', style: 'margin-bottom:16px' }, d.years.map((y) => el('a', { href: `#year-${y.year}`, text: String(y.year) }))) : null,
        d.years.map((y) => el('section', { class: 'card', id: `year-${y.year}` }, el('h2', { text: String(y.year) }),
          y.papers.map((p) => el('a', { class: 'area', href: `#/paper/${p.id}` }, el('div', { class: 'row spread' }, el('h3', { text: `${p.paper_type || 'Paper'} — ${p.title}` }), el('span', { class: 'pill ' + (p.origin === 'official' ? 'official' : 'practice'), text: p.origin === 'official' ? 'Official' : 'Practice' })),
            el('p', { text: `${p.objective_count} objective · ${p.theory_count} theory` }), el('div', { class: 'provenance', text: p.origin_label }))))),
        d.quiz_pool >= 3 ? el('div', { class: 'card' }, el('h3', { text: 'Quick practice' }), el('p', { class: 'muted', text: `${d.quiz_pool} verified objective questions in this subject.` }),
          el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Random 10', on: { click: () => startQuiz({ kind: 'random', subject_id: Number(id), count: Math.min(10, d.quiz_pool) }) } }),
            d.topics.length ? G.select([{ value: '', label: 'Practise a topic…' }, ...d.topics.map((t) => ({ value: t, label: t }))], '', { 'aria-label': 'Choose a topic', on: { change: (e) => e.target.value && startQuiz({ kind: 'topic', subject_id: Number(id), topic: e.target.value, count: 10 }) } }) : null)) : null,
        d.materials.length ? el('div', { class: 'card' }, el('h3', { text: 'Learning materials' }), d.materials.map((m) => el('p', { style: 'margin:6px 0' }, el('a', { href: `#/material/${m.id}`, text: m.title }), el('span', { class: 'srclabel', text: m.content_type.replace(/_/g, ' ') })))) : null);
    } else {
      body.append(el('p', null, el('a', { href: '#/library', text: '‹ Library' })), el('h1', { text: d.subject.name }), el('p', { class: 'muted', text: d.subject.exam_name }),
        el('a', { class: 'area', href: `#/subject/${id}?view=papers` }, el('h3', { text: 'Past Questions & Answers' }), el('p', { text: 'Practise with years of real exam papers and model answers.' }), el('span', { class: 'go', text: 'Get started →' })),
        el('a', { class: 'area', href: `#/progress?subject=${id}` }, el('h3', { text: 'Track Your Progress' }), el('p', { text: 'See your scores improve over time and focus your weak spots.' }), el('span', { class: 'go', text: 'Get started →' })),
        d.materials.length ? el('div', { class: 'card' }, el('h3', { text: 'Learning materials' }), d.materials.map((m) => el('p', { style: 'margin:6px 0' }, el('a', { href: `#/material/${m.id}`, text: m.title }), el('span', { class: 'srclabel', text: m.content_type.replace(/_/g, ' ') })))) : null);
    }
    return { body };
  };

  async function startQuiz(opts) {
    try { const r = await G.post('/api/quiz/start', opts); location.hash = `#/quiz/${r.session.id}`; }
    catch (e) { toast(e.message, 'bad'); }
  }

  G.views.material = async ({ id }) => {
    const d = await G.get(`/api/library/materials/${id}`); const m = d.material;
    return { body: el('div', null, el('p', null, el('a', { href: 'javascript:history.back()', text: '‹ Back' })),
      el('h1', { text: m.title }), el('p', { class: 'muted', text: `${m.exam_code} · ${m.subject_name}${m.topic ? ' · ' + m.topic : ''}${m.year ? ' · ' + m.year : ''}` }),
      el('div', { class: 'row' }, el('span', { class: 'pill ' + (m.origin === 'official' ? 'official' : 'practice'), text: m.origin_label })),
      m.reviewer_name || m.approver_name ? el('p', { class: 'provenance', style: 'margin-top:8px', text: `Reviewed by ${m.reviewer_name || '—'} · Approved by ${m.approver_name || '—'}` }) : null,
      m.body ? el('div', { class: 'card', style: 'white-space:pre-wrap;margin-top:12px', text: m.body }) : null,
      d.files.length ? el('div', { class: 'card' }, el('h3', { text: 'Files' }), d.files.map((f) => el('p', { style: 'margin:6px 0' }, el('a', { href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener', text: f.orig_name }), ' ', el('a', { href: `/api/files/${f.id}?download=1`, text: 'Download' })))) : null) };
  };

  // ---------------------------------------------------------------- paper (scroll mode / page mode)
  G.views.paper = async ({ id }) => {
    let data; let offline = false;
    try { data = await G.get(`/api/library/papers/${id}`); }
    catch (e) { if (e.offline) { data = G.offlineLoad(id); offline = !!data; if (!data) throw e; } else throw e; }
    let sess = null;
    if (!offline) { try { sess = await G.post('/api/quiz/start', { kind: 'paper', submission_id: Number(id) }); } catch (e) { if (!/no verified objective/i.test(e.message)) toast(e.message, 'bad'); } }
    return renderPaper(data, sess, offline);
  };

  function renderPaper(data, sess, offline) {
    const p = data.paper; const qs = data.questions;
    const states = {}; if (sess) for (const sq of sess.questions) states[sq.id] = { tried: sq.tried_option_ids, attempts_used: sq.result.attempts_used, resolved: sq.result.resolved, correct: sq.result.correct, points: sq.result.points, correct_option_id: sq.correct_option_id, explanation: sq.explanation, option_notes: sq.option_notes };
    let idx = 0; const list = el('div'); const nav = el('div', { class: 'qnav', role: 'group', 'aria-label': 'Question navigator' });
    const prog = el('span', { class: 'muted' }); let timerEl = null; let timerHandle = null;
    const cards = qs.map((q) => {
      if (q.type === 'theory') return theoryCard(q, data.notes && data.notes[q.id]);
      const st = states[q.id];
      if (!sess || !st) return el('article', { class: 'qcard' }, el('div', { class: 'qn', text: `Question ${q.number || q.position}` }), el('div', { class: 'qtext', text: q.text }),
        q.options.map((o) => el('div', { class: 'opt', 'aria-disabled': 'true' }, el('span', { class: 'lt', text: o.label }), el('span', { text: o.text }))),
        el('div', { class: 'feedback info', text: offline ? 'Quizzes need an internet connection. Reconnect to answer this question.' : 'Answers for this question are not available yet.' }));
      return objectiveCard(q, st, sess.session.id, { onProgress: (pg) => { setProgress(pg); drawNav(); }, onResolved: drawNav, onExpired: () => finish(true) });
    });
    const total = sess ? sess.questions.length : 0;
    function setProgress(pg) { prog.textContent = pg ? `${pg.answered} of ${pg.total} answered · score ${pg.score}` : ''; }
    setProgress(sess && sess.progress);
    function drawNav() {
      G.clear(nav).append(qs.map((q, i) => { const st = states[q.id]; const cls = st ? (st.resolved ? (st.correct ? 'done' : 'miss') : '') : ''; return el('button', { type: 'button', class: cls + (G.prefs.page_mode && i === idx ? ' cur' : ''), 'aria-label': `Go to question ${q.number || i + 1}`, on: { click: () => { idx = i; draw(); if (!G.prefs.page_mode) cards[i].scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, text: String(q.number || i + 1) }); }));
    }
    const pager = el('div', { class: 'pager' });
    function draw() {
      G.clear(list);
      if (G.prefs.page_mode) {
        list.append(cards[idx]);
        G.clear(pager).append(el('button', { class: 'btn ghost sm', disabled: idx === 0, on: { click: () => { idx--; draw(); window.scrollTo(0, 0); } }, text: 'Previous' }), el('span', { class: 'grow muted', style: 'text-align:center', text: `Question ${idx + 1} of ${qs.length}` }),
          el('button', { class: 'btn ghost sm', disabled: idx >= qs.length - 1, on: { click: () => { idx++; draw(); window.scrollTo(0, 0); } }, text: 'Next' }));
        pager.hidden = false;
      } else { list.append(cards); pager.hidden = true; }
      drawNav();
    }
    const modeBtns = el('div', { class: 'row' });
    function drawMode() {
      const tgl = (label, on, fn) => el('button', { class: 'btn sm ' + (on ? '' : 'ghost'), 'aria-pressed': on, on: { click: fn }, text: `${label}: ${on ? 'On' : 'Off'}` });
      G.clear(modeBtns).append(
        tgl('Scroll', !!G.prefs.scroll_mode, async () => { await G.savePrefs({ scroll_mode: 1, page_mode: 0 }); drawMode(); draw(); }),
        tgl('Page', !!G.prefs.page_mode, async () => { await G.savePrefs({ scroll_mode: 0, page_mode: 1 }); drawMode(); draw(); }),
        el('button', { class: 'btn sm ghost', 'aria-label': 'Smaller text', on: { click: async () => { await G.savePrefs({ font_scale: Math.max(0.85, +(G.prefs.font_scale - 0.1).toFixed(2)) }); G.applyFont(); } }, text: 'A−' }),
        el('button', { class: 'btn sm ghost', 'aria-label': 'Larger text', on: { click: async () => { await G.savePrefs({ font_scale: Math.min(1.8, +(G.prefs.font_scale + 0.1).toFixed(2)) }); G.applyFont(); } }, text: 'A+' }));
    }
    async function finish(auto) {
      if (!sess) return;
      if (!auto && !(await G.confirmBox('Finish this paper?', 'Unanswered questions will score zero. You can retry the questions you missed afterwards.', 'Finish and see score'))) return;
      try { await G.post(`/api/quiz/${sess.session.id}/finish`); location.hash = `#/quiz/${sess.session.id}/summary`; } catch (e) { toast(e.message, 'bad'); }
    }
    if (sess && sess.session.deadline) {
      timerEl = el('span', { class: 'timer', 'aria-live': 'off' });
      const tick = () => { const left = Math.max(0, Math.round((sess.session.deadline - Date.now()) / 1000)); timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; timerEl.classList.toggle('low', left < 60); if (left <= 0) { clearInterval(timerHandle); finish(true); } };
      tick(); timerHandle = setInterval(tick, 1000); G.cleanup = () => clearInterval(timerHandle);
    }
    const originalFiles = data.files;
    const saveBtn = el('button', { class: 'btn ghost sm', on: { click: () => { const ok = G.offlineSave(p.id, data); toast(ok ? 'Saved on this device. Questions and model answers can be read offline. Quizzes need internet.' : 'Not enough space to save this paper.', ok ? 'ok' : 'bad'); } }, text: 'Save for offline' });
    const timedBtn = sess && !sess.session.deadline ? el('button', { class: 'btn ghost sm', on: { click: async () => { if (await G.confirmBox('Start timed practice?', 'This begins a new timed attempt. When time runs out your answers are submitted automatically.', 'Start timer')) { try { const r = await G.post('/api/quiz/start', { kind: 'paper', submission_id: p.id, timed: true, fresh: true }); G.mount(G.$('#root'), renderPaper(data, r, false), {}); } catch (e) { toast(e.message, 'bad'); } } } }, text: 'Timed practice' }) : null;
    const head = el('div', { class: 'paperhead' },
      el('p', { style: 'margin:0 0 6px' }, el('a', { href: `#/subject/${p.subject_id}?view=papers`, text: '‹ ' + p.subject_name })),
      el('h1', { style: 'margin-bottom:.2em', text: p.title }), el('p', { class: 'muted', style: 'margin-bottom:6px', text: `${p.exam_code} · ${p.subject_name}${p.year ? ' · ' + p.year : ''}${p.paper_type ? ' · ' + p.paper_type : ''}` }),
      el('div', { class: 'row', style: 'margin-bottom:6px' }, el('span', { class: 'pill ' + (p.origin === 'official' ? 'official' : 'practice'), text: p.origin_label })),
      (p.reviewer_name || p.approver_name) ? el('p', { style: 'margin:0 0 4px;font-weight:600;font-size:.92rem', text: `Reviewed by ${p.reviewer_name || '—'} · Approved by ${p.approver_name || '—'}` }) : null,
      el('p', { class: 'provenance', style: 'margin:0 0 10px', text: `Source: ${p.provenance}` }),
      offline ? el('div', { class: 'notice', text: 'You are reading a saved copy. Quizzes need an internet connection.' }) : null,
      el('div', { class: 'row spread' }, modeBtns, timerEl), el('div', { class: 'row', style: 'margin-top:8px' }, saveBtn, timedBtn,
        originalFiles.length ? originalFiles.map((f) => el('a', { class: 'btn ghost sm', href: `/api/files/${f.id}`, target: '_blank', rel: 'noopener', text: f.role === 'answer_key' ? 'View answer key' : 'View original paper' })) : null));
    drawMode(); draw();
    const bottom = sess ? el('div', { class: 'card' }, el('div', { class: 'row spread' }, prog, el('button', { class: 'btn gold', on: { click: () => finish(false) }, text: 'Finish and see score' })), el('details', { style: 'margin-top:10px' }, el('summary', { text: 'Question navigator' }), nav)) : el('div', { class: 'card' }, nav);
    return { body: el('div', null, head, list, pager, bottom) };
  }

  // ---------------------------------------------------------------- quiz runner (topic / random / daily / retry)
  G.views.quiz = async ({ id }) => {
    const sess = await G.get(`/api/quiz/${id}`);
    if (sess.session.finished_at) { location.hash = `#/quiz/${id}/summary`; return { body: el('div') }; }
    const qs = sess.questions; let idx = qs.findIndex((x) => !x.result.resolved); if (idx < 0) idx = 0;
    const states = Object.fromEntries(qs.map((sq) => [sq.id, { tried: sq.tried_option_ids, attempts_used: sq.result.attempts_used, resolved: sq.result.resolved, correct: sq.result.correct, points: sq.result.points, correct_option_id: sq.correct_option_id, explanation: sq.explanation, option_notes: sq.option_notes }]));
    const holder = el('div'); const bar = el('div', { class: 'bar' }, el('i')); const label = el('span', { class: 'muted' });
    const cards = qs.map((q) => objectiveCard(q, states[q.id], id, { onProgress: upd, onExpired: finish.bind(null, true) }));
    function upd() { const n = qs.filter((q) => states[q.id].resolved).length; bar.firstChild.style.width = `${(n / qs.length) * 100}%`; label.textContent = `${n} of ${qs.length} answered`; }
    const pager = el('div', { class: 'pager' });
    function draw() {
      G.clear(holder).append(cards[idx]);
      G.clear(pager).append(el('button', { class: 'btn ghost sm', disabled: idx === 0, on: { click: () => { idx--; draw(); } }, text: 'Previous' }), el('span', { class: 'grow muted', style: 'text-align:center', text: `Question ${idx + 1} of ${qs.length}` }),
        idx < qs.length - 1 ? el('button', { class: 'btn sm', on: { click: () => { idx++; draw(); } }, text: 'Next' }) : el('button', { class: 'btn gold sm', on: { click: () => finish(false) }, text: 'Finish' }));
      upd();
    }
    async function finish(auto) {
      if (!auto && qs.some((q) => !states[q.id].resolved) && !(await G.confirmBox('Finish now?', 'Some questions are unanswered and will score zero.', 'Finish and see score'))) return;
      try { await G.post(`/api/quiz/${id}/finish`); location.hash = `#/quiz/${id}/summary`; } catch (e) { toast(e.message, 'bad'); }
    }
    let timer = null;
    if (sess.session.deadline) { timer = el('span', { class: 'timer' }); const t = () => { const left = Math.max(0, Math.round((sess.session.deadline - Date.now()) / 1000)); timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; timer.classList.toggle('low', left < 60); if (left <= 0) { clearInterval(h); finish(true); } }; t(); const h = setInterval(t, 1000); G.cleanup = () => clearInterval(h); }
    draw();
    const title = { daily: 'Daily Challenge', topic: 'Topic quiz', random: 'Practice quiz', paper: 'Paper practice' }[sess.session.kind] || 'Quiz';
    return { body: el('div', null, el('h1', { text: title }), el('div', { class: 'row spread', style: 'margin-bottom:8px' }, label, timer), bar, el('div', { style: 'height:12px' }), holder, pager) };
  };

  G.views.quizSummary = async ({ id }) => {
    const s = await G.get(`/api/quiz/${id}/summary`);
    const ring = el('div', { class: 'scorering', style: `--p:${s.percent}%`, role: 'img', 'aria-label': `Score ${s.percent} percent` }, el('b', { text: `${s.percent}%` }));
    const retry = async (only) => { try { const r = await G.post(`/api/quiz/${id}/retry`, { only_missed: only }); location.hash = `#/quiz/${r.session.id}`; } catch (e) { toast(e.message, 'bad'); } };
    return { body: el('div', null, el('h1', { text: 'Your result' }),
      el('div', { class: 'card', style: 'text-align:center' }, ring, el('p', { style: 'margin:0', text: `${s.score} out of ${s.total} points` }),
        el('div', { class: 'row', style: 'justify-content:center;margin-top:10px' }, el('span', { class: 'pill published', text: `${s.first_try} right first try` }), el('span', { class: 'pill approved', text: `${s.second_try} right second try` }), el('span', { class: 'pill rejected', text: `${s.missed} missed` }), s.unanswered ? el('span', { class: 'pill', text: `${s.unanswered} unanswered` }) : null),
        el('p', { class: 'hint', style: 'margin:10px auto 0', text: s.scoring }),
        el('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, el('button', { class: 'btn gold', on: { click: () => retry(true) }, text: 'Retry missed questions' }), el('button', { class: 'btn ghost', on: { click: () => retry(false) }, text: 'Retry everything' }), el('a', { class: 'btn ghost', href: '#/progress', text: 'My progress' }))),
      el('h2', { text: 'Review your answers' }),
      s.questions.map((q) => el('div', { class: 'qcard' }, el('div', { class: 'qn', text: `Question ${q.number || ''}` }), el('div', { class: 'qtext', text: q.text }),
        q.options.map((o) => { const right = o.id === q.correct_option_id; const wrong = q.tried_option_ids.includes(o.id) && !right; return el('div', { class: 'opt' + (right ? ' correct' : wrong ? ' wrong' : ''), 'aria-disabled': 'true' }, el('span', { class: 'lt', text: o.label }), el('span', { text: o.text })); }),
        q.result.resolved ? el('div', { class: 'feedback ' + (q.result.correct ? 'ok' : 'bad') }, q.explanation || (q.result.correct ? 'Correct.' : 'Review the correct answer above.')) : el('div', { class: 'feedback info', text: 'Not answered.' })))) };
  };

  // ---------------------------------------------------------------- progress + mistakes
  G.views.progress = async ({ query }) => {
    const p = await G.get('/api/progress'); const filter = query.subject ? Number(query.subject) : null;
    const subs = filter ? p.by_subject.filter((s) => s.subject_id === filter) : p.by_subject;
    return { body: el('div', null, el('h1', { text: 'My progress' }),
      el('div', { class: 'grid g3' }, stat(p.totals.answered, 'Questions answered'), stat(p.totals.accuracy + '%', 'Accuracy'), stat(p.totals.first_try_rate + '%', 'Right first try'), stat(p.streak_days, 'Day streak')),
      el('div', { class: 'card', style: 'margin-top:14px' }, el('h3', { text: 'Road to Success' }), el('div', { class: 'road' }, roadSvg(p.road.markers, p.road.answered)),
        el('p', { class: 'muted', style: 'margin:0', text: p.road.next ? `${p.road.next - p.road.answered} more questions to reach ${p.road.next}.` : 'You have reached every milestone. Keep going!' })),
      el('div', { class: 'card' }, el('h3', { text: 'Recommended next' }), el('p', { text: p.recommendation.text }), p.recommendation.subject_id ? el('a', { class: 'btn', href: `#/subject/${p.recommendation.subject_id}?view=papers`, text: 'Go to practice' }) : el('a', { class: 'btn', href: '#/library', text: 'Open library' })),
      el('div', { class: 'card' }, el('h3', { text: 'Subjects' }), subs.length ? subs.map((s) => el('div', { style: 'margin-bottom:12px' }, el('div', { class: 'row spread' }, el('b', { text: `${s.subject} (${s.exam})` }), el('span', { class: 'muted', text: `${s.accuracy}% · ${s.answered} answered` })), el('div', { class: 'bar' }, el('i', { style: `width:${s.accuracy}%` })))) : G.empty('No practice yet', 'Answer some questions and your subject scores will appear here.', el('a', { class: 'btn', href: '#/library', text: 'Open library' }))),
      (p.weak_topics.length || p.strong_topics.length) ? el('div', { class: 'grid g2' },
        el('div', { class: 'card' }, el('h3', { text: 'Needs more practice' }), p.weak_topics.length ? p.weak_topics.map((t) => el('p', { style: 'margin:4px 0', text: `${t.topic} — ${t.subject}: ${t.accuracy}%` })) : el('p', { class: 'muted', text: 'Not enough data yet.' })),
        el('div', { class: 'card' }, el('h3', { text: 'Strong topics' }), p.strong_topics.length ? p.strong_topics.map((t) => el('p', { style: 'margin:4px 0', text: `${t.topic} — ${t.subject}: ${t.accuracy}%` })) : el('p', { class: 'muted', text: 'Keep practising to build strengths.' }))) : null,
      el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h3', { style: 'margin:0', text: 'Mistakes to review' }), el('a', { class: 'btn sm', href: '#/mistakes' + (filter ? `?subject=${filter}` : ''), text: `Review ${p.mistakes_to_review}` })),
        el('p', { class: 'muted', style: 'margin:8px 0 0', text: 'Questions you missed or only got right on a second try.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Study history' }), p.recent_sessions.length ? el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Date', 'Subject', 'Paper', 'Score', 'Attempts'].map((h) => el('th', { text: h })))),
        el('tbody', null, p.recent_sessions.map((s) => el('tr', null, el('td', { text: G.fmtDate(new Date(s.started_at).toISOString()) }), el('td', { text: s.subject || '' }), el('td', null, s.finished_at ? el('a', { href: `#/quiz/${s.id}/summary`, text: s.paper_title ? `${s.paper_title}` : s.kind }) : el('a', { href: `#/quiz/${s.id}`, text: (s.paper_title || s.kind) + ' (continue)' })), el('td', { text: s.finished_at ? `${s.score}/${s.total}` : 'In progress' }), el('td', { text: String(s.attempts) })))))) : el('p', { class: 'muted', text: 'Your sessions will be listed here.' }))) };
  };
  const stat = (v, l) => el('div', { class: 'stat' }, el('b', { text: String(v) }), el('span', { text: l }));

  G.views.mistakes = async ({ query }) => {
    const r = await G.get('/api/progress/mistakes' + (query.subject ? `?subject_id=${query.subject}` : ''));
    return { body: el('div', null, el('p', null, el('a', { href: '#/progress', text: '‹ Progress' })), el('h1', { text: 'Mistakes to review' }),
      r.items.length ? r.items.map((x) => el('div', { class: 'qcard' }, el('div', { class: 'qn', text: `${x.subject} · ${x.paper_title}${x.year ? ' ' + x.year : ''}` }), el('div', { class: 'qtext', text: x.text }),
        x.options.map((o) => el('div', { class: 'opt' + (o.is_correct ? ' correct' : x.your_picks.includes(o.id) ? ' wrong' : ''), 'aria-disabled': 'true' }, el('span', { class: 'lt', text: o.label }), el('span', null, o.text, (o.is_correct || x.your_picks.includes(o.id)) && o.why ? el('div', { class: 'hint', text: o.why }) : null))),
        x.explanation ? el('div', { class: 'feedback info', text: x.explanation }) : null, el('a', { class: 'btn ghost sm', href: `#/paper/${x.paper_id}`, text: 'Open the paper' }))) : G.empty('No mistakes to review', 'Questions you miss will show up here with the correct answer and explanation.')) };
  };

  // ---------------------------------------------------------------- home dashboards
  async function studentHome() {
    const [p, lib] = await Promise.all([G.get('/api/progress'), G.get('/api/library/exams')]);
    const daily = p.daily.session;
    return { body: el('div', null,
      el('div', { class: 'hello' }, el('h1', { text: `Hello, ${G.me.full_name.split(' ')[0]}` }), el('p', { text: p.totals.answered ? `${p.totals.answered} questions answered · ${p.totals.accuracy}% accuracy${p.streak_days ? ` · ${p.streak_days}-day streak` : ''}` : 'Pick a subject and answer your first question.' })),
      el('div', { class: 'grid g2' },
        el('div', { class: 'card' }, el('h3', { text: 'Daily Challenge' }), daily && daily.finished_at ? el('p', { text: `Done today: ${daily.score} of ${daily.total}. Come back tomorrow.` }) : el('p', { class: 'muted', text: 'Five questions, the same for everyone today.' }),
          el('button', { class: 'btn gold', on: { click: () => startQuiz({ kind: 'daily' }) }, text: daily && !daily.finished_at ? 'Continue challenge' : daily ? 'Review challenge' : 'Start challenge' })),
        el('div', { class: 'card' }, el('h3', { text: 'Recommended revision' }), el('p', { text: p.recommendation.text }), el('a', { class: 'btn', href: p.recommendation.subject_id ? `#/subject/${p.recommendation.subject_id}?view=papers` : '#/library', text: 'Start revising' }))),
      el('div', { class: 'card' }, el('h3', { text: 'Road to Success' }), el('div', { class: 'road' }, roadSvg(p.road.markers, p.road.answered)), el('p', { class: 'muted', style: 'margin:0', text: p.road.next ? `${p.road.next - p.road.answered} more questions to the next marker.` : 'Every marker reached.' })),
      el('h2', { text: 'Choose your examination' }),
      el('div', { class: 'grid g2' }, lib.exams.map((e) => el('a', { class: 'area', href: `#/library?exam=${e.code}` }, el('h3', { text: `${e.name} — ${e.grade}` }), el('p', { text: e.description || '' }), el('span', { class: 'go', text: `${e.subjects.length} subjects` })))),
      p.recent_papers.length ? el('div', { class: 'card' }, el('h3', { text: 'Continue where you left off' }), p.recent_papers.map((r) => el('p', { style: 'margin:6px 0' }, el('a', { href: r.section === 'paper' ? `#/paper/${r.id}` : `#/material/${r.id}`, text: r.title }), r.year ? el('span', { class: 'srclabel', text: String(r.year) }) : null))) : null,
      p.mistakes_to_review ? el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('span', { text: `${p.mistakes_to_review} questions to review` }), el('a', { class: 'btn sm', href: '#/mistakes', text: 'Review mistakes' }))) : null,
      (G.applications || []).some((a) => a.status === 'info_requested') ? el('div', { class: 'notice', text: 'Administrators asked for more information on your application. Open Alerts.' }) : null) };
  }
  async function teacherHome() {
    const subs = await G.get('/api/content/submissions');
    const c = (s) => subs.items.filter((x) => x.status === s).length;
    return { body: el('div', null, el('div', { class: 'hello' }, el('h1', { text: `Welcome, ${G.me.full_name.split(' ')[0]}` }), el('p', { text: 'Teacher workspace' })),
      el('div', { class: 'grid g3' }, stat(c('draft'), 'Drafts'), stat(c('in_review'), 'In review'), stat(c('published'), 'Published'), stat(c('rejected'), 'Rejected')),
      el('div', { class: 'grid g2', style: 'margin-top:14px' },
        el('a', { class: 'area', href: '#/teacher/content/new' }, el('h3', { text: 'Submit content' }), el('p', { text: 'Send questions, notes or practice exercises for review.' }), el('span', { class: 'go', text: 'Upload' })),
        el('a', { class: 'area', href: '#/classes' }, el('h3', { text: 'My classes' }), el('p', { text: 'Create classes, set assignments and answer questions.' }), el('span', { class: 'go', text: 'Open classes' })))) };
  }
  G.views.home = async () => {
    if (!G.me) return G.views.welcome();
    if (G.me.role === 'student') return studentHome();
    if (G.me.role === 'teacher') return teacherHome();
    return G.views.staffHome();
  };

  const need = { auth: true };
  G.route('/', G.views.home);
  G.route('/library', G.views.library, need); G.route('/subject/:id', G.views.subject, need); G.route('/material/:id', G.views.material, need);
  G.route('/paper/:id', G.views.paper, need); G.route('/quiz/:id', G.views.quiz, need); G.route('/quiz/:id/summary', G.views.quizSummary, need);
  G.route('/progress', G.views.progress, need); G.route('/mistakes', G.views.mistakes, need);
})(window.GES);
