'use strict';
/* Staff: admin navigation, upload, content list, and the draft/review/approve/publish editor (shared by admin, supervisor, teacher). */
(function (G) {
  const { el, toast, field, submitting, pill } = G;

  const ADMIN_SECTIONS = [
    ['#/admin', 'Overview'], ['#/admin/upload', 'Upload'], ['#/admin/content', 'Content'], ['#/admin/materials', 'Learning materials'],
    ['#/admin/applications', 'Applications'], ['#/admin/supervisors', 'Supervisors'], ['#/admin/users', 'Users'],
    ['#/admin/catalog', 'Subjects and papers'], ['#/admin/inbox', 'Inbox'], ['#/admin/audit', 'Audit log'], ['#/admin/settings', 'Settings'],
  ];
  function adminNav() {
    const here = (location.hash || '').split('?')[0];
    return el('nav', { class: 'sidenav', 'aria-label': 'Administration' },
      ADMIN_SECTIONS.map(([h, t]) => el('a', { href: h, 'aria-current': here === h ? 'page' : undefined, text: t })));
  }
  const page = (title, ...content) => ({ wide: true, body: el('div', null, G.isAdmin() ? adminNav() : null, el('h1', { text: title }), content) });
  const stat = (v, l, href) => {
    const inner = [el('b', { text: String(v) }), el('span', { text: l })];
    return href ? el('a', { class: 'stat', href, style: 'text-decoration:none;color:inherit' }, inner) : el('div', { class: 'stat' }, inner);
  };
  const humanize = (s) => String(s).replace(/_/g, ' ');
  G.staffUi = { adminNav, page, stat, humanize };

  // ---------------------------------------------------------------- homes
  async function adminOverview() {
    const o = await G.get('/api/admin/overview');
    const bar = (l) => el('div', { style: 'margin-bottom:10px' },
      el('div', { class: 'row spread' }, el('span', { text: l.label }), el('span', { class: 'muted', text: `${l.used} of ${l.max}` })),
      el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, (l.used / l.max) * 100)}%` })));
    return page('Administration',
      el('div', { class: 'grid g3' },
        stat(o.awaiting_review, 'Waiting for supervisor review', '#/admin/content?stage=awaiting_review'),
        stat(o.awaiting_approval, 'Waiting for your approval', '#/admin/content?stage=awaiting_approval'),
        stat(o.content.draft, 'Drafts', '#/admin/content?status=draft'),
        stat(o.content.approved, 'Approved, not published', '#/admin/content?status=approved'),
        stat(o.content.published, 'Published', '#/admin/content?status=published'),
        stat(o.inbox_new, 'New messages and reports', '#/admin/inbox')),
      el('div', { class: 'grid g2', style: 'margin-top:14px' },
        el('div', { class: 'card' }, el('h3', { text: 'Applications waiting' }),
          el('p', null, el('a', { href: '#/admin/applications?kind=teacher', text: `${o.pending_applications.teacher} teacher` })),
          el('p', null, el('a', { href: '#/admin/applications?kind=supervisor', text: `${o.pending_applications.supervisor} supervisor` })),
          el('p', null, el('a', { href: '#/admin/applications?kind=admin', text: `${o.pending_applications.admin} administrator` }))),
        el('div', { class: 'card' }, el('h3', { text: 'People' }),
          el('p', { style: 'margin:0', text: `${o.users.students} students · ${o.users.teachers} teachers` }),
          el('p', { style: 'margin:0', text: `${o.users.supervisors} supervisors · ${o.users.admins} administrators` }),
          el('p', { class: 'muted', style: 'margin:6px 0 0', text: `${o.users.blocked} blocked accounts` }))),
      el('div', { class: 'card' }, el('h3', { text: 'Role limits' }),
        bar({ label: 'Main administrators (including the Chief)', ...o.limits.main_admins }),
        bar({ label: 'Subject supervisors', ...o.limits.supervisors }),
        bar({ label: 'Approved teachers', ...o.limits.teachers })),
      el('div', { class: 'card' }, el('h3', { text: 'Donations' }),
        el('p', { style: 'margin:0', text: `${o.donations.c} confirmed · D${o.donations.total}` }),
        el('p', { class: 'hint', text: 'Only donations confirmed by a payment provider are counted.' })));
  }

  async function supervisorHome() {
    const r = await G.get('/api/content/submissions');
    const pending = r.items.filter((x) => x.status === 'in_review' && x.review_status === 'pending');
    return { wide: true, body: el('div', null,
      el('div', { class: 'hello' }, el('h1', { text: 'Review queue' }), el('p', { text: `${pending.length} waiting for you` })),
      contentTable(r.items, { base: '#/staff/review', showUploader: true, emptyText: 'Nothing has been assigned to you yet. Administrators assign papers that match your subjects.' })) };
  }
  G.views.staffHome = () => (G.isAdmin() ? adminOverview() : supervisorHome());

  // ---------------------------------------------------------------- content list
  function contentTable(items, { base, showUploader = true, emptyText = 'No content matches.' }) {
    if (!items.length) return G.empty('Nothing here yet', emptyText);
    return el('div', { class: 'card tablewrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Title', 'Exam · subject', 'Year', 'Status', 'Review', showUploader ? 'Uploaded by' : null, 'Supervisor', 'Updated'].filter(Boolean).map((h) => el('th', { text: h })))),
      el('tbody', null, items.map((s) => el('tr', null,
        el('td', null, el('a', { href: `${base}/${s.id}`, text: s.title }), el('div', { class: 'hint', text: `${humanize(s.content_type)}${s.paper_type ? ' · ' + s.paper_type : ''} · ${s.question_count} questions` })),
        el('td', { text: `${s.exam_code} · ${s.subject_name}` }), el('td', { text: s.year || '' }), el('td', null, pill(s.status)),
        el('td', { text: s.status === 'in_review' || s.review_status !== 'none' ? humanize(s.review_status) : '' }),
        showUploader ? el('td', { text: s.uploader_name }) : null, el('td', { text: s.supervisor_name || '' }), el('td', { text: G.fmtDate(s.updated_at) }))))));
  }

  async function contentList({ query }, { section, title }) {
    const cat = await G.get('/api/content/catalog');
    const f = { ...query }; if (section) f.section = section;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const r = await G.get('/api/content/submissions' + (qs ? '?' + qs : ''));
    const set = (k) => (e) => { const q2 = { ...query, [k]: e.target.value }; if (!q2[k]) delete q2[k]; location.hash = `${(location.hash || '').split('?')[0]}?${new URLSearchParams(q2)}`; };
    const sel = (label, key, opts) => field(label, G.select([{ value: '', label: 'All' }, ...opts], query[key] || '', { on: { change: set(key) } }));
    const years = []; for (let y = cat.year_max; y >= cat.year_min; y--) years.push({ value: y, label: String(y) });
    const supers = await G.get('/api/admin/supervisors').catch(() => ({ items: [] }));
    const filters = el('div', { class: 'filters' },
      sel('Examination', 'exam_id', cat.exams.map((e) => ({ value: e.id, label: e.code }))),
      sel('Subject', 'subject_id', cat.subjects.filter((s) => !query.exam_id || String(s.exam_id) === query.exam_id).map((s) => ({ value: s.id, label: s.name }))),
      sel('Year', 'year', years),
      sel('Status', 'status', ['draft', 'in_review', 'approved', 'published', 'rejected', 'archived'].map((s) => ({ value: s, label: humanize(s) }))),
      sel('Stage', 'stage', [{ value: 'awaiting_review', label: 'Waiting for supervisor' }, { value: 'awaiting_approval', label: 'Waiting for approval' }]),
      sel('Supervisor', 'supervisor_id', supers.items.map((s) => ({ value: s.id, label: s.full_name }))));
    return page(title, filters, section ? null : el('p', null, el('a', { class: 'btn sm', href: '#/admin/upload', text: 'Upload new content' })), contentTable(r.items, { base: '#/admin/content' }));
  }
  G.views.adminContent = (p) => contentList(p, { title: 'Content' });
  G.views.adminMaterials = (p) => contentList(p, { section: 'material', title: 'Learning materials' });

  // ---------------------------------------------------------------- upload form (admin + teacher)
  G.views.upload = async () => {
    const cat = await G.get('/api/content/catalog'); const teacher = G.me.role === 'teacher';
    const types = cat.content_types.filter((t) => !(teacher && t.id === 'past_paper'));
    const exam = G.select(cat.exams.map((e) => ({ value: e.id, label: `${e.code} (${e.grade})` })), cat.exams[0] && cat.exams[0].id);
    const subject = el('select'); const type = G.select(types.map((t) => ({ value: t.id, label: t.label })), types[0] && types[0].id);
    const yrs = [{ value: '', label: 'Not applicable' }]; for (let y = cat.year_max; y >= cat.year_min; y--) yrs.push({ value: y, label: String(y) });
    const year = G.select(yrs, ''); const paper = G.select([{ value: '', label: 'Not applicable' }, ...cat.paper_types.map((p) => ({ value: p.id, label: p.name }))], '');
    const origin = G.select([{ value: 'official', label: 'Official past examination paper' }, { value: 'practice', label: 'Original practice material' }, { value: 'teacher', label: 'Teacher-prepared' }, { value: 'ai', label: 'AI-generated practice' }], 'official');
    const title = el('input', { type: 'text', required: true, maxlength: 200 }); const topic = el('input', { type: 'text', maxlength: 120 });
    const prov = el('textarea', { required: true, placeholder: 'Where did this come from? Who gave permission to use it? For example: "Scanned from the 2019 WAEC paper supplied by Mr. X, used with permission".' });
    const body = el('textarea', { placeholder: 'Optional. Paste typed questions here, or write notes. Number questions 1. 2. 3. and options A. B. C. D.' });
    const files = el('input', { type: 'file', multiple: true, accept: 'application/pdf,image/png,image/jpeg,image/webp' + (cat.content_types.length ? ',.docx' : '') });
    const err = el('div', { class: 'err', role: 'alert' }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Save as draft' });
    const fillSubjects = () => { G.clear(subject).append(cat.subjects.filter((s) => String(s.exam_id) === String(exam.value)).map((s) => el('option', { value: s.id, text: s.name }))); };
    exam.addEventListener('change', fillSubjects); fillSubjects();
    const sync = () => { const t = types.find((x) => x.id === type.value); const isPaper = t && t.section === 'paper'; year.parentNode.firstChild.textContent = isPaper ? 'Examination year (required)' : 'Year (optional)'; paper.parentNode.firstChild.textContent = isPaper ? 'Paper (required)' : 'Paper (optional)'; };
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      const fd = new FormData();
      const add = (k, v) => { if (v !== '' && v != null) fd.append(k, v); };
      add('exam_id', exam.value); add('subject_id', subject.value); add('content_type', type.value); add('year', year.value); add('paper_type_id', paper.value);
      add('origin', teacher ? '' : origin.value); add('title', title.value); add('topic', topic.value); add('provenance', prov.value); add('body', body.value);
      for (const f of files.files) fd.append('files', f);
      const r = await G.post('/api/content/submissions', fd);
      toast('Saved as a draft. Nothing is visible to students.', 'ok');
      location.hash = teacher ? `#/teacher/content/${r.id}` : `#/admin/content/${r.id}`;
    }, err); } } },
      field('Examination', exam), field('Subject', subject), field('Content type', type), field('Examination year', year), field('Paper', paper),
      teacher ? null : field('Origin', origin, 'Official papers need verified answers before they can be approved.'),
      field('Title', title), field('Topic (optional)', topic), field('Source and provenance', prov), field('Typed content (optional)', body),
      field('Original files', files, 'PDF, scanned pages or photos (PNG, JPEG, WebP), up to 30 MB each. You can choose several at once.'), err, el('div', { style: 'margin-top:16px' }, btn));
    type.addEventListener('change', sync); setTimeout(sync, 0);
    return page(teacher ? 'Submit content' : 'Upload content',
      el('div', { class: 'notice', text: 'Everything you upload is saved as a draft. It reaches students only after review, approval and a separate publish step.' }),
      el('div', { class: 'card' }, form), cat.services.ocr ? null : el('div', { class: 'notice', text: 'Automatic reading of scanned pages (OCR) is not available on this server. Text PDFs still extract; for scans, type or paste the questions.' }));
  };

  // ---------------------------------------------------------------- content detail / editor
  async function detailView({ id }, mode) {
    const [d, cat] = await Promise.all([G.get(`/api/content/submissions/${id}`), G.get('/api/content/catalog')]);
    const s = d.submission; const role = G.me.role;
    const isAdmin = G.isAdmin();
    const ctx = { d, s, cat, canEdit: d.can_edit, mode };
    const reload = () => G.refresh();
    const base = mode === 'admin' ? '#/admin/content' : mode === 'supervisor' ? '#/' : '#/teacher/content';

    const head = el('div', { class: 'card' },
      el('p', { style: 'margin:0 0 6px' }, el('a', { href: base, text: '‹ Back' })),
      el('div', { class: 'row spread' }, el('h1', { style: 'margin:0', text: s.title }), pill(s.status)),
      el('p', { class: 'muted', style: 'margin:4px 0', text: `${s.exam_code} · ${s.subject_name}${s.year ? ' · ' + s.year : ''}${s.paper_type ? ' · ' + s.paper_type : ''} · ${humanize(s.content_type)}` }),
      el('div', { class: 'row' }, el('span', { class: 'pill ' + (s.origin === 'official' ? 'official' : 'practice'), text: humanize(s.origin) })),
      (s.reviewer_name || s.approver_name) ? el('p', { style: 'margin:8px 0 0;font-weight:600', text: `Reviewed by ${s.reviewer_name || '—'} · Approved by ${s.approver_name || '—'}` }) : null,
      el('dl', { class: 'kv', style: 'margin-top:8px' },
        el('dt', { text: 'Uploaded by' }), el('dd', { text: `${s.uploader_name} on ${G.fmtDate(s.created_at)}` }),
        s.supervisor_name ? [el('dt', { text: 'Supervisor' }), el('dd', { text: `${s.supervisor_name} (assigned ${G.fmtDate(s.assigned_at)})` })] : null,
        s.publisher_name ? [el('dt', { text: 'Published by' }), el('dd', { text: `${s.publisher_name} on ${G.fmtDate(s.published_at)}` })] : null,
        el('dt', { text: 'Source' }), el('dd', { text: s.provenance || '' })),
      s.review_comment ? el('div', { class: 'notice', style: 'margin-top:10px', text: `Reviewer (${humanize(s.review_status)}): ${s.review_comment}` }) : null,
      s.correction_note ? el('div', { class: 'notice', style: 'margin-top:10px', text: `Corrections requested: ${s.correction_note}` }) : null,
      s.rejection_reason ? el('div', { class: 'notice bad', style: 'margin-top:10px', text: `Rejected: ${s.rejection_reason}` }) : null);

    const source = sourcePanel(d, ctx, reload);
    const left = el('div', null, source);
    const right = el('div', null, head, workflowPanel(ctx, reload), problemsPanel(d, s), s.section === 'paper' ? questionsPanel(d, ctx, reload) : materialPanel(ctx, reload), historyPanel(d));
    return { wide: true, body: el('div', { class: 'splits two' }, left, right) };
  }
  G.views.adminDetail = (p) => detailView(p, 'admin');
  G.views.reviewDetail = (p) => detailView(p, 'supervisor');
  G.views.teacherDetail = (p) => detailView(p, 'teacher');

  function sourcePanel(d, ctx, reload) {
    const files = d.files.filter((f) => f.role !== 'diagram'); const box = el('div'); const card = el('div', { class: 'card zoomable' }, el('h3', { text: 'Original source' }));
    if (!files.length) { card.append(el('p', { class: 'muted', text: 'No file was uploaded. This was created from typed content.' })); }
    else {
      let cur = files[0];
      const pick = G.select(files.map((f) => ({ value: f.id, label: `${f.orig_name} (${f.role.replace('_', ' ')}${f.pages > 1 ? ', ' + f.pages + ' pages' : ''})` })), cur.id, { 'aria-label': 'Choose file', on: { change: (e) => { cur = files.find((f) => String(f.id) === e.target.value); draw(); } } });
      const draw = () => {
        G.clear(box);
        if (cur.mime === 'application/pdf') box.append(el('iframe', { class: 'pdfframe', src: `/api/files/${cur.id}`, title: 'Original document' }));
        else if (cur.mime.startsWith('image/')) box.append(el('img', { src: `/api/files/${cur.id}`, alt: 'Original page', style: 'max-width:100%;border:1px solid var(--line);border-radius:8px' }));
        else box.append(el('p', null, 'This file type cannot be previewed. ', el('a', { href: `/api/files/${cur.id}?download=1`, text: 'Download it' }), '.'));
        const row = el('div', { class: 'row', style: 'margin-top:8px' }, el('a', { class: 'btn ghost sm', href: `/api/files/${cur.id}`, target: '_blank', rel: 'noopener', text: 'Open in new tab' }), el('a', { class: 'btn ghost sm', href: `/api/files/${cur.id}?download=1`, text: 'Download' }));
        if (G.isAdmin()) {
          const cleared = !!cur.student_visible;
          row.append(el('label', { style: 'margin:0;font-weight:400;display:flex;align-items:center' }, el('input', { type: 'checkbox', checked: cleared, on: { change: async (e) => { try { await G.put(`/api/content/files/${cur.id}`, { student_visible: e.target.checked }); cur.student_visible = e.target.checked ? 1 : 0; toast(e.target.checked ? 'Students can view this file once published.' : 'Hidden from students.', 'ok'); } catch (x) { toast(x.message, 'bad'); e.target.checked = !e.target.checked; } } } }), 'Students may view this file when published'));
        }
        if (ctx.canEdit && !(cur.role === 'original' && files.filter((f) => f.role === 'original').length === 1 && ctx.s.section === 'paper')) row.append(el('button', { class: 'btn ghost sm', text: 'Remove file', on: { click: async () => { if (await G.confirmBox('Remove this file?', 'The file is deleted from the draft.', 'Remove', true)) { try { await G.del(`/api/content/files/${cur.id}`); reload(); } catch (x) { toast(x.message, 'bad'); } } } } }));
        box.append(row);
      };
      draw(); card.append(files.length > 1 ? pick : null, box);
    }
    if (ctx.canEdit) {
      const f = el('input', { type: 'file', multiple: true, accept: 'application/pdf,image/png,image/jpeg,image/webp,.docx', 'aria-label': 'Add files' }); const err = el('div', { class: 'err' }); const btn = el('button', { class: 'btn ghost sm', type: 'submit', text: 'Add files' });
      card.append(el('form', { style: 'margin-top:12px', on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { if (!f.files.length) throw new Error('Choose a file first.'); const fd = new FormData(); fd.append('role', 'original'); for (const x of f.files) fd.append('files', x); await G.post(`/api/content/submissions/${ctx.s.id}/files`, fd); toast('Files added.', 'ok'); reload(); }, err); } } }, f, err, el('div', { style: 'margin-top:6px' }, btn)));
    }
    if (ctx.s.section === 'paper' && ctx.s.body && /--- page \d+ ---/.test(ctx.s.body)) {
      card.append(el('details', { style: 'margin-top:12px' }, el('summary', { text: 'Text read from the document' }), el('pre', { style: 'white-space:pre-wrap;font-size:.82rem;max-height:300px;overflow:auto;background:var(--mist);padding:8px;border-radius:8px', text: ctx.s.body })));
    }
    return card;
  }

  function problemsPanel(d, s) {
    if (!['draft', 'in_review'].includes(s.status) || s.section !== 'paper') return null;
    return d.problems.length
      ? el('div', { class: 'card' }, el('h3', { text: 'Before this can be approved' }), el('ul', { class: 'problems' }, d.problems.map((p) => el('li', { text: p }))))
      : el('div', { class: 'notice ok', text: 'Every question has a checked answer. This can be approved.' });
  }

  function materialPanel(ctx, reload) {
    const s = ctx.s; const body = el('textarea', { style: 'min-height:200px', value: s.body || '', disabled: !ctx.canEdit, 'aria-label': 'Typed content' });
    const title = el('input', { type: 'text', value: s.title, disabled: !ctx.canEdit }); const topic = el('input', { type: 'text', value: s.topic || '', disabled: !ctx.canEdit }); const prov = el('textarea', { value: s.provenance || '', disabled: !ctx.canEdit });
    const err = el('div', { class: 'err' }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Save changes' });
    return el('div', { class: 'card' }, el('h3', { text: 'Material' }), el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { await G.put(`/api/content/submissions/${s.id}`, { title: title.value, topic: topic.value, provenance: prov.value, body: body.value }); toast('Saved.', 'ok'); reload(); }, err); } } },
      field('Title', title), field('Topic', topic), field('Source and provenance', prov), field('Content', body), err, ctx.canEdit ? el('div', { style: 'margin-top:12px' }, btn) : null));
  }

  function workflowPanel(ctx, reload) {
    const { s, d } = ctx; const role = G.me.role; const admin = G.isAdmin(); const card = el('div', { class: 'card' }, el('h3', { text: 'Actions' }));
    const act = (label, cls, fn, opts = {}) => el('button', { class: 'btn ' + (cls || '') + ' sm', text: label, on: { click: async (e) => {
      const b = e.currentTarget; if (opts.confirm && !(await G.confirmBox(opts.confirm[0], opts.confirm[1], label, opts.danger))) return;
      let extra; if (opts.ask) { extra = await G.promptBox(opts.ask[0], opts.ask[1], { required: opts.askRequired !== false, okLabel: label }); if (extra === null) return; }
      await submitting(b, async () => { const r = await fn(extra); if (opts.done) toast(opts.done, 'ok'); await reload(); return r; });
    } } });
    const row = el('div', { class: 'row' });
    const post = (path, body) => G.post(`/api/content/submissions/${s.id}/${path}`, body || {});
    if (admin && ['draft', 'in_review'].includes(s.status)) {
      if (s.section === 'paper') {
        const hasOriginal = d.files.some((f) => f.role === 'original');
        if (hasOriginal) row.append(act(d.questions.length ? 'Read the document again' : 'Read questions from document', 'ghost', async () => { const r = await post('extract', { replace: false }); toast(`${r.created} questions found. ${r.warnings.join(' ')}`, r.created ? 'ok' : 'bad'); }, d.questions.length ? { confirm: ['Read the document again?', 'New questions are added after the ones you already have. Delete duplicates afterwards.'] } : {}));
        if (ctx.cat.services.ai) row.append(act('Draft missing answers with AI', 'ghost', async () => { const r = await post('ai-draft'); toast(`${r.drafted} answers drafted (unverified). ${r.failed ? r.failed + ' could not be drafted.' : ''}`, 'ok'); }));
        row.append(act('Mark all answers as checked by me', 'ghost', async () => { const r = await post('verify-all'); toast(`${r.verified} answers marked as verified by you.`, 'ok'); }, { confirm: ['Mark answers as checked?', 'Only do this after you have compared them with the original source or marking scheme. Your name is recorded.'] }));
      }
      const eligible = d.eligible_supervisors;
      const sup = G.select([{ value: '', label: eligible.length ? 'Choose a supervisor…' : 'No supervisor covers this subject' }, ...eligible.map((x) => ({ value: x.id, label: x.full_name }))], '', { 'aria-label': 'Supervisor' });
      const assignRow = el('div', { class: 'row', style: 'margin-top:10px' }, el('div', { class: 'grow' }, sup), act(s.supervisor_id ? 'Reassign for review' : 'Assign for review', '', async () => { if (!sup.value) throw new Error('Choose a supervisor first.'); await post('assign', { supervisor_id: Number(sup.value) }); }, { done: 'Assigned. The supervisor was notified.' }));
      const pendingReview = s.status === 'in_review' && s.review_status === 'pending' && !!s.supervisor_id;
      const decide = el('div', { class: 'row', style: 'margin-top:10px' },
        act('Approve', 'gold', (c) => post('decide', { decision: 'approve', comment: c, override_pending_review: pendingReview }), {
          confirm: pendingReview ? ['Approve without the supervisor review?', `${s.supervisor_name} has not finished reviewing this yet. Approving now skips that review, and this is recorded in the history.`] : undefined,
          ask: ['Approve this content', 'Note for the record (optional)'], askRequired: false, done: 'Approved. It stays hidden from students until you publish it.' }),
        act('Return for corrections', 'ghost', (c) => post('decide', { decision: 'return', comment: c }), { ask: ['Return for corrections', 'What needs correcting?'], done: 'Returned to draft.' }),
        act('Reject', 'danger', (c) => post('decide', { decision: 'reject', comment: c }), { ask: ['Reject this content', 'Why is it being rejected?'], danger: true, done: 'Rejected.' }));
      card.append(row.children.length ? row : null, assignRow, decide);
      if (s.status === 'in_review' && s.review_status === 'pending') card.append(el('p', { class: 'hint', text: 'A supervisor review is pending. Approving now skips it and is recorded in the history.' }));
    }
    if (role === 'supervisor' && s.status === 'in_review') {
      card.append(el('p', { class: 'muted', text: 'Compare each question and answer with the original on the left, correct any errors, then record your review.' }),
        el('div', { class: 'row' },
          act('Recommend approval', 'gold', (c) => post('review', { action: 'recommend_approval', comment: c }), { ask: ['Recommend approval', 'Comment (optional)'], askRequired: false, done: 'Review submitted.' }),
          act('Request corrections', 'ghost', (c) => post('review', { action: 'request_corrections', comment: c }), { ask: ['Request corrections', 'What needs correcting?'], done: 'Review submitted.' }),
          act('Recommend rejection', 'danger', (c) => post('review', { action: 'recommend_rejection', comment: c }), { ask: ['Recommend rejection', 'Why should this be rejected?'], danger: true, done: 'Review submitted.' })));
    }
    if (admin) {
      const r2 = el('div', { class: 'row', style: 'margin-top:10px' });
      if (s.status === 'approved') {
        if (G.me.can_publish) r2.append(act('Publish to students', 'gold', () => post('publish'), { confirm: ['Publish this content?', 'Students will be able to see it straight away.'], done: 'Published.' }));
        else r2.append(el('span', { class: 'hint', text: 'You are not authorised to publish. A main administrator can publish this or grant you permission.' }));
        r2.append(act('Reopen for editing', 'ghost', () => post('reopen', {}), { done: 'Reopened as a draft.' }));
      }
      if (s.status === 'published') r2.append(act('Unpublish', 'ghost', (c) => post('unpublish', { comment: c }), { ask: ['Unpublish', 'Why is it being taken down?'], done: 'Unpublished. Students can no longer see it.' }));
      if (s.status === 'rejected') r2.append(act('Reopen as draft', 'ghost', () => post('reopen', {}), { done: 'Reopened as a draft.' }));
      if (s.status === 'archived') r2.append(act('Restore as draft', 'ghost', () => post('restore'), { done: 'Restored as a draft.' }));
      if (!['archived'].includes(s.status)) r2.append(act('Archive', 'ghost', (c) => post('archive', { comment: c }), { ask: ['Archive', 'Reason (optional)'], askRequired: false, done: 'Archived. History is kept.' }));
      if (s.status === 'draft') r2.append(act('Delete draft', 'danger', async () => { await G.del(`/api/content/submissions/${s.id}`); location.hash = '#/admin/content'; }, { confirm: ['Delete this draft?', 'The draft and its files are removed permanently.'], danger: true }));
      if (r2.children.length) card.append(r2);
    }
    if (role === 'teacher' && s.status === 'draft') card.append(el('p', { class: 'hint', text: 'Prepare your questions and answers, then tell an administrator it is ready for review. Teachers cannot publish.' }), act('Delete draft', 'danger', async () => { await G.del(`/api/content/submissions/${s.id}`); location.hash = '#/teacher/content'; }, { confirm: ['Delete this draft?', 'The draft and its files are removed permanently.'], danger: true }));
    if (!card.querySelector('button') && !card.querySelector('select')) card.append(el('p', { class: 'muted', text: s.status === 'published' ? 'This content is live.' : 'No actions available in this state.' }));
    return card;
  }

  function historyPanel(d) {
    return el('div', { class: 'card' }, el('h3', { text: 'History' }),
      el('ul', { class: 'timeline' }, d.events.map((e) => el('li', null, el('b', { text: humanize(e.action) }), ` — ${e.actor_name}`, el('div', { class: 'hint', text: G.fmtTime(e.created_at) }), e.comment ? el('div', { text: e.comment }) : null))),
      d.versions.length ? el('details', null, el('summary', { text: `${d.versions.length} saved versions` }), d.versions.map((v) => el('p', { style: 'margin:4px 0' }, `v${v.version} — ${v.note || ''} `, el('small', { class: 'muted', text: `${v.changed_by_name || 'system'}, ${G.fmtTime(v.created_at)} ` }),
        el('a', { href: '#', text: 'View', on: { click: async (e) => { e.preventDefault(); const r = await G.get(`/api/content/submissions/${d.submission.id}/versions/${v.id}`); G.dialog((box, close) => box.append(el('h2', { text: `Version ${r.version}` }), el('p', { class: 'muted', text: `${r.snapshot.questions.length} questions · status ${humanize(r.snapshot.meta.status)}` }), el('div', { style: 'max-height:50vh;overflow:auto' }, r.snapshot.questions.map((q) => el('p', { style: 'margin:6px 0' }, `${q.number || ''}. ${q.text.slice(0, 160)}`))), el('button', { class: 'btn ghost', text: 'Close', on: { click: () => close() } }))); } } })))) : null);
  }

  // ---------------------------------------------------------------- question editor
  function questionsPanel(d, ctx, reload) {
    const wrap = el('div'); const s = ctx.s;
    wrap.append(el('div', { class: 'row spread' }, el('h2', { style: 'margin:0', text: `Questions (${d.questions.length})` }), ctx.canEdit ? el('div', { class: 'row' }, el('button', { class: 'btn sm', text: 'Add question', on: { click: () => addQuestion(s.id, reload) } }), el('button', { class: 'btn ghost sm', text: 'Paste typed questions', on: { click: () => pasteQuestions(s.id, reload) } })) : null));
    if (!d.questions.length) wrap.append(G.empty('No questions yet', ctx.canEdit ? 'Read them from the original document, paste typed questions, or add one by hand.' : ''));
    d.questions.forEach((q, i) => wrap.append(questionEditor(q, i, d.questions, ctx, reload)));
    return wrap;
  }
  async function addQuestion(sid, reload) {
    try { await G.post(`/api/content/submissions/${sid}/questions`, { type: 'objective', text: 'New question', options: [{ label: 'A', text: 'Option A' }, { label: 'B', text: 'Option B' }, { label: 'C', text: 'Option C' }, { label: 'D', text: 'Option D' }] }); reload(); } catch (e) { toast(e.message, 'bad'); }
  }
  function pasteQuestions(sid, reload) {
    G.dialog((box, close) => {
      const t = el('textarea', { style: 'min-height:220px', placeholder: '1. Question text\nA. Option\nB. Option\nC. Option\nD. Option\n2. Next question…' }); const err = el('div', { class: 'err' }); const btn = el('button', { class: 'btn', text: 'Add questions' });
      btn.addEventListener('click', () => submitting(btn, async () => { const r = await G.post(`/api/content/submissions/${sid}/import-text`, { text: t.value }); toast(`${r.created} questions added.`, 'ok'); close(); reload(); }, err));
      box.append(el('h2', { text: 'Paste typed questions' }), t, err, el('div', { class: 'row', style: 'margin-top:12px' }, btn, el('button', { class: 'btn ghost', text: 'Cancel', on: { click: () => close() } })));
    });
  }

  const SRC = { none: ['No answer yet', 'warn'], ai_draft: ['AI draft — not verified', 'warn'], teacher_prepared: ['Teacher-prepared', 'warn'], supervisor_verified: ['Verified by supervisor', ''], admin_verified: ['Verified by administrator', ''], official_scheme: ['Official marking scheme', ''] };

  function questionEditor(q, i, all, ctx, reload) {
    const lab = (t, node) => el('label', { style: 'display:block;font-size:.8rem;color:var(--muted,#5a6880)' }, t, node);
    const ro = !ctx.canEdit; const card = el('div', { class: 'qedit', id: `qe${q.id}` });
    const num = el('input', { type: 'text', value: q.number || '', disabled: ro, style: 'max-width:90px', 'aria-label': 'Question number' });
    const type = G.select([{ value: 'objective', label: 'Objective' }, { value: 'theory', label: 'Theory' }], q.type, { disabled: ro, 'aria-label': 'Type' });
    const text = el('textarea', { value: q.text, disabled: ro, 'aria-label': 'Question text' });
    const marks = el('input', { type: 'number', value: q.marks ?? '', min: 0, disabled: ro, style: 'max-width:90px', 'aria-label': 'Marks' });
    const topic = el('input', { type: 'text', value: q.topic || '', disabled: ro, placeholder: 'Topic', 'aria-label': 'Topic' });
    const opts = q.options.map((o) => ({ ...o })); const optBox = el('div', { class: 'opts' });
    const drawOpts = () => {
      G.clear(optBox);
      opts.forEach((o, oi) => optBox.append(el('div', { class: 'optrow' },
        el('input', { type: 'radio', name: `c${q.id}`, checked: !!o.is_correct, disabled: ro, 'aria-label': `Option ${o.label} is correct`, on: { change: () => { opts.forEach((x) => { x.is_correct = 0; }); o.is_correct = 1; } } }),
        el('b', { text: o.label }),
        el('div', null, el('input', { type: 'text', value: o.text, disabled: ro, 'aria-label': `Option ${o.label} text`, on: { input: (e) => { o.text = e.target.value; } } }),
          el('input', { type: 'text', value: o.why || '', disabled: ro, placeholder: `Why ${o.label} is ${o.is_correct ? 'right' : 'wrong'} (optional)`, style: 'margin-top:4px', 'aria-label': `Note for option ${o.label}`, on: { input: (e) => { o.why = e.target.value; } } })))));
      if (!ro) optBox.append(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost sm', text: 'Add option', on: { click: () => { if (opts.length >= 8) return; opts.push({ label: String.fromCharCode(65 + opts.length), text: '', is_correct: 0, why: '' }); drawOpts(); } } }),
        opts.length > 2 ? el('button', { type: 'button', class: 'btn ghost sm', text: 'Remove last option', on: { click: () => { opts.pop(); drawOpts(); } } }) : null));
    };
    drawOpts();
    const model = el('textarea', { value: q.model_answer || '', disabled: ro, placeholder: 'Model answer', 'aria-label': 'Model answer' });
    const guide = el('textarea', { value: q.marking_guide || '', disabled: ro, placeholder: 'Marking guide', 'aria-label': 'Marking guide', style: 'min-height:70px' });
    const expl = el('textarea', { value: q.explanation || '', disabled: ro, placeholder: 'Explanation: why the correct answer is correct', 'aria-label': 'Explanation', style: 'min-height:70px' });
    const mist = el('textarea', { value: q.common_mistakes || '', disabled: ro, placeholder: 'Common mistakes', 'aria-label': 'Common mistakes', style: 'min-height:60px' });
    const theoryBox = el('div'); const objBox = el('div');
    const showType = () => { const th = type.value === 'theory'; theoryBox.hidden = !th; objBox.hidden = th; if (!th && !opts.length) { ['A', 'B', 'C', 'D'].forEach((l) => opts.push({ label: l, text: '', is_correct: 0 })); drawOpts(); } };
    theoryBox.append(model, guide, mist); objBox.append(optBox);
    type.addEventListener('change', showType); showType();
    const [srcText, srcCls] = SRC[q.answer_source] || ['', ''];
    const err = el('div', { class: 'err' });
    const save = el('button', { class: 'btn sm', text: 'Save question' });
    save.addEventListener('click', () => submitting(save, async () => {
      const body = { number: num.value, type: type.value, text: text.value, marks: marks.value, topic: topic.value, explanation: expl.value };
      if (type.value === 'objective') body.options = opts.map((o) => ({ label: o.label, text: o.text, is_correct: o.is_correct, why: o.why })); else { body.model_answer = model.value; body.marking_guide = guide.value; body.common_mistakes = mist.value; }
      await G.put(`/api/content/questions/${q.id}`, body); toast('Question saved.', 'ok'); reload();
    }, err));
    const tools = el('div', { class: 'row', style: 'margin-top:8px' });
    if (!ro) {
      tools.append(save);
      if (['ai_draft', 'teacher_prepared', 'none'].includes(q.answer_source) && G.me.role !== 'teacher') tools.append(el('button', { class: 'btn ghost sm', text: 'Mark answer as checked', on: { click: async (e) => { await submitting(e.currentTarget, async () => { await G.post(`/api/content/questions/${q.id}/verify`); toast('Marked as checked by you.', 'ok'); reload(); }); } } }));
      if (ctx.cat.services.ai && G.isAdmin()) tools.append(el('button', { class: 'btn ghost sm', text: 'Draft with AI', on: { click: async (e) => { await submitting(e.currentTarget, async () => { await G.post(`/api/content/questions/${q.id}/ai-draft`); toast('AI draft added. It is not verified.', 'ok'); reload(); }); } } }));
      tools.append(el('button', { class: 'btn ghost sm', text: 'Up', disabled: i === 0, 'aria-label': 'Move up', on: { click: () => move(-1) } }), el('button', { class: 'btn ghost sm', text: 'Down', disabled: i === all.length - 1, 'aria-label': 'Move down', on: { click: () => move(1) } }),
        el('label', { class: 'btn ghost sm', style: 'margin:0;cursor:pointer' }, 'Add diagram', el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, on: { change: async (e) => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); try { await G.post(`/api/content/questions/${q.id}/diagram`, fd); toast('Diagram added.', 'ok'); reload(); } catch (x) { toast(x.message, 'bad'); } } } })),
        el('button', { class: 'btn danger sm', text: 'Delete', on: { click: async () => { if (await G.confirmBox('Delete this question?', 'It is removed from the draft. Earlier versions keep a copy.', 'Delete', true)) { try { await G.del(`/api/content/questions/${q.id}`); reload(); } catch (x) { toast(x.message, 'bad'); } } } } }));
    }
    async function move(delta) { const order = all.map((x) => x.id); const j = i + delta; [order[i], order[j]] = [order[j], order[i]]; try { await G.post(`/api/content/submissions/${ctx.s.id}/reorder`, { order }); reload(); } catch (x) { toast(x.message, 'bad'); } }
    card.append(el('div', { class: 'row spread' }, el('b', { text: `Question ${q.number || i + 1}${q.page_ref ? ` · page ${q.page_ref}` : ''}` }), el('span', { class: 'srclabel ' + srcCls, text: srcText })),
      el('div', { class: 'row', style: 'margin:6px 0;align-items:flex-end' }, lab('No.', num), lab('Type', type), lab('Marks', marks), el('div', { class: 'grow' }, lab('Topic', topic))), lab('Question', text),
      q.diagrams.map((fid) => el('img', { class: 'qimg', src: `/api/files/${fid}`, alt: 'Diagram', style: 'max-height:160px' })),
      objBox, theoryBox, el('div', { style: 'margin-top:6px' }, expl), err, tools);
    return card;
  }

  // ---------------------------------------------------------------- teacher list
  G.views.teacherContent = async () => {
    const r = await G.get('/api/content/submissions');
    return { wide: true, body: el('div', null, el('h1', { text: 'My content' }), el('p', null, el('a', { class: 'btn', href: '#/teacher/content/new', text: 'Submit new content' })), contentTable(r.items, { base: '#/teacher/content', showUploader: false, emptyText: 'Content you submit appears here with its review status.' })) };
  };

  const A = (roles) => ({ auth: true, roles });
  const admins = A(['admin', 'main_admin', 'chief']);
  G.route('/admin', adminOverview, admins); G.route('/admin/content', G.views.adminContent, admins); G.route('/admin/materials', G.views.adminMaterials, admins);
  G.route('/admin/content/:id', G.views.adminDetail, admins); G.route('/admin/upload', G.views.upload, admins);
  G.route('/staff/review/:id', G.views.reviewDetail, A(['supervisor']));
  G.route('/teacher/content', G.views.teacherContent, A(['teacher'])); G.route('/teacher/content/new', G.views.upload, A(['teacher'])); G.route('/teacher/content/:id', G.views.teacherDetail, A(['teacher']));
})(window.GES);
