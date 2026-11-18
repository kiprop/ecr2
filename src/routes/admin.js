const express = require('express');
const config = require('../config');
const db = require('../db');
const D = require('../domain');
const graph = require('../graph');

const r = express.Router();
r.use((req, res, next) => {
  if (!D.isAdmin(req.user)) return res.status(403).render('error', { title: 'Not allowed', message: 'Administration is for HQ Legal & Compliance administrators.' });
  next();
});

// ------------------------------------------------------------ users
r.get('/users', async (req, res) => {
  const role = req.query.role || 'all';
  const users = await db.q(`SELECT u.*, COALESCE(array_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS country_names
                            FROM users u LEFT JOIN user_countries uc ON uc.user_id=u.id LEFT JOIN countries c ON c.code=uc.country_code
                            GROUP BY u.id ORDER BY CASE u.status WHEN 'inactive' THEN 2 ELSE 1 END, u.name`);
  const counts = { all: users.length }; users.forEach((u) => { counts[u.role] = (counts[u.role] || 0) + 1; });
  const log = await db.q(`SELECT e.*, u.name AS who FROM events e LEFT JOIN users u ON u.id=e.user_id WHERE e.action LIKE 'user.%' OR e.action = 'signin.denied' ORDER BY e.at DESC LIMIT 30`);
  res.render('admin_users', { title: 'Users & access', nav: 'users', users: users.filter((u) => role === 'all' || u.role === role), role, counts, log });
});

r.get('/users/:id', async (req, res) => {
  const countries = await db.q(`SELECT * FROM countries ORDER BY name`);
  let target = { id: 'new', name: '', email: '', title: '', role: 'focal', status: 'invited', countries: [] };
  if (req.params.id !== 'new') {
    target = await db.one(`SELECT * FROM users WHERE id=$1`, [Number(req.params.id) || 0]);
    if (!target) return res.status(404).render('error', { title: 'Not found', message: 'No such user.' });
    target.countries = (await db.q(`SELECT country_code FROM user_countries WHERE user_id=$1`, [target.id])).map((x) => x.country_code);
  }
  res.render('admin_user_edit', { title: target.id === 'new' ? 'Invite a person' : 'Edit access', nav: 'users', target, countries, directory: config.directorySearch });
});

r.post('/users/:id', async (req, res) => {
  const b = req.body;
  const role = D.ROLES[b.role] ? b.role : null;
  const picked = [].concat(b.countries || []).map(String);
  const countries = role && D.ROLES[role].all ? [] : picked;
  const back = req.params.id === 'new' ? '/admin/users/new' : `/admin/users/${req.params.id}`;
  if (!role) { req.flash('Choose a role.'); return res.redirect(back); }
  if ((role === 'director' || role === 'focal') && !countries.length) { req.flash('Choose at least one country for this role.'); return res.redirect(back); }
  const names = countries.length ? (await db.q(`SELECT name FROM countries WHERE code = ANY($1) ORDER BY name`, [countries])).map((x) => x.name).join(', ') : 'all countries';

  if (req.params.id === 'new') {
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    if (!/^[^@\s]+@pedaids\.org$/.test(email)) { req.flash('Use an @pedaids.org email address. ECR is for EGPAF staff only.'); return res.redirect(back); }
    if (!name) { req.flash('Enter the person’s name.'); return res.redirect(back); }
    if (await db.one(`SELECT id FROM users WHERE email=$1`, [email])) { req.flash('That person already has an account. Edit it instead.'); return res.redirect('/admin/users'); }
    await db.tx(async (c) => {
      const u = await c.one(`INSERT INTO users (email, name, title, role, status) VALUES ($1,$2,$3,$4,'invited') RETURNING id`, [email, name, (b.title || '').slice(0, 200) || null, role]);
      for (const cc of countries) await c.q(`INSERT INTO user_countries VALUES ($1,$2)`, [u.id, cc]);
      await D.audit(req.user.id, 'user.invited', `invited ${name} as ${D.ROLES[role].label} for ${names}`, null, null, c);
    });
    await graph.sendMail(email, 'You have access to the EGPAF Compliance Registry (ECR 2.0)',
      `<p>Hello ${name},</p><p>${req.user.name} has given you access to ECR 2.0 as <b>${D.ROLES[role].label}</b> for ${names}.</p><p>Sign in with your EGPAF Microsoft account: <a href="${config.appBaseUrl}${config.basePath}/">${config.appBaseUrl}${config.basePath}/</a></p>`);
    req.flash(`Invitation recorded for ${email}. They sign in with their Microsoft account.`);
    return res.redirect('/admin/users');
  }

  const target = await db.one(`SELECT * FROM users WHERE id=$1`, [Number(req.params.id) || 0]);
  if (!target) return res.redirect('/admin/users');
  if (b.action === 'toggle') {
    if (target.id === req.user.id) { req.flash('You cannot deactivate yourself.'); return res.redirect(back); }
    const next = target.status === 'inactive' ? 'active' : 'inactive';
    await db.q(`UPDATE users SET status=$2 WHERE id=$1`, [target.id, next]);
    if (next === 'inactive') await db.q(`DELETE FROM session WHERE sess->>'userId' = $1`, [String(target.id)]).catch(() => {});
    await D.audit(req.user.id, next === 'inactive' ? 'user.deactivated' : 'user.reactivated', `${next === 'inactive' ? 'deactivated' : 'reactivated'} ${target.name}`);
    req.flash(next === 'inactive' ? `${target.name} can no longer sign in.` : `${target.name} can sign in again.`);
    return res.redirect('/admin/users');
  }
  if (target.id === req.user.id && role !== 'admin') { req.flash('You cannot remove your own administrator role.'); return res.redirect(back); }
  await db.tx(async (c) => {
    await c.q(`UPDATE users SET role=$2, title=$3 WHERE id=$1`, [target.id, role, (b.title || '').slice(0, 200) || null]);
    await c.q(`DELETE FROM user_countries WHERE user_id=$1`, [target.id]);
    for (const cc of countries) await c.q(`INSERT INTO user_countries VALUES ($1,$2)`, [target.id, cc]);
    await D.audit(req.user.id, 'user.changed', `set ${target.name} to ${D.ROLES[role].label} for ${names}`, null, null, c);
  });
  req.flash('Access updated. It applies on their next page load.');
  res.redirect('/admin/users');
});

r.get('/directory', async (req, res) => {
  if (!config.directorySearch) return res.json([]);
  try { res.json(await graph.searchUsers(String(req.query.q || ''))); } catch (e) { console.error('[directory]', e.message); res.json([]); }
});

// ------------------------------------------------------------ templates
r.get('/templates', async (req, res) => {
  const phase = ['setup', 'annual', 'close'].includes(req.query.phase) ? req.query.phase : 'annual';
  const items = await db.q(`SELECT * FROM templates WHERE phase=$1 ORDER BY active DESC, seq`, [phase]);
  const locals = await db.q(`SELECT l.*, c.name AS country_name FROM template_local l JOIN countries c ON c.code=l.country_code JOIN templates t ON t.id=l.template_id WHERE t.phase=$1`, [phase]);
  const countries = await db.q(`SELECT code, name FROM countries ORDER BY name`);
  res.render('admin_templates', { title: 'Templates', nav: 'templates', phase, items, locals, countries, stages: D.CLOSE_STAGES });
});

r.post('/templates', async (req, res) => {
  const b = req.body; const phase = ['setup', 'annual', 'close'].includes(b.phase) ? b.phase : 'annual';
  if (b.action === 'add') {
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) { req.flash('Type the requirement first.'); return res.redirect(`/admin/templates?phase=${phase}`); }
    const n = await db.one(`SELECT COALESCE(max(seq),0)+1 AS n FROM templates WHERE phase=$1`, [phase]);
    await db.q(`INSERT INTO templates (phase, seq, text, due_days, stage) VALUES ($1,$2,$3,$4,$5)`, [phase, n.n, text, Number(b.due_days) || 90, phase === 'close' ? (Number(b.stage) || 4) : null]);
    await D.audit(req.user.id, 'template.added', `${phase}: ${text}`);
    req.flash('Added. It applies from each country’s next cycle or plan.');
  }
  if (b.action === 'save') {
    await db.q(`UPDATE templates SET text=$2, due_days=$3 WHERE id=$1`, [b.id, String(b.text || '').trim().slice(0, 500), Number(b.due_days) || 90]);
    await D.audit(req.user.id, 'template.edited', `${phase} #${b.id}: ${b.text}`);
    req.flash('Template item saved.');
  }
  if (b.action === 'toggle') {
    await db.q(`UPDATE templates SET active = NOT active WHERE id=$1`, [b.id]);
    await D.audit(req.user.id, 'template.toggled', `${phase} #${b.id}`);
    req.flash('Template item updated.');
  }
  if (b.action === 'local') {
    const text = String(b.text || '').trim().slice(0, 500);
    if (text) await db.q(`INSERT INTO template_local VALUES ($1,$2,$3) ON CONFLICT (template_id, country_code) DO UPDATE SET text=EXCLUDED.text`, [b.id, b.country, text]);
    else await db.q(`DELETE FROM template_local WHERE template_id=$1 AND country_code=$2`, [b.id, b.country]);
    await D.audit(req.user.id, 'template.localised', `${b.country} #${b.id}: ${text || '(removed)'}`);
    req.flash('Local wording saved.');
  }
  res.redirect(`/admin/templates?phase=${phase}`);
});

// ------------------------------------------------------------ countries
r.get('/countries', async (req, res) => {
  const countries = await db.q(`SELECT * FROM countries ORDER BY name`);
  res.render('admin_countries', { title: 'Countries', nav: 'admin-countries', countries });
});
r.post('/countries', async (req, res) => {
  const b = req.body; const code = String(b.code || '').trim().toUpperCase();
  const fields = [String(b.name || '').trim(), b.entity_type || null, b.authority || null, b.registered_on || null, b.currency || null];
  if (b.action === 'add') {
    if (!/^[A-Z]{3}$/.test(code) || !fields[0]) { req.flash('Give a 3-letter code (e.g. ZMB) and a name.'); return res.redirect('/admin/countries'); }
    const phase = b.phase === 'establish' ? 'establish' : 'operate';
    await db.tx(async (c) => {
      await c.q(`INSERT INTO countries (code, name, phase, entity_type, authority, registered_on, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [code, ...fields.slice(0, 1), phase, ...fields.slice(1)]);
      await D.audit(req.user.id, 'country.added', `${fields[0]} added in ${phase}`, code, null, c);
      if (phase === 'establish') await D.openPlan(c, code, 'setup', 'Registration', req.user.id);
      else { const s = await D.getSettings(); await D.openPlan(c, code, 'annual', D.fyLabel(D.todayISO(), s.cycle_month), req.user.id); }
    });
    req.flash(`${fields[0]} added.`);
  } else if (b.action === 'save') {
    await db.q(`UPDATE countries SET name=$2, entity_type=$3, authority=$4, registered_on=$5, currency=$6 WHERE code=$1`, [code, ...fields]);
    await D.audit(req.user.id, 'country.edited', fields[0], code);
    req.flash('Country saved.');
  }
  res.redirect('/admin/countries');
});

// ------------------------------------------------------------ settings
r.get('/settings', async (req, res) => {
  const s = await D.getSettings();
  const cycles = await db.q(`SELECT label, count(*)::int n, sum(CASE WHEN status='signed_off' THEN 1 ELSE 0 END)::int signed FROM cycles WHERE kind='annual' GROUP BY label ORDER BY label DESC`);
  res.render('admin_settings', { title: 'Settings', nav: 'settings', s, cycles, nextLabel: D.fyLabel(D.todayISO(), s.cycle_month), mail: graph.mailMode() !== 'log', mailMode: graph.mailMode(), mailFrom: config.mail.sender || (config.mail.smtp && config.mail.smtp.from) || '' });
});
r.post('/settings', async (req, res) => {
  const b = req.body;
  if (b.action === 'test_mail') {
    try {
      const r = await graph.sendMail(req.user.email, 'ECR 2.0 test email', `<p>This is a test from ECR 2.0, sent by ${graph.mailMode().toUpperCase()}. If you can read it, reminders will be delivered.</p>`, { throwOnError: true });
      req.flash(r === 'logged' ? 'Email is not configured, so the test was only logged.' : `Test email sent to ${req.user.email}. Check your inbox.`);
    } catch (e) {
      const msg = String(e.message || e);
      req.flash(/SmtpClientAuthentication is disabled|5\.7\.139/i.test(msg)
        ? 'Sending failed: Microsoft 365 has SMTP sign-in turned off for this mailbox. Ask IT to enable Authenticated SMTP for it, or to grant the app Mail.Send.'
        : /535|Authentication/i.test(msg) ? 'Sending failed: the mailbox rejected the username or password (or MFA blocks it). Check SMTP_USER and SMTP_PASSWORD.'
        : 'Sending failed: ' + msg.slice(0, 200));
    }
    await D.audit(req.user.id, 'settings.mail_test', graph.mailMode());
    return res.redirect('/admin/settings');
  }
  if (b.action === 'open_cycle') {
    const label = String(b.label || '').trim().slice(0, 20);
    const out = await D.openAnnualCycles(req.user.id, label || null);
    await D.syncAll();
    req.flash(out.opened ? `${out.label} opened for ${out.opened} countries.` : `${out.label} is already open everywhere.`);
    return res.redirect('/admin/settings');
  }
  const lead = [].concat(b.lead_days || []).map(Number).filter((n) => n > 0).sort((a, c) => c - a);
  const vals = { lead_days: lead, digest: b.digest === 'on', cycle_month: Math.min(12, Math.max(1, Number(b.cycle_month) || 10)), horizon_days: Math.min(730, Math.max(30, Number(b.horizon_days) || 180)), coi_due_days: Math.max(1, Number(b.coi_due_days) || 30) };
  for (const [k, v] of Object.entries(vals)) await db.q(`INSERT INTO settings VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]);
  await D.audit(req.user.id, 'settings.saved', JSON.stringify(vals));
  await D.syncAll();
  req.flash('Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = r;
