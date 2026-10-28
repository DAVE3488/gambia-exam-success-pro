'use strict';
(function (G) {
  const { el, field, submitting, toast } = G;
  const NS = 'http://www.w3.org/2000/svg';

  function riverSvg() {
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'river'); s.setAttribute('viewBox', '0 0 400 800'); s.setAttribute('preserveAspectRatio', 'xMidYMid slice'); s.setAttribute('aria-hidden', 'true');
    const p = (d, a) => { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); s.appendChild(e); };
    // the river's banks and a slow current, kept low-contrast so text stays the focus
    p('M-20 620C60 560 90 470 170 450S300 470 330 380 280 220 340 120 420 40 440 -20', { fill: 'none', stroke: '#13315C', 'stroke-width': 150, 'stroke-linecap': 'round', opacity: '.9' });
    p('M-20 620C60 560 90 470 170 450S300 470 330 380 280 220 340 120 420 40 440 -20', { fill: 'none', stroke: '#1E4A82', 'stroke-width': 70, 'stroke-linecap': 'round', opacity: '.55' });
    p('M-20 620C60 560 90 470 170 450S300 470 330 380 280 220 340 120 420 40 440 -20', { class: 'flow', fill: 'none', stroke: '#D9A21B', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': '2 14', opacity: '.8' });
    p('M-20 700C80 650 130 560 210 540S350 560 400 470', { fill: 'none', stroke: '#D9A21B', 'stroke-width': 1.5, opacity: '.35' });
    return s;
  }

  G.views.welcome = () => {
    const w = el('div', { class: 'welcome' },
      riverSvg(),
      el('div', { class: 'bar-top' },
        el('a', { class: 'brand', href: '#/welcome' }, G.logo(), el('span', { text: 'Gambia Exam Success' })),
        el('a', { class: 'staff', href: '#/staff', 'aria-label': 'Staff access' }, G.icon('staff'), el('span', { text: 'Staff' }))),
      el('div', { class: 'hero' },
        el('h1', { text: 'Gambia Exam Success' }),
        el('p', { class: 'slogan', text: 'Learn today. Succeed tomorrow.' }),
        el('p', { class: 'tagline', text: 'A brighter future for Gambian students' }),
        el('p', { class: 'mark', text: '~j pro' }),
        el('p', { style: 'color:#c9d8ee;max-width:46ch', text: 'Practise GABECE and WASSCE past questions with checked answers, step-by-step explanations and your own progress record. Free for every student.' }),
        el('div', { class: 'cta' },
          el('a', { class: 'btn gold', href: '#/register' }, 'Create student account'),
          el('a', { class: 'btn outline-light', href: '#/login' }, 'Log in'))),
      el('div', { class: 'foot' },
        el('a', { href: '#/about', text: 'About' }), el('a', { href: '#/contact', text: 'Contact and support' }), el('a', { href: '#/donate', text: 'Support us' }), el('a', { href: '#/staff', text: 'Staff access' })));
    return { fullscreen: w };
  };

  function plainPage(title, ...content) {
    return { fullscreen: el('div', null,
      el('header', { class: 'top' }, el('a', { class: 'brand', href: G.me ? '#/' : '#/welcome' }, G.logo(), el('span', { text: 'Gambia Exam Success' })),
        el('div', { class: 'right' }, G.me ? el('a', { class: 'linkbtn', href: '#/', text: 'Back to app' }) : el('a', { class: 'linkbtn', href: '#/login', text: 'Log in' }))),
      el('main', { id: 'app' }, el('h1', { text: title }), content)) };
  }

  // ---------------------------------------------------------------- auth
  function afterLogin() {
    const next = sessionStorage.getItem('ges_next'); sessionStorage.removeItem('ges_next');
    location.hash = next && next !== '#/login' ? next : '#/';
  }
  G.views.login = () => {
    if (G.me) { location.hash = '#/'; return { body: el('div') }; }
    const err = el('div', { class: 'err', role: 'alert' });
    const id = el('input', { type: 'text', autocomplete: 'username', inputmode: 'email', required: true });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Log in' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      const r = await G.post('/api/auth/login', { identifier: id.value, password: pw.value });
      G.me = r.user; await G.loadMe(); afterLogin();
    }, err); } } }, field('Email or phone number', id, 'Phone numbers: +220 followed by 7 digits.'), field('Password', pw), err, el('div', { style: 'margin-top:16px' }, btn));
    return { fullscreen: el('div', null,
      el('header', { class: 'top' }, el('a', { class: 'brand', href: '#/welcome' }, G.logo(), el('span', { text: 'Gambia Exam Success' }))),
      el('main', { id: 'app' }, el('div', { class: 'authwrap' },
        G.sessionExpired && el('div', { class: 'notice', text: 'You were logged out after five hours of inactivity. Please log in again.' }),
        G.blocked && el('div', { class: 'notice bad', text: 'This account has been blocked. Contact support if you think this is a mistake.' }),
        el('div', { class: 'card' }, el('h1', { text: 'Log in' }), form,
          el('p', { style: 'margin-top:16px' }, el('a', { href: '#/forgot', text: 'Forgot your password?' })),
          el('p', null, 'New here? ', el('a', { href: '#/register', text: 'Create a student account' }), '. Teacher or supervisor? ', el('a', { href: '#/staff', text: 'Staff access' }), '.')))) ) };
  };

  G.views.register = () => {
    if (G.me) { location.hash = '#/'; return { body: el('div') }; }
    const err = el('div', { class: 'err', role: 'alert' });
    const name = el('input', { type: 'text', autocomplete: 'name', required: true });
    const school = el('input', { type: 'text', autocomplete: 'organization', required: true });
    const email = el('input', { type: 'email', autocomplete: 'email' });
    const phone = el('input', { type: 'tel', autocomplete: 'tel', placeholder: '+220 …' });
    const pw = el('input', { type: 'password', autocomplete: 'new-password', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Create account' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      if (!email.value.trim() && !phone.value.trim()) throw new Error('Enter an email address or a Gambian phone number.');
      await G.post('/api/auth/register', { full_name: name.value, school: school.value, email: email.value, phone: phone.value, password: pw.value });
      await G.loadMe(); toast('Welcome! Your account is ready.', 'ok'); afterLogin();
    }, err); } } },
      field('Full name', name), field('School', school), field('Email address', email), field('Gambian phone number', phone, 'Use an email, a phone number, or both. You will log in with either.'),
      field('Password', pw, 'At least 8 characters, with a letter and a number.'), err, el('div', { style: 'margin-top:16px' }, btn));
    return { fullscreen: el('div', null,
      el('header', { class: 'top' }, el('a', { class: 'brand', href: '#/welcome' }, G.logo(), el('span', { text: 'Gambia Exam Success' }))),
      el('main', { id: 'app' }, el('div', { class: 'authwrap' }, el('div', { class: 'card' }, el('h1', { text: 'Create your student account' }),
        el('p', { class: 'muted', text: 'Free for every student. Your progress is saved to your account and follows you to any device.' }), form,
        el('p', { class: 'hint', style: 'margin-top:12px', text: 'Phone number verification by SMS is not switched on yet, so numbers are not verified at sign-up.' }),
        el('p', { style: 'margin-top:12px' }, 'Already registered? ', el('a', { href: '#/login', text: 'Log in' }), '.')))) ) };
  };

  G.views.forgot = () => {
    const err = el('div', { class: 'err' }); const out = el('div');
    const id = el('input', { type: 'text', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Request reset link' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      const r = await G.post('/api/auth/forgot', { identifier: id.value }); G.clear(out).append(el('div', { class: 'notice ok', text: r.message }));
    }, err); } } }, field('Your email or phone number', id), err, el('div', { style: 'margin-top:16px' }, btn));
    return plainPage('Recover your account', el('div', { class: 'authwrap card' },
      el('p', { text: 'Email delivery is not set up yet. Send a request and an administrator will give you a one-time link to choose a new password.' }), form, out,
      el('p', { style: 'margin-top:12px' }, el('a', { href: '#/login', text: 'Back to log in' }))));
  };

  G.views.reset = ({ token }) => {
    const err = el('div', { class: 'err' }); const pw = el('input', { type: 'password', autocomplete: 'new-password', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Set new password' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      await G.post('/api/auth/reset', { token, password: pw.value }); toast('Password changed. Please log in.', 'ok'); location.hash = '#/login';
    }, err); } } }, field('New password', pw, 'At least 8 characters, with a letter and a number.'), err, el('div', { style: 'margin-top:16px' }, btn));
    return plainPage('Choose a new password', el('div', { class: 'authwrap card' }, form));
  };

  // ---------------------------------------------------------------- about / contact / donate
  G.views.about = () => plainPage('About Gambia Exam Success',
    el('p', { class: 'slogan', style: 'font:italic 1.2rem var(--serif);color:var(--navy3)', text: 'Learn today. Succeed tomorrow.' }),
    el('div', { class: 'card' },
      el('p', { text: 'Gambia Exam Success helps students in The Gambia prepare for GABECE (Grade 9) and WASSCE (Grade 12). Students practise with real past examination questions, see worked explanations and model answers, and watch their own progress improve.' }),
      el('h3', { text: 'Accuracy comes first' }),
      el('p', { text: 'Nothing is published automatically. Every paper is uploaded by an administrator, compared with the original by a subject supervisor, approved by an administrator, and then published as a separate step. The people who reviewed and approved each paper are named at the top of it.' }),
      el('p', { text: 'Past papers, teacher-prepared practice and AI-generated help are always labelled, so you know what you are looking at. Answers that have not been checked by a person are never presented as official.' }),
      el('h3', { text: 'Free for students' }),
      el('p', { text: 'Learning and practice are free. Donations are optional and help with hosting and content.' }),
      el('h3', { text: 'Who it is for' }),
      el('p', { text: 'Students, teachers, subject supervisors and school communities across The Gambia.' }),
      el('p', { class: 'mark', style: 'font:700 1rem var(--serif);color:var(--gold-d)', text: '~j pro' }),
      el('div', { class: 'row' }, el('a', { class: 'btn', href: '#/register', text: 'Create student account' }), el('a', { class: 'btn ghost', href: '#/contact', text: 'Contact us' }))));

  G.views.contact = () => {
    const err = el('div', { class: 'err' }); const done = el('div');
    const name = el('input', { type: 'text', value: G.me ? G.me.full_name : '' });
    const contact = el('input', { type: 'text', value: G.me ? (G.me.email || G.me.phone || '') : '', required: true });
    const subject = el('input', { type: 'text', required: true }); const msg = el('textarea', { required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Send message' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      await G.post('/api/contact', { name: name.value, contact: contact.value, subject: subject.value, message: msg.value });
      G.clear(done).append(el('div', { class: 'notice ok', text: 'Message sent. We will reply to the contact details you gave.' })); form.reset();
    }, err); } } }, field('Your name', name), field('Your email or phone number', contact, 'So we can reply to you.'), field('Subject', subject), field('Message', msg), err, el('div', { style: 'margin-top:16px' }, btn));
    return plainPage('Contact and support',
      el('div', { class: 'card' }, el('p', null, 'Email the Chief Administrator: ', el('a', { href: 'mailto:jprothereal@gmail.com', text: 'jprothereal@gmail.com' }), '.'), el('p', { class: 'muted', text: 'Or send a message below. Staff review every message.' }), form, done),
      G.me && el('div', { class: 'card' }, el('h3', { text: 'Report a problem or send feedback' }), reportForm()));
  };

  function reportForm() {
    const err = el('div', { class: 'err' });
    const type = G.select([{ value: 'feedback', label: 'General feedback' }, { value: 'error_report', label: 'A technical problem' }, { value: 'content_report', label: 'Inappropriate content' }], 'feedback');
    const msg = el('textarea', { required: true }); const btn = el('button', { class: 'btn ghost', type: 'submit', text: 'Send report' });
    return el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => { await G.post('/api/report', { type: type.value, message: msg.value }); toast('Thank you. Staff will review this.', 'ok'); msg.value = ''; }, err); } } },
      field('What is this about?', type), field('Details', msg), err, el('div', { style: 'margin-top:12px' }, btn));
  }

  G.views.donate = async () => {
    const o = await G.get('/api/donate/options');
    let amount = null; let provider = null;
    const custom = el('input', { type: 'number', min: 1, placeholder: 'Other amount in D', 'aria-label': 'Custom amount in dalasi' });
    const err = el('div', { class: 'err' });
    const amtRow = el('div', { class: 'row', role: 'group', 'aria-label': 'Donation amount' });
    const provRow = el('div', { class: 'row', role: 'group', 'aria-label': 'Payment method' });
    const draw = () => {
      G.clear(amtRow).append(o.amounts.map((a) => el('button', { type: 'button', class: 'btn ' + (amount === a ? 'gold' : 'ghost'), 'aria-pressed': amount === a, on: { click: () => { amount = a; custom.value = ''; draw(); } }, text: `D${a}` })), custom);
      G.clear(provRow).append(o.providers.map((p) => el('button', { type: 'button', class: 'btn ' + (provider === p.id ? 'gold' : 'ghost'), 'aria-pressed': provider === p.id, on: { click: () => { provider = p.id; draw(); } }, text: p.name + (p.available ? '' : ' (not set up yet)') })));
    };
    custom.addEventListener('input', () => { amount = Number(custom.value) || null; });
    draw();
    const btn = el('button', { class: 'btn', text: 'Donate' });
    btn.addEventListener('click', () => submitting(btn, async () => {
      if (!amount) throw new Error('Choose or enter an amount.'); if (!provider) throw new Error('Choose Wave or APS.');
      await G.post('/api/donate/initiate', { provider, amount });
    }, err));
    return plainPage('Support Gambia Exam Success',
      el('div', { class: 'card' },
        el('p', { text: 'Learning on Gambia Exam Success is free. If you would like to help with hosting, development and new content, you can give a small amount. It is always optional.' }),
        o.note && el('div', { class: 'notice', text: o.note }),
        el('h3', { text: 'Amount (dalasi)' }), amtRow, el('h3', { style: 'margin-top:16px', text: 'Pay with' }), provRow, err,
        el('p', { class: 'hint', style: 'margin-top:12px', text: 'No screenshots are needed. A donation is only counted once the payment provider confirms it.' }),
        el('div', { style: 'margin-top:12px' }, btn)));
  };

  // ---------------------------------------------------------------- staff entry + applications
  G.views.staff = () => {
    const role = G.me && G.me.role;
    const apps = G.applications || [];
    const open = (k) => apps.find((a) => a.kind === k && ['pending', 'info_requested'].includes(a.status));
    const card = (kind, title, text) => el('div', { class: 'card' }, el('h3', { text: title }), el('p', { class: 'muted', text }),
      open(kind) ? el('div', { class: 'notice', text: open(kind).status === 'info_requested' ? 'The administrators asked for more information. Check your alerts.' : 'Your application is waiting for review.' })
        : el('a', { class: 'btn', href: `#/apply/${kind}`, text: `Apply as ${title.toLowerCase()}` }));
    return plainPage('Staff access',
      el('p', { text: 'Teachers, subject supervisors and administrators need approval before they get any extra access. Applications are reviewed by administrators.' }),
      !G.me && el('div', { class: 'card' }, el('h3', { text: 'Already approved?' }), el('a', { class: 'btn', href: '#/login', text: 'Staff log in' }),
        el('p', { class: 'hint', style: 'margin-top:8px', text: 'To apply you need an account first. Register, then return here.' })),
      el('div', { class: 'grid g2' },
        card('teacher', 'Teacher', 'Submit questions, notes and practice material, run classes, and set assignments.'),
        card('supervisor', 'Subject supervisor', 'Review papers and answers in your subjects against the original source. Choose two to four subjects.'),
        role !== 'admin' && card('admin', 'Administrator', 'Upload and manage content and approve staff. Only open when administrator recruitment is switched on.')));
  };

  G.views.apply = async ({ kind }) => {
    if (!['teacher', 'supervisor', 'admin'].includes(kind)) return G.views.notFound();
    const cat = await G.get('/api/library/exams');
    const chosen = new Set(); const max = kind === 'supervisor' ? 4 : 50; const min = kind === 'supervisor' ? 2 : 1;
    const counter = el('p', { class: 'hint' });
    const upd = () => { counter.textContent = kind === 'admin' ? '' : `${chosen.size} selected. ${kind === 'supervisor' ? 'Choose 2 to 4 subjects you are qualified to review.' : 'Choose the subjects you teach.'}`; };
    const subjectBox = kind === 'admin' ? null : el('div', null, cat.exams.map((e) => el('details', { open: true }, el('summary', { style: 'font-weight:700;margin:8px 0', text: `${e.name} — ${e.grade}` }),
      el('div', { class: 'grid g2' }, e.subjects.map((s) => el('label', { style: 'font-weight:400;margin:2px 0;display:flex;align-items:center' },
        el('input', { type: 'checkbox', on: { change: (ev) => { if (ev.target.checked) { if (chosen.size >= max) { ev.target.checked = false; toast(`You can choose at most ${max} subjects.`, 'bad'); return; } chosen.add(s.id); } else chosen.delete(s.id); upd(); } } }), s.name))))));
    upd();
    const qual = el('textarea', { required: true, placeholder: 'Degrees, certificates, examiner or marking experience…' });
    const exp = el('textarea'); const inst = el('input', { type: 'text' }); const msg = el('textarea');
    const err = el('div', { class: 'err', role: 'alert' }); const btn = el('button', { class: 'btn', type: 'submit', text: 'Submit application' });
    const form = el('form', { on: { submit: (e) => { e.preventDefault(); submitting(btn, async () => {
      if (kind !== 'admin' && chosen.size < min) throw new Error(kind === 'supervisor' ? 'Supervisor applicants must select at least two subject areas.' : 'Select at least one subject.');
      await G.post('/api/applications', { kind, subject_ids: [...chosen], qualifications: qual.value, experience: exp.value, institution: inst.value, message: msg.value });
      await G.loadMe(); toast('Application submitted. You will be notified of the decision.', 'ok'); location.hash = '#/staff';
    }, err); } } },
      subjectBox && el('h3', { text: 'Subjects' }), subjectBox, counter,
      field('Qualifications', qual), field('Experience', exp), field('School or institution', inst), field('Anything else we should know', msg), err, el('div', { style: 'margin-top:16px' }, btn));
    return plainPage(`Apply as ${kind === 'supervisor' ? 'subject supervisor' : kind}`, el('div', { class: 'card' }, form));
  };

  G.views.notFound = () => ({ body: el('div', { class: 'card' }, G.empty('Page not found', 'The page you opened does not exist.', el('a', { class: 'btn', href: '#/', text: 'Go home' }))) });

  const open = { auth: false };
  G.route('/welcome', G.views.welcome, open); G.route('/login', G.views.login, open); G.route('/register', G.views.register, open);
  G.route('/forgot', G.views.forgot, open); G.route('/reset/:token', G.views.reset, open);
  G.route('/about', G.views.about, open); G.route('/contact', G.views.contact, open); G.route('/donate', G.views.donate, open);
  G.route('/staff', G.views.staff, open); G.route('/apply/:kind', G.views.apply, { auth: true });
})(window.GES);
