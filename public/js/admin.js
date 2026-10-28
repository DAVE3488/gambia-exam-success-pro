'use strict';
/* Admin: applications, users and roles, supervisors, catalog, inbox, audit log, settings. */
(function (G) {
  const { el, toast, field, submitting } = G;
  const U = () => G.staffUi;
  const act = (label, cls, fn) => el('button', { class: 'btn sm ' + (cls || ''), text: label, on: { click: async (e) => { await submitting(e.currentTarget, fn); } } });

  // ---------------------------------------------------------------- applications
  G.views.adminApplications = async ({ query }) => {
    const kind = query.kind || 'teacher'; const status = query.status || '';
    const r = await G.get(`/api/admin/applications?kind=${kind}${status ? '&status=' + status : ''}`);
    const tabs = el('div', { class: 'sidenav' }, [['teacher', 'Teachers'], ['supervisor', 'Supervisors'], ['admin', 'Administrators']].map(([k, l]) => el('a', { href: `#/admin/applications?kind=${k}`, 'aria-current': kind === k ? 'page' : undefined, text: l })),
      el('a', { href: `#/admin/applications?kind=${kind}&status=${status ? '' : 'approved'}`, text: status ? 'Show pending' : 'Show approved' }),
      el('a', { href: `#/admin/applications?kind=${kind}&status=rejected`, text: 'Show rejected' }));
    const decide = async (a, decision) => {
      let reason = '';
      if (decision !== 'approve') { reason = await G.promptBox(decision === 'reject' ? 'Reject application' : 'Ask for more information', decision === 'reject' ? 'Reason (the applicant will see this)' : 'What do you need to know?', { okLabel: decision === 'reject' ? 'Reject' : 'Send request' }); if (reason === null) return; }
      else if (!(await G.confirmBox(`Approve ${a.full_name}?`, a.kind === 'supervisor' ? 'They become a subject supervisor for the subjects they chose.' : a.kind === 'teacher' ? 'They become an approved teacher.' : 'They become an administrator.', 'Approve'))) return;
      try { await G.post(`/api/admin/applications/${a.id}/decide`, { decision, reason }); toast('Done. The applicant was notified.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); }
    };
    const items = r.items.map((a) => el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h3', { style: 'margin:0', text: a.full_name }), el('span', { class: 'pill ' + (a.status === 'approved' ? 'published' : a.status === 'rejected' ? 'rejected' : 'in_review'), text: a.status.replace('_', ' ') })),
      el('p', { class: 'muted', style: 'margin:2px 0 8px', text: `${a.email || ''}${a.email && a.phone ? ' · ' : ''}${a.phone || ''}${a.school ? ' · ' + a.school : ''} · applied ${G.fmtDate(a.created_at)}` }),
      a.subjects.length ? el('p', { style: 'margin:4px 0' }, el('b', { text: 'Subjects: ' }), a.subjects.map((s) => `${s.name} (${s.exam})`).join(', ')) : null,
      el('p', { style: 'margin:4px 0;white-space:pre-wrap' }, el('b', { text: 'Qualifications: ' }), a.qualifications || ''), a.experience ? el('p', { style: 'margin:4px 0;white-space:pre-wrap' }, el('b', { text: 'Experience: ' }), a.experience) : null,
      a.institution ? el('p', { style: 'margin:4px 0' }, el('b', { text: 'Institution: ' }), a.institution) : null, a.message ? el('p', { style: 'margin:4px 0;white-space:pre-wrap' }, el('b', { text: 'Message: ' }), a.message) : null,
      a.decided_by_name ? el('p', { class: 'hint', text: `${a.status.replace('_', ' ')} by ${a.decided_by_name} on ${G.fmtDate(a.decided_at)}${a.decision_reason ? ': ' + a.decision_reason : ''}` }) : null,
      ['pending', 'info_requested'].includes(a.status) ? el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn gold sm', text: 'Approve', on: { click: () => decide(a, 'approve') } }), el('button', { class: 'btn ghost sm', text: 'Ask for more information', on: { click: () => decide(a, 'request_info') } }), el('button', { class: 'btn danger sm', text: 'Reject', on: { click: () => decide(a, 'reject') } })) : null));
    return U().page('Applications', tabs, items.length ? items : G.empty('Nothing waiting', 'New applications appear here for review.'));
  };

  // ---------------------------------------------------------------- users
  G.views.adminUsers = async ({ query }) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
    const r = await G.get('/api/admin/users' + (qs ? '?' + qs : ''));
    const main = G.isMain(); const chief = G.me.role === 'chief'; const rank = { student: 0, teacher: 1, supervisor: 2, admin: 3, main_admin: 4, chief: 5 };
    const search = el('input', { type: 'search', value: query.q || '', placeholder: 'Search name, email, phone or school', 'aria-label': 'Search users' });
    const go = () => { const q2 = { ...query, q: search.value }; location.hash = `#/admin/users?${new URLSearchParams(Object.entries(q2).filter(([, v]) => v))}`; };
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const roleSel = G.select([{ value: '', label: 'All roles' }, ...['student', 'teacher', 'supervisor', 'admin', 'main_admin'].map((x) => ({ value: x, label: x.replace('_', ' ') }))], query.role || '', { 'aria-label': 'Role', on: { change: (e) => { query.role = e.target.value; go(); } } });
    const stSel = G.select([{ value: '', label: 'Any status' }, { value: 'active', label: 'Active' }, { value: 'blocked', label: 'Blocked' }], query.status || '', { 'aria-label': 'Status', on: { change: (e) => { query.status = e.target.value; go(); } } });
    const manage = (u) => !u.is_chief && u.id !== G.me.id && (chief || (main && rank[u.role] < 4) || (!main && rank[u.role] < 3));
    const block = async (u) => { const reason = await G.promptBox(`Block ${u.full_name}`, 'Reason (recorded in the audit log)', { okLabel: 'Block account' }); if (!reason) return; try { await G.post(`/api/admin/users/${u.id}/block`, { reason }); toast('Account blocked and signed out.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); } };
    const unblock = async (u) => { const reason = await G.promptBox(`Unblock ${u.full_name}`, 'Reason (optional)', { required: false, okLabel: 'Unblock' }); if (reason === null) return; try { await G.post(`/api/admin/users/${u.id}/unblock`, { reason }); toast('Account unblocked.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); } };
    const resetLink = async (u) => { try { const r2 = await G.post(`/api/admin/users/${u.id}/reset-link`); const url = location.origin + r2.path;
      G.dialog((box, close) => box.append(el('h2', { text: 'One-time reset link' }), el('p', { text: `Give this link to ${u.full_name} privately. It works once and expires in ${r2.expires_in_minutes} minutes.` }), el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Reset link', on: { focus: (e) => e.target.select() } }),
        el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn', text: 'Copy link', on: { click: async () => { try { await navigator.clipboard.writeText(url); toast('Copied.', 'ok'); } catch { toast('Select the link and copy it.', 'bad'); } } } }), el('button', { class: 'btn ghost', text: 'Close', on: { click: () => close() } })))); } catch (e) { toast(e.message, 'bad'); } };
    const setRole = async (u, role) => { if (!role || role === u.role) return; if (!(await G.confirmBox('Change role?', `${u.full_name} will become ${role.replace('_', ' ')}.`, 'Change role'))) { G.refresh(); return; } try { await G.post(`/api/admin/users/${u.id}/role`, { role }); toast('Role changed.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); G.refresh(); } };
    const rows = r.items.map((u) => el('tr', null,
      el('td', null, el('b', { text: u.full_name }), el('div', { class: 'hint', text: `${u.email || ''}${u.email && u.phone ? ' · ' : ''}${u.phone || ''}` }), u.school ? el('div', { class: 'hint', text: u.school }) : null),
      el('td', null, u.is_chief ? el('span', { class: 'pill official', text: 'Chief Administrator' }) : (main && manage(u) ? G.select(['student', 'teacher', 'supervisor', 'admin', ...(chief ? ['main_admin'] : [])].map((x) => ({ value: x, label: x.replace('_', ' ') })), u.role, { 'aria-label': `Role for ${u.full_name}`, on: { change: (e) => setRole(u, e.target.value) } }) : u.role.replace('_', ' ')),
        main && u.role === 'admin' && manage(u) ? el('label', { style: 'font-weight:400;margin:6px 0 0;display:flex;align-items:center' }, el('input', { type: 'checkbox', checked: !!u.can_publish, on: { change: async (e) => { try { await G.post(`/api/admin/users/${u.id}/can-publish`, { value: e.target.checked }); toast(e.target.checked ? 'Can now publish.' : 'Publishing removed.', 'ok'); } catch (x) { toast(x.message, 'bad'); e.target.checked = !e.target.checked; } } } }), 'May publish') : null),
      el('td', null, u.status === 'blocked' ? el('span', { class: 'pill rejected', text: 'Blocked' }) : el('span', { class: 'pill published', text: 'Active' }), u.blocked_reason ? el('div', { class: 'hint', text: u.blocked_reason }) : null),
      el('td', null, manage(u) ? el('div', { class: 'row' }, u.status === 'blocked' ? el('button', { class: 'btn ghost sm', text: 'Unblock', on: { click: () => unblock(u) } }) : el('button', { class: 'btn ghost sm', text: 'Block', on: { click: () => block(u) } }), el('button', { class: 'btn ghost sm', text: 'Reset link', on: { click: () => resetLink(u) } })) : el('span', { class: 'hint', text: u.is_chief ? 'Protected' : '' }))));
    return U().page('Users', el('div', { class: 'row', style: 'margin-bottom:12px' }, el('div', { class: 'grow' }, search), roleSel, stSel, el('button', { class: 'btn sm', text: 'Search', on: { click: go } })),
      el('div', { class: 'card tablewrap' }, r.items.length ? el('table', null, el('thead', null, el('tr', null, ['Person', 'Role', 'Status', ''].map((h) => el('th', { text: h })))), el('tbody', null, rows)) : G.empty('No users match')));
  };

  // ---------------------------------------------------------------- supervisors
  G.views.adminSupervisors = async () => {
    const [r, cat] = await Promise.all([G.get('/api/admin/supervisors'), G.get('/api/admin/catalog')]);
    const edit = (s) => G.dialog((box, close) => {
      const chosen = new Set(s.subjects.map((x) => x.id)); const err = el('div', { class: 'err' }); const counter = el('p', { class: 'hint' });
      const upd = () => { counter.textContent = `${chosen.size} selected. A supervisor needs 2 to ${r.max_subjects} subjects.`; };
      const list = cat.exams.map((e) => el('details', { open: true }, el('summary', { style: 'font-weight:700', text: e.code }), cat.subjects.filter((x) => x.exam_id === e.id && x.active).map((x) => el('label', { style: 'font-weight:400;display:flex;align-items:center;margin:2px 0' }, el('input', { type: 'checkbox', checked: chosen.has(x.id), on: { change: (ev) => { if (ev.target.checked) { if (chosen.size >= r.max_subjects) { ev.target.checked = false; toast(`At most ${r.max_subjects} subjects.`, 'bad'); return; } chosen.add(x.id); } else chosen.delete(x.id); upd(); } } }), x.name))));
      upd(); const btn = el('button', { class: 'btn', text: 'Save subjects' });
      btn.addEventListener('click', () => submitting(btn, async () => { await G.put(`/api/admin/supervisors/${s.id}/subjects`, { subject_ids: [...chosen] }); toast('Subjects updated.', 'ok'); close(); G.refresh(); }, err));
      box.append(el('h2', { text: `Subjects for ${s.full_name}` }), el('div', { style: 'max-height:50vh;overflow:auto' }, list), counter, err, el('div', { class: 'row', style: 'margin-top:12px' }, btn, el('button', { class: 'btn ghost', text: 'Cancel', on: { click: () => close() } })));
    });
    return U().page('Supervisors', r.items.length ? el('div', { class: 'card tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Supervisor', 'Subjects', 'Open reviews', ''].map((h) => el('th', { text: h })))),
      el('tbody', null, r.items.map((s) => el('tr', null, el('td', null, el('b', { text: s.full_name }), el('div', { class: 'hint', text: s.email || s.phone || '' }), s.status === 'blocked' ? el('span', { class: 'pill rejected', text: 'Blocked' }) : null),
        el('td', { text: s.subjects.map((x) => `${x.name} (${x.exam})`).join(', ') }), el('td', { text: String(s.open_reviews) }), el('td', null, el('button', { class: 'btn ghost sm', text: 'Edit subjects', on: { click: () => edit(s) } }))))))) : G.empty('No supervisors yet', 'Approve supervisor applications to add them.'));
  };

  // ---------------------------------------------------------------- catalog (exams, subjects, paper types)
  G.views.adminCatalog = async () => {
    const c = await G.get('/api/admin/catalog'); const wrap = el('div');
    const ask = async (title, label, fn, hint) => { const v = await G.promptBox(title, label, { multiline: false, okLabel: 'Save', hint }); if (!v) return; try { await fn(v); toast('Saved.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); } };
    const toggle = (path, row) => act(row.active ? 'Deactivate' : 'Activate', 'ghost', async () => { await G.put(path, { active: !row.active }); toast(row.active ? 'Hidden from students.' : 'Visible to students.', 'ok'); G.refresh(); });
    for (const e of c.exams) {
      const subs = c.subjects.filter((s) => s.exam_id === e.id);
      wrap.append(el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', { style: 'margin:0', text: `${e.name} — ${e.grade || ''}` }), el('div', { class: 'row' }, !e.active ? el('span', { class: 'pill archived', text: 'Inactive' }) : null, el('button', { class: 'btn ghost sm', text: 'Rename', on: { click: () => ask('Rename examination', 'New name', (v) => G.put(`/api/admin/exams/${e.id}`, { name: v })) } }), toggle(`/api/admin/exams/${e.id}`, e), el('button', { class: 'btn sm', text: 'Add subject', on: { click: () => ask('Add subject', 'Subject name', (v) => G.post('/api/admin/subjects', { exam_id: e.id, name: v })) } }))),
        el('div', { class: 'tablewrap' }, el('table', null, el('tbody', null, subs.map((s) => el('tr', null, el('td', { text: s.name }), el('td', null, s.active ? '' : el('span', { class: 'pill archived', text: 'Inactive' })), el('td', null, el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', text: 'Rename', on: { click: () => ask('Rename subject', 'New name', (v) => G.put(`/api/admin/subjects/${s.id}`, { name: v })) } }), toggle(`/api/admin/subjects/${s.id}`, s))))))))));
    }
    wrap.append(el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('h2', { style: 'margin:0', text: 'Paper types' }), el('button', { class: 'btn sm', text: 'Add paper type', on: { click: () => ask('Add paper type', 'Name, for example Paper 3', (v) => G.post('/api/admin/paper-types', { name: v })) } })),
      c.paper_types.map((p) => el('div', { class: 'row spread', style: 'margin:8px 0' }, el('span', { text: p.name + (p.active ? '' : ' (inactive)') }), el('div', { class: 'row' }, el('button', { class: 'btn ghost sm', text: 'Rename', on: { click: () => ask('Rename paper type', 'New name', (v) => G.put(`/api/admin/paper-types/${p.id}`, { name: v })) } }), toggle(`/api/admin/paper-types/${p.id}`, p))))));
    wrap.append(el('div', { class: 'card' }, el('h3', { text: 'Years' }), el('p', { class: 'muted', text: `Papers can be uploaded for ${c.year_min} to ${c.year_max}. A year only shows to students once it has published content. The Chief Administrator can change the range in Settings.` })));
    wrap.append(el('div', { class: 'card' }, el('h3', { text: 'Content types' }), el('p', { class: 'muted', text: c.content_types.map((t) => t.label).join(' · ') })));
    return U().page('Subjects and papers', wrap);
  };

  // ---------------------------------------------------------------- audit log
  G.views.adminAudit = async ({ query }) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
    const r = await G.get('/api/admin/audit' + (qs ? '?' + qs : ''));
    const scope = G.select([{ value: '', label: 'All records' }, { value: 'content', label: 'Content' }, { value: 'user', label: 'People and roles' }, ...(G.isMain() ? [{ value: 'security', label: 'Security' }] : [])], query.scope || '', { 'aria-label': 'Scope', on: { change: (e) => { location.hash = `#/admin/audit?${new URLSearchParams(e.target.value ? { scope: e.target.value } : {})}`; } } });
    return U().page('Audit log', el('p', { class: 'muted', text: 'Every privileged action is recorded here and cannot be edited or deleted.' }), el('div', { class: 'filters' }, field('Show', scope)),
      el('div', { class: 'card tablewrap' }, r.items.length ? el('table', null, el('thead', null, el('tr', null, ['When', 'Who', 'What', 'Details'].map((h) => el('th', { text: h })))),
        el('tbody', null, r.items.map((a) => el('tr', null, el('td', { text: G.fmtTime(a.created_at) }), el('td', { text: a.actor_name || 'system' }), el('td', null, a.action.replace(/_/g, ' '), a.target_type ? el('div', { class: 'hint', text: `${a.target_type} #${a.target_id || ''}` }) : null), el('td', { style: 'max-width:340px;word-break:break-word', text: (a.detail || '').slice(0, 220) }))))) : G.empty('No records')));
  };

  // ---------------------------------------------------------------- inbox + donations
  G.views.adminInbox = async ({ query }) => {
    const type = query.type || ''; const r = await G.get('/api/admin/inbox' + (type ? `?type=${type}` : '')); const d = await G.get('/api/admin/donations');
    const tabs = el('div', { class: 'sidenav' }, [['', 'All'], ['contact', 'Contact'], ['error_report', 'Error reports'], ['content_report', 'Content reports'], ['feedback', 'Feedback'], ['message_report', 'Chat reports']].map(([k, l]) => el('a', { href: `#/admin/inbox${k ? '?type=' + k : ''}`, 'aria-current': type === k ? 'page' : undefined, text: l })));
    const setStatus = async (it, status) => { const note = status === 'resolved' || status === 'dismissed' ? await G.promptBox(status === 'resolved' ? 'Resolve' : 'Dismiss', 'Note (optional)', { required: false, okLabel: 'Save' }) : ''; if (note === null) return; try { await G.put(`/api/admin/inbox/${it.id}`, { status, note }); G.refresh(); } catch (e) { toast(e.message, 'bad'); } };
    const items = r.items.map((it) => el('div', { class: 'card' }, el('div', { class: 'row spread' }, el('b', { text: it.subject || it.type.replace('_', ' ') }), el('span', { class: 'pill ' + (it.status === 'new' ? 'in_review' : it.status === 'resolved' ? 'published' : ''), text: it.status.replace('_', ' ') })),
      el('p', { class: 'muted', style: 'margin:2px 0 6px', text: `${it.type.replace('_', ' ')} · ${it.name || 'Anonymous'}${it.contact ? ' · ' + it.contact : ''} · ${G.fmtTime(it.created_at)}` }), el('p', { style: 'white-space:pre-wrap', text: it.message }),
      it.submission_id ? el('p', null, el('a', { href: `#/admin/content/${it.submission_id}`, text: 'Open the content' })) : null, it.handled_note ? el('p', { class: 'hint', text: `Note: ${it.handled_note}` }) : null,
      el('div', { class: 'row' }, it.status === 'new' ? el('button', { class: 'btn ghost sm', text: 'Start', on: { click: () => setStatus(it, 'in_progress') } }) : null, !['resolved', 'dismissed'].includes(it.status) ? [el('button', { class: 'btn sm', text: 'Resolve', on: { click: () => setStatus(it, 'resolved') } }), el('button', { class: 'btn ghost sm', text: 'Dismiss', on: { click: () => setStatus(it, 'dismissed') } })] : null)));
    return U().page('Inbox', tabs, items.length ? items : G.empty('Nothing here', 'Contact messages, error reports and feedback appear here.'),
      type ? null : el('div', { class: 'card' }, el('h3', { text: 'Donations' }), el('p', { text: `Confirmed total: D${d.confirmed_total}` }), d.items.length ? el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Date', 'Provider', 'Amount', 'Status'].map((h) => el('th', { text: h })))), el('tbody', null, d.items.map((x) => el('tr', null, el('td', { text: G.fmtDate(x.created_at) }), el('td', { text: x.provider }), el('td', { text: `D${x.amount_gmd}` }), el('td', { text: x.status })))))) : el('p', { class: 'muted', text: 'No donations recorded.' })));
  };

  // ---------------------------------------------------------------- settings + integrations
  G.views.adminSettings = async () => {
    if (!G.isMain()) return U().page('Settings', el('div', { class: 'notice', text: 'Only main administrators can see settings.' }));
    const [s, sys] = await Promise.all([G.get('/api/admin/settings'), G.get('/api/admin/system')]);
    const chief = G.me.role === 'chief'; const save = async (patch) => { try { await G.put('/api/admin/settings', patch); toast('Saved.', 'ok'); G.refresh(); } catch (e) { toast(e.message, 'bad'); G.refresh(); } };
    const toggle = (label, key, hint, disabled) => el('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:flex-start' }, el('input', { type: 'checkbox', checked: !!s[key], disabled: !chief || disabled, on: { change: (e) => save({ [key]: e.target.checked }) } }), el('span', null, el('b', { text: label }), el('div', { class: 'hint', text: hint })));
    const ys = el('input', { type: 'number', value: s.year_min, min: 1950, max: 2100, disabled: !chief, 'aria-label': 'First year' }); const ye = el('input', { type: 'number', value: s.year_max, min: 1950, max: 2100, disabled: !chief, 'aria-label': 'Last year' });
    const names = { ai: 'AI answer help and tutor', sms: 'SMS phone verification (+220)', wave: 'Wave donations', aps: 'APS donations', email: 'Email delivery', pdf_text: 'PDF text reading', ocr: 'Scanned-page reading (OCR)' };
    return U().page('Settings',
      !chief ? el('div', { class: 'notice', text: 'Only the Chief Administrator can change settings. You can view them.' }) : null,
      el('div', { class: 'card stack' }, el('h3', { text: 'Policies' }),
        toggle('Accept administrator applications', 'admin_recruitment_enabled', 'When off, the administrator application form is closed.'),
        toggle('Require SMS verification at sign-up', 'require_phone_verification', s.integrations.sms.configured ? 'Phone numbers must be verified when a student registers.' : 'Unavailable: no SMS provider is configured on this server.', !s.integrations.sms.configured),
        el('div', { class: 'row' }, el('div', null, field('First year', ys)), el('div', null, field('Last year', ye)), chief ? el('button', { class: 'btn sm', text: 'Save years', on: { click: () => save({ year_min: ys.value, year_max: ye.value }) } }) : null)),
      el('div', { class: 'card' }, el('h3', { text: 'Connected services' }), el('p', { class: 'muted', text: 'Set these on the server, not in the browser. A service that is not connected is never pretended to work.' }),
        el('div', { class: 'tablewrap' }, el('table', null, el('thead', null, el('tr', null, ['Service', 'Status', 'Needs'].map((h) => el('th', { text: h })))), el('tbody', null, Object.entries(s.integrations).map(([k, v]) => el('tr', null, el('td', { text: names[k] || k }), el('td', null, el('span', { class: 'pill ' + (v.configured ? 'published' : 'draft'), text: v.configured ? 'Connected' : 'Not connected' })), el('td', { class: 'hint', text: v.configured ? '' : v.needs }))))))),
      el('div', { class: 'card' }, el('h3', { text: 'System' }), el('dl', { class: 'kv' }, el('dt', { text: 'Uptime' }), el('dd', { text: `${Math.round(sys.uptime_s / 60)} minutes` }), el('dt', { text: 'Database size' }), el('dd', { text: `${(sys.db_bytes / 1048576).toFixed(2)} MB` }), el('dt', { text: 'Memory' }), el('dd', { text: `${sys.memory_mb} MB` }), el('dt', { text: 'Active sessions' }), el('dd', { text: String(sys.active_sessions) }), el('dt', { text: 'Node' }), el('dd', { text: sys.node }))));
  };

  const admins = { auth: true, roles: ['admin', 'main_admin', 'chief'] };
  G.route('/admin/applications', G.views.adminApplications, admins); G.route('/admin/users', G.views.adminUsers, admins); G.route('/admin/supervisors', G.views.adminSupervisors, admins);
  G.route('/admin/catalog', G.views.adminCatalog, admins); G.route('/admin/audit', G.views.adminAudit, admins); G.route('/admin/inbox', G.views.adminInbox, admins); G.route('/admin/settings', G.views.adminSettings, admins);
})(window.GES);
