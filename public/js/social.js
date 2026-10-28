'use strict';
(function (G) {
  const { el, toast, field, submitting } = G;

  // ---------------------------------------------------------------- AI tutor
  G.views.tutor = async () => {
    const st = await G.get('/api/tutor/status');
    if (!st.configured) return { body: el('div', null, el('h1', { text: 'AI tutor' }), el('div', { class: 'card' }, el('div', { class: 'notice', text: st.message }),
      el('p', { text: 'In the meantime, every paper shows the model answer and explanation under each question, and you can report anything that looks wrong.' }), el('a', { class: 'btn', href: '#/library', text: 'Open library' }))) };
    const history = []; const log = el('div', { class: 'chat', 'aria-live': 'polite' }); const err = el('div', { class: 'err' });
    const input = el('textarea', { placeholder: 'Ask about a topic, a past-paper answer, or a calculation…', 'aria-label': 'Your question', style: 'min-height:70px' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Ask' });
    const add = (who, text, extra) => { log.append(el('div', { class: 'msg' + (who === 'me' ? ' mine' : '') }, el('b', { text: who === 'me' ? 'You' : 'AI tutor' }), el('div', null, el('span', { class: 'bub', text }), extra))); log.scrollTop = log.scrollHeight; };
    const quick = ['Explain this step by step', 'Explain more simply', 'Give me a practice question'];
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); const m = input.value.trim(); if (!m) return; submitting(btn, async () => {
      add('me', m); input.value = '';
      const r = await G.post('/api/tutor', { message: m, history }); history.push({ role: 'user', content: m }, { role: 'assistant', content: r.answer });
      add('ai', r.answer, el('div', { class: 'hint' }, el('span', { class: 'srclabel warn', text: r.label }), r.sources.length ? el('div', null, 'Related verified papers: ', r.sources.map((s) => el('a', { href: `#/paper/${s.paper_id}`, text: `${s.title}${s.year ? ' ' + s.year : ''} ` }))) : null));
    }, err); } } }, input, err, el('div', { class: 'row', style: 'margin-top:8px' }, btn, quick.map((t) => el('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { input.value = t; form.requestSubmit(); } }, text: t }))));
    return { body: el('div', null, el('h1', { text: 'AI tutor' }), el('p', { class: 'muted', text: 'AI explanations can contain mistakes and are not official answers. Check important facts against the verified model answers.' }), log, form) };
  };

  // ---------------------------------------------------------------- classes
  G.views.classes = async () => {
    const { items } = await G.get('/api/classes'); const teacher = G.me.role === 'teacher';
    const body = el('div', null, el('h1', { text: 'Classes' }));
    if (teacher) {
      const err = el('div', { class: 'err' }); const name = el('input', { type: 'text', required: true }); const kind = G.select([{ value: 'class', label: 'Class' }, { value: 'group', label: 'Study group' }], 'class');
      const btn = el('button', { class: 'btn', type: 'submit', text: 'Create' });
      body.append(el('div', { class: 'card' }, el('h3', { text: 'Create a class or study group' }), el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { const r = await G.post('/api/classes', { name: name.value, kind: kind.value }); location.hash = `#/class/${r.id}`; }, err); } } }, field('Name', name), field('Type', kind), err, el('div', { style: 'margin-top:12px' }, btn))));
    } else {
      const err = el('div', { class: 'err' }); const code = el('input', { type: 'text', placeholder: 'Code from your teacher', autocapitalize: 'characters', required: true }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Join' });
      body.append(el('div', { class: 'card' }, el('h3', { text: 'Join a class' }), el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { const r = await G.post('/api/classes/join', { code: code.value }); toast(`Joined ${r.name}`, 'ok'); location.hash = `#/class/${r.id}`; }, err); } } }, field('Class code', code), err, el('div', { style: 'margin-top:12px' }, btn))));
    }
    body.append(items.length ? el('div', { class: 'grid g2' }, items.map((c) => el('a', { class: 'area', href: `#/class/${c.id}` }, el('h3', { text: c.name }), el('p', { text: teacher ? `${c.members} student${c.members === 1 ? '' : 's'} · code ${c.join_code}` : `Teacher: ${c.teacher_name}` }), c.archived ? el('span', { class: 'pill archived', text: 'Archived' }) : null))) : G.empty('No classes yet', teacher ? 'Create your first class above.' : 'Ask your teacher for a class code.'));
    return { body };
  };

  G.views.classDetail = async ({ id, query }) => {
    const info = await G.get(`/api/classes/${id}`); const tab = query.tab || 'work'; const c = info.class;
    const tabs = el('div', { class: 'sidenav' }, [['work', 'Assignments'], ['chat', 'Chat'], info.is_owner ? ['people', 'People'] : null].filter(Boolean).map(([k, l]) => el('a', { href: `#/class/${id}?tab=${k}`, 'aria-current': tab === k ? 'page' : undefined, text: l })));
    const body = el('div', null, el('p', null, el('a', { href: '#/classes', text: '‹ Classes' })), el('h1', { text: c.name }), el('p', { class: 'muted', text: `Teacher: ${c.teacher_name}${info.is_owner ? ` · Join code: ${c.join_code}` : ''}` }), tabs);
    if (tab === 'chat') body.append(await chatPanel(id, info));
    else if (tab === 'people' && info.is_owner) body.append(peoplePanel(id, info));
    else body.append(await workPanel(id, info));
    return { body };
  };

  async function workPanel(cid, info) {
    const { items } = await G.get(`/api/classes/${cid}/assignments`); const wrap = el('div');
    if (info.is_owner) wrap.append(newAssignmentCard(cid));
    wrap.append(items.length ? items.map((a) => assignmentCard(a, info)) : G.empty('No assignments yet', info.is_owner ? 'Create one above.' : 'New assignments will appear here.'));
    return wrap;
  }
  function assignmentCard(a, info) {
    const card = el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h3', { style: 'margin:0', text: a.title }), el('span', { class: 'pill', text: a.kind === 'quiz' ? 'Quiz' : 'Written' })),
      a.due_at ? el('p', { class: 'muted', style: 'margin:4px 0', text: `Due ${G.fmtDate(a.due_at)}` }) : null, a.instructions ? el('p', { text: a.instructions }) : null);
    if (info.is_owner) {
      card.append(el('div', { class: 'row' }, el('span', { class: 'muted', text: `${a.submitted} submitted` }), el('button', { class: 'btn sm', text: 'View submissions', on: { click: () => submissionsDialog(a) } })));
    } else if (a.mine) {
      card.append(el('div', { class: 'notice ok' }, a.auto_total != null || a.mine.auto_total != null ? `Score: ${a.mine.auto_score} of ${a.mine.auto_total}. ` : 'Submitted. ', a.mine.grade ? `Grade: ${a.mine.grade}. ` : '', a.mine.feedback ? `Teacher feedback: ${a.mine.feedback}` : ''));
    } else {
      const err = el('div', { class: 'err' }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Submit' });
      if (a.kind === 'quiz') {
        const picks = a.questions.map(() => -1);
        const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { if (picks.includes(-1)) throw new Error('Answer every question before submitting.'); const r = await G.post(`/api/assignments/${a.id}/submit`, { answers: picks }); toast(`You scored ${r.auto_score} of ${r.auto_total}`, 'ok'); G.navigate(); }, err); } } },
          a.questions.map((q, qi) => el('fieldset', { style: 'border:0;padding:0;margin:12px 0' }, el('legend', { style: 'font-weight:600', text: `${qi + 1}. ${q.text}` }), q.options.map((o, oi) => el('label', { style: 'font-weight:400;display:flex;align-items:center;margin:4px 0' }, el('input', { type: 'radio', name: `a${a.id}q${qi}`, on: { change: () => { picks[qi] = oi; } } }), o)))), err, btn);
        card.append(form);
      } else {
        const ans = el('textarea', { required: true, 'aria-label': 'Your answer' });
        card.append(el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { await G.post(`/api/assignments/${a.id}/submit`, { answer: ans.value }); toast('Submitted.', 'ok'); G.navigate(); }, err); } } }, ans, err, el('div', { style: 'margin-top:8px' }, btn)));
      }
    }
    return card;
  }
  function newAssignmentCard(cid) {
    const kind = G.select([{ value: 'written', label: 'Written task' }, { value: 'quiz', label: 'Quiz (marked automatically)' }], 'written');
    const title = el('input', { type: 'text', required: true }); const ins = el('textarea'); const due = el('input', { type: 'date' });
    const qbox = el('div'); const qs = [];
    const addQ = () => { const q = { text: el('input', { type: 'text', placeholder: 'Question' }), opts: [0, 1, 2, 3].map(() => el('input', { type: 'text' })), correct: 0 };
      qs.push(q); qbox.append(el('div', { class: 'qedit' }, q.text, el('div', { class: 'opts' }, q.opts.map((o, i) => el('div', { class: 'optrow', style: 'grid-template-columns:auto 1fr' }, el('input', { type: 'radio', name: 'c' + qs.length, checked: i === 0, 'aria-label': `Option ${'ABCD'[i]} is correct`, on: { change: () => { q.correct = i; } } }), Object.assign(o, { placeholder: `Option ${'ABCD'[i]}` })))))); };
    kind.addEventListener('change', () => { qbox.hidden = kind.value !== 'quiz'; if (kind.value === 'quiz' && !qs.length) addQ(); }); qbox.hidden = true;
    const err = el('div', { class: 'err' }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Create assignment' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      const body = { kind: kind.value, title: title.value, instructions: ins.value, due_at: due.value || null };
      if (kind.value === 'quiz') body.questions = qs.map((q) => ({ text: q.text.value, options: q.opts.map((o) => o.value).filter(Boolean), correct: q.correct })).filter((q) => q.text);
      await G.post(`/api/classes/${cid}/assignments`, body); toast('Assignment created. Students were notified.', 'ok'); G.navigate();
    }, err); } } }, field('Type', kind), field('Title', title), field('Instructions', ins), field('Due date', due), qbox,
      el('button', { type: 'button', class: 'btn ghost sm', style: 'margin-top:8px', text: 'Add question', on: { click: () => { addQ(); } } }), err, el('div', { style: 'margin-top:12px' }, btn));
    qbox.parentNode; const addBtn = form.querySelector('button.ghost'); const sync = () => { addBtn.hidden = kind.value !== 'quiz'; }; kind.addEventListener('change', sync); sync();
    return el('details', { class: 'card' }, el('summary', { style: 'font-weight:700;cursor:pointer', text: 'New assignment' }), form);
  }
  async function submissionsDialog(a) {
    const { items } = await G.get(`/api/assignments/${a.id}/submissions`);
    G.dialog((box, close) => {
      box.append(el('h2', { text: a.title }), items.length ? items.map((s) => {
        const grade = el('input', { type: 'text', value: s.grade || '', placeholder: 'Grade', 'aria-label': 'Grade' }); const fb = el('input', { type: 'text', value: s.feedback || '', placeholder: 'Feedback', 'aria-label': 'Feedback' });
        return el('div', { class: 'qedit' }, el('b', { text: s.full_name }), s.auto_total != null ? el('p', { text: `Auto score: ${s.auto_score}/${s.auto_total}` }) : el('p', { style: 'white-space:pre-wrap', text: s.answer }), grade, fb,
          el('button', { class: 'btn sm', style: 'margin-top:8px', text: 'Save', on: { click: async () => { try { await G.put(`/api/assignment-submissions/${s.id}/grade`, { grade: grade.value, feedback: fb.value }); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'bad'); } } } }));
      }) : G.empty('No submissions yet'), el('button', { class: 'btn ghost', text: 'Close', on: { click: () => close() } }));
    });
  }
  function peoplePanel(cid, info) {
    const act = async (uid, a) => { try { await G.post(`/api/classes/${cid}/members/${uid}/${a}`); G.navigate(); } catch (e) { toast(e.message, 'bad'); } };
    return el('div', { class: 'card tablewrap' }, info.members.length ? el('table', null, el('thead', null, el('tr', null, ['Student', 'School', 'Status', ''].map((h) => el('th', { text: h })))), el('tbody', null, info.members.map((m) => el('tr', null, el('td', { text: m.full_name }), el('td', { text: m.school || '' }), el('td', { text: m.removed ? 'Removed' : m.muted ? 'Muted' : 'Active' }),
      el('td', null, !m.removed && el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', text: m.muted ? 'Unmute' : 'Mute', on: { click: () => act(m.id, m.muted ? 'unmute' : 'mute') } }), el('button', { class: 'btn ghost sm', text: 'Remove', on: { click: async () => { if (await G.confirmBox('Remove student?', `${m.full_name} will lose access to this class.`, 'Remove', true)) act(m.id, 'remove'); } } }))))))) : G.empty('No students yet', `Share the code ${info.class.join_code}.`));
  }
  async function chatPanel(cid, info) {
    const log = el('div', { class: 'chat', 'aria-live': 'polite' }); let last = 0;
    const load = async (first) => { try { const { items } = await G.get(`/api/classes/${cid}/messages?after=${last}`); const atEnd = first || log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
      for (const m of items) { last = Math.max(last, m.id); log.append(el('div', { class: 'msg' + (m.mine ? ' mine' : '') }, el('b', { text: m.full_name + (m.is_teacher ? ' (teacher)' : '') }), el('div', null, el('span', { class: 'bub', text: m.body })),
        el('div', { class: 'hint' }, G.fmtTime(m.created_at), ' ', (m.mine || info.is_owner) ? el('a', { href: '#', text: 'Delete', on: { click: async (e) => { e.preventDefault(); try { await G.del(`/api/classes/${cid}/messages/${m.id}`); G.navigate(); } catch (x) { toast(x.message, 'bad'); } } } }) : el('a', { href: '#', text: 'Report', on: { click: async (e) => { e.preventDefault(); try { await G.post(`/api/classes/${cid}/messages/${m.id}/report`, {}); toast('Reported to staff.', 'ok'); } catch (x) { toast(x.message, 'bad'); } } } })))); }
      if (atEnd) log.scrollTop = log.scrollHeight; } catch (e) { /* offline: keep what we have */ } };
    await load(true); const h = setInterval(() => load(false), 5000); G.cleanup = () => clearInterval(h);
    const input = el('input', { type: 'text', maxlength: 1000, placeholder: 'Write a message', 'aria-label': 'Message' }); const err = el('div', { class: 'err' });
    return el('div', null, el('p', { class: 'hint', text: 'Be kind. Teachers can delete messages and mute people, and anyone can report a message to staff.' }), log, el('form', { class: 'row', on: { submit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; (async () => { try { await G.post(`/api/classes/${cid}/messages`, { body: t }); input.value = ''; err.classList.remove('show'); await load(false); } catch (x) { err.textContent = x.message; err.classList.add('show'); } })(); } } }, el('div', { class: 'grow' }, input), el('button', { class: 'btn', type: 'submit', text: 'Send' })), err);
  }

  // ---------------------------------------------------------------- profile + notifications
  G.views.profile = async () => {
    const fresh = await G.get('/api/auth/me'); const u = fresh.user;
    const err = el('div', { class: 'err' }); const name = el('input', { type: 'text', value: u.full_name }); const school = el('input', { type: 'text', value: u.school || '' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Save profile' });
    const profile = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { await G.put('/api/profile', { full_name: name.value, school: school.value }); await G.loadMe(); toast('Profile saved.', 'ok'); G.navigate(); }, err); } } }, field('Full name', name), field('School', school), err, el('div', { style: 'margin-top:12px' }, btn));
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Profile picture' }); const aerr = el('div', { class: 'err' }); const abtn = el('button', { class: 'btn ghost', type: 'submit', text: 'Upload picture' });
    const avatar = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(abtn, async () => { if (!file.files[0]) throw new Error('Choose an image first.'); const fd = new FormData(); fd.append('avatar', file.files[0]); await G.post('/api/profile/avatar', fd); await G.loadMe(); toast('Picture updated.', 'ok'); G.navigate(); }, aerr); } } }, file, el('div', { class: 'hint', text: 'PNG, JPEG or WebP, up to 2 MB.' }), aerr, el('div', { style: 'margin-top:8px' }, abtn));
    const cur = el('input', { type: 'password', autocomplete: 'current-password' }); const nw = el('input', { type: 'password', autocomplete: 'new-password' }); const perr = el('div', { class: 'err' }); const pbtn = el('button', { class: 'btn ghost', type: 'submit', text: 'Change password' });
    const pw = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(pbtn, async () => { await G.post('/api/auth/change-password', { current: cur.value, password: nw.value }); toast('Password changed.', 'ok'); cur.value = nw.value = ''; }, perr); } } }, field('Current password', cur), field('New password', nw), perr, el('div', { style: 'margin-top:8px' }, pbtn));
    const saved = G.offlineList();
    const apps = fresh.applications || [];
    return { body: el('div', null, el('h1', { text: 'Your profile' }),
      el('div', { class: 'card' }, el('p', { style: 'margin:0', text: `${u.email || ''}${u.email && u.phone ? ' · ' : ''}${u.phone || ''}` }), el('p', { class: 'muted', style: 'margin:0', text: `Role: ${u.role.replace('_', ' ')}` })),
      el('div', { class: 'card' }, el('h3', { text: 'Details' }), profile), el('div', { class: 'card' }, el('h3', { text: 'Profile picture' }), avatar), el('div', { class: 'card' }, el('h3', { text: 'Password' }), pw),
      el('div', { class: 'card' }, el('h3', { text: 'Reading preferences' }), el('p', { class: 'muted', text: `Text size ${Math.round(G.prefs.font_scale * 100)}%. Scroll and page mode are saved when you change them inside a paper.` }),
        el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', text: 'Smaller', on: { click: async () => { await G.savePrefs({ font_scale: Math.max(0.85, +(G.prefs.font_scale - 0.1).toFixed(2)) }); G.applyFont(); G.navigate(); } } }), el('button', { class: 'btn ghost sm', text: 'Larger', on: { click: async () => { await G.savePrefs({ font_scale: Math.min(1.8, +(G.prefs.font_scale + 0.1).toFixed(2)) }); G.applyFont(); G.navigate(); } } }))),
      el('div', { class: 'card' }, el('h3', { text: 'Saved for offline' }), saved.length ? saved.map((p) => el('div', { class: 'row spread', style: 'margin:6px 0' }, el('a', { href: `#/paper/${p.id}`, text: `${p.subject} ${p.year || ''} — ${p.title}` }), el('button', { class: 'btn ghost sm', text: 'Remove', on: { click: () => { G.offlineRemove(p.id); G.navigate(); } } }))) : el('p', { class: 'muted', text: 'Nothing saved. Use “Save for offline” inside a paper. Saved papers are removed from this device when you log out.' })),
      apps.length ? el('div', { class: 'card' }, el('h3', { text: 'Your staff applications' }), apps.map((a) => el('p', { style: 'margin:4px 0', text: `${a.kind}: ${a.status.replace('_', ' ')}${a.decision_reason ? ' — ' + a.decision_reason : ''}` }))) : null,
      (u.role === 'student' || u.role === 'teacher') ? el('div', { class: 'card' }, el('h3', { text: 'Staff roles' }), el('a', { class: 'btn ghost', href: '#/staff', text: 'Apply as teacher or supervisor' })) : null,
      el('div', { class: 'card' }, el('div', { class: 'row' }, el('a', { class: 'btn ghost', href: '#/contact', text: 'Contact and support' }), el('a', { class: 'btn ghost', href: '#/donate', text: 'Support us' }), el('button', { class: 'btn danger', text: 'Log out', on: { click: () => G.logout() } })))) };
  };

  G.views.notifications = async () => {
    const { items } = await G.get('/api/notifications');
    if (G.unread) { G.post('/api/notifications/read').then(() => { G.unread = 0; }).catch(() => {}); }
    return { body: el('div', null, el('h1', { text: 'Alerts' }), items.length ? items.map((n) => el('div', { class: 'card', style: n.read ? '' : 'border-left:5px solid var(--gold)' }, el('b', { text: n.title }), n.body ? el('p', { style: 'margin:4px 0', text: n.body }) : null,
      el('div', { class: 'row' }, el('small', { class: 'muted', text: G.fmtTime(n.created_at) }), n.link && n.link.startsWith('#/') ? el('a', { href: n.link, text: 'Open' }) : null))) : G.empty('No alerts', 'Decisions on your applications and class activity show up here.')) };
  };

  const need = { auth: true };
  G.route('/tutor', G.views.tutor, need); G.route('/classes', G.views.classes, need); G.route('/class/:id', G.views.classDetail, need);
  G.route('/profile', G.views.profile, need); G.route('/notifications', G.views.notifications, need);
})(window.GES);
