const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const D = require('../domain');
const graph = require('../graph');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const dir = path.join(config.storageDir, new Date().toISOString().slice(0, 7)); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = function appRoutes(csrfCheck) {
  const r = express.Router();
  const bp = config.basePath;
  const rel = (req) => req.originalUrl.slice(bp.length) || '/';
  const withQuery = (relUrl, changes) => {
    const u = new URL(relUrl, 'http://x');
    Object.entries(changes).forEach(([k, v]) => (v === null || v === undefined || v === '' ? u.searchParams.delete(k) : u.searchParams.set(k, v)));
    return u.pathname + (u.search || '');
  };
  const safeReturn = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');
  const inScope = (req, code) => req.scope && req.scope.includes(code);
  const canPrepareIn = (req, code) => D.isPreparer(req.user) && inScope(req, code);

  // ------------------------------------------------------------ shared loaders
  async function countriesInScope(req) {
    return db.q(`SELECT * FROM countries WHERE code = ANY($1) ORDER BY name`, [req.scope]);
  }
  async function obligationsInScope(req, where = 'TRUE', params = []) {
    return db.q(`SELECT o.*, c.name AS country_name FROM obligations o JOIN countries c ON c.code=o.country_code
                 WHERE o.country_code = ANY($1) AND ${where} ORDER BY o.due_date NULLS LAST, o.id`, [req.scope, ...params]);
  }
  async function countryStats(req) {
    const countries = await countriesInScope(req);
    const obs = await obligationsInScope(req, `(o.cycle_id IS NULL OR o.cycle_id IN (SELECT DISTINCT ON (country_code, kind) id FROM cycles ORDER BY country_code, kind, opened_on DESC, id DESC))`);
    const cycles = await db.q(`SELECT DISTINCT ON (country_code) * FROM cycles WHERE kind='annual' ORDER BY country_code, opened_on DESC, id DESC`);
    return countries.map((c) => {
      const mine = obs.filter((o) => o.country_code === c.code).map((o) => D.decorate(o, c.name));
      const cyc = cycles.find((x) => x.country_code === c.code);
      const annual = mine.filter((o) => o.area === 'annual');
      const done = annual.filter((o) => o.status === 'accepted' || o.status === 'na').length;
      const waiting = annual.filter((o) => o.status === 'submitted').length;
      const overdue = mine.filter((o) => o.statusKey === 'overdue').length;
      const review = mine.filter((o) => o.status === 'submitted').length;
      const open = mine.filter((o) => o.isOpen && o.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
      let pct; let progress;
      if (c.phase === 'establish') { const s = mine.filter((o) => o.area === 'setup'); const sd = s.filter((o) => o.status === 'accepted').length; pct = s.length ? Math.round(sd / s.length * 100) : 0; progress = `${sd} of ${s.length} set-up steps`; }
      else if (c.phase === 'close' && c.close_status === 'running') { const s = mine.filter((o) => o.area === 'close'); const sd = s.filter((o) => o.status === 'accepted').length; pct = s.length ? Math.round(sd / s.length * 100) : 0; progress = `${sd} of ${s.length} close-out steps`; }
      else if (c.phase === 'closed') { pct = 100; progress = 'Closed'; }
      else { pct = annual.length ? Math.round(done / annual.length * 100) : 0; progress = cyc ? `${done} of ${annual.length} · ${cyc.label}` : 'No cycle open'; }
      return {
        ...c, phaseLabel: D.PHASES[c.phase][0], phaseCls: D.PHASES[c.phase][1], pct, progress, overdue, review, done, waiting, annualTotal: annual.length,
        cycle: cyc, signed: cyc && cyc.status === 'signed_off',
        next: open.length ? `${open[0].title.split(':')[0]} · ${D.fmtShort(open[0].due_date)}` : 'Nothing open',
        flag: overdue ? `${overdue} overdue` : (review ? `${review} with HQ` : 'On track'),
      };
    });
  }

  // Drawer for ?item=ID on any page
  r.use(async (req, res, next) => {
    try {
      res.locals.rel = rel(req);
      res.locals.withItem = (id) => withQuery(rel(req), { item: id });
      res.locals.withQuery = (ch) => withQuery(rel(req), ch);
      res.locals.drawer = null;
      if (req.method !== 'GET' || !req.query.item || !req.user) return next();
      const o = await db.one(`SELECT o.*, c.name AS country_name FROM obligations o JOIN countries c ON c.code=o.country_code WHERE o.id=$1`, [Number(req.query.item) || 0]);
      if (!o || !inScope(req, o.country_code)) return next();
      const docs = await db.q(`SELECT d.*, u.name AS by_name FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE obligation_id=$1 ORDER BY uploaded_at DESC`, [o.id]);
      const events = await db.q(`SELECT e.*, u.name AS who FROM events e LEFT JOIN users u ON u.id=e.user_id WHERE obligation_id=$1 ORDER BY at DESC`, [o.id]);
      const dec = D.decorate(o);
      // For HQ looking at an item the country has not submitted: who is responsible for it
      const team = D.canReview(req.user) ? await db.q(`SELECT u.name, u.role FROM users u JOIN user_countries uc ON uc.user_id=u.id WHERE uc.country_code=$1 AND u.role IN ('director','focal') AND u.status<>'inactive' ORDER BY u.role, u.name`, [o.country_code]) : [];
      res.locals.drawer = {
        team, hqWaiting: D.canReview(req.user) && dec.isOpen && o.status !== 'submitted' && o.area !== 'close',
        o: dec, docs, events, fields: D.fieldsFor(o), payload: o.payload || {},
        canSubmit: canPrepareIn(req, o.country_code) && dec.isOpen && o.area !== 'close',
        canReview: D.canReview(req.user) && o.status === 'submitted',
        canNA: o.area === 'annual',
        closeHref: withQuery(rel(req), { item: null }),
        changeDef: o.change_type ? D.CHANGES[o.change_type] : null,
      };
      next();
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------ home / overview
  r.get('/', async (req, res) => {
    if (!D.isPreparer(req.user)) return res.redirect(req.query.item ? `/review?item=${encodeURIComponent(req.query.item)}` : '/overview');
    const stats = await countryStats(req);
    const obs = (await obligationsInScope(req, `o.status IN ('todo','returned','submitted')`)).map((o) => D.decorate(o));
    const rank = (o) => (o.status === 'returned' ? -100000 : 0) + (o.days === null ? 99999 : o.days);
    const open = obs.filter((o) => o.isOpen && o.due_date);
    const needs = open.filter((o) => o.days <= 90 || o.status === 'returned').sort((a, b) => rank(a) - rank(b));
    const overdue = open.filter((o) => o.statusKey === 'overdue').length;
    const signoff = req.user.role === 'director' ? stats.filter((c) => c.cycle && c.cycle.status === 'open' && c.annualTotal && c.done === c.annualTotal) : [];
    res.render('home', {
      title: 'Home', nav: 'home', stats, needs, later: open.length - needs.length, overdue,
      waiting: obs.filter((o) => o.status === 'submitted'), signoff, changes: D.CHANGES, multi: req.scope.length > 1,
    });
  });

  r.get('/overview', async (req, res) => {
    const stats = await countryStats(req);
    const phase = req.query.phase || 'all';
    const obs = (await obligationsInScope(req, `o.status IN ('todo','returned','submitted')`)).map((o) => D.decorate(o));
    const operating = stats.filter((c) => c.phase === 'operate' || c.phase === 'close');
    res.render('overview', {
      title: 'Overview', nav: 'overview', phase,
      rows: stats.filter((c) => phase === 'all' || c.phase === phase),
      kpi: {
        review: obs.filter((o) => o.status === 'submitted').length,
        overdue: obs.filter((o) => o.statusKey === 'overdue').length,
        due30: obs.filter((o) => o.isOpen && o.days !== null && o.days >= 0 && o.days <= 30).length,
        signed: operating.filter((c) => c.signed).length, operating: operating.length,
      },
    });
  });

  r.get('/countries', async (req, res) => {
    const stats = await countryStats(req);
    if (stats.length === 1 && D.isPreparer(req.user)) return res.redirect(`/countries/${stats[0].code}`);
    res.render('countries', { title: 'Countries', nav: 'countries', stats });
  });

  // ------------------------------------------------------------ country file
  r.get('/countries/:code', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!inScope(req, code)) throw httpError(404, 'That country is not assigned to you. Ask the ECR administrator to add it under Users & access.');
    const country = await db.one(`SELECT * FROM countries WHERE code=$1`, [code]);
    const curPhase = country.phase === 'closed' ? 'close' : country.phase;
    const view = ['establish', 'operate', 'close'].includes(req.query.phase) ? req.query.phase : curPhase;
    const tab = req.query.tab || 'cycle';
    const all = (await db.q(`SELECT * FROM obligations WHERE country_code=$1 ORDER BY seq NULLS LAST, due_date NULLS LAST, id`, [code])).map((o) => D.decorate(o, country.name));
    const cycle = await D.currentCycle(code, 'annual');
    const regs = await db.q(`SELECT * FROM register_records WHERE country_code=$1 AND active ORDER BY id`, [code]);
    const regOf = (k) => regs.filter((x) => x.kind === k);
    const recentOrOpen = (o) => o.status !== 'accepted' && o.status !== 'na' ? true : (Date.now() - new Date(o.reviewed_at || o.created_at).getTime()) < 90 * 86400000;
    const byArea = (a) => all.filter((o) => (o.area === a || (o.area === 'change' && D.CHANGES[o.change_type] && D.CHANGES[o.change_type].area === a)) && recentOrOpen(o));
    const annual = cycle ? all.filter((o) => o.cycle_id === cycle.id) : [];
    const done = annual.filter((o) => o.status === 'accepted' || o.status === 'na').length;
    const waiting = annual.filter((o) => o.status === 'submitted').length;
    const setup = all.filter((o) => o.area === 'setup');
    const setupTpl = setup.length ? [] : await db.q(`SELECT * FROM templates WHERE phase='setup' AND active ORDER BY seq`);
    const close = all.filter((o) => o.area === 'close');
    let prevDone = true;
    const stages = D.CLOSE_STAGES.map((s) => {
      const steps = close.filter((o) => o.stage === s.n);
      const allDone = steps.length > 0 && steps.every((o) => o.status === 'accepted');
      const locked = !prevDone; prevDone = prevDone && allDone;
      return { ...s, steps, locked, allDone };
    });
    const overdueByArea = (a) => all.filter((o) => o.area === a && o.statusKey === 'overdue').length;
    const events = tab === 'history' ? await db.q(`SELECT e.*, u.name AS who, o.title FROM events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN obligations o ON o.id=e.obligation_id WHERE e.country_code=$1 ORDER BY e.at DESC LIMIT 200`, [code]) : [];
    const isDirector = req.user.role === 'director' && inScope(req, code);
    res.render('country', {
      title: country.name, nav: D.isPreparer(req.user) ? (req.scope.length > 1 ? 'countries' : 'country') : 'overview',
      country, view, tab, cycle, annual, done, waiting, setup, setupTpl, stages, closeCount: close.filter((o) => o.status === 'accepted').length, closeTotal: close.length,
      registration: regOf('registration')[0] || null, board: regOf('board'), poas: regOf('poa'), banks: regOf('bank'),
      regItems: byArea('registration'), boardItems: byArea('board'), poaItems: byArea('poa'), bankItems: byArea('banking'),
      overdueByArea, events, scopeCountries: await countriesInScope(req),
      canPrepare: canPrepareIn(req, code), canEditRegisters: D.canReview(req.user), canReview: D.canReview(req.user), isDirector,
      setupDone: setup.length > 0 && setup.every((o) => o.status === 'accepted' || o.status === 'na'),
      allDone: annual.length > 0 && done === annual.length,
    });
  });

  r.get('/countries/:code/history.csv', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!inScope(req, code)) throw httpError(404, 'Not found');
    const rows = await db.q(`SELECT e.at, u.name AS who, e.action, e.detail, o.title FROM events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN obligations o ON o.id=e.obligation_id WHERE e.country_code=$1 ORDER BY e.at DESC`, [code]);
    sendCsv(res, `ecr2-${code}-history.csv`, ['When', 'Who', 'Action', 'Detail', 'Item'], rows.map((x) => [x.at.toISOString(), x.who || 'System', x.action, x.detail || '', x.title || '']));
  });

  // ------------------------------------------------------------ obligations
  async function loadItem(req, id) {
    const o = await db.one(`SELECT * FROM obligations WHERE id=$1`, [Number(id) || 0]);
    if (!o || !inScope(req, o.country_code)) throw httpError(404, 'Not found');
    return o;
  }

  r.post('/items/:id/submit', upload.any(), csrfCheck, async (req, res) => {
    const o = await loadItem(req, req.params.id);
    const back = safeReturn(req.body.returnTo);
    if (!canPrepareIn(req, o.country_code) || !['todo', 'returned'].includes(o.status)) throw httpError(403, 'You cannot submit this item.');
    const existing = await db.one(`SELECT count(*)::int n FROM documents WHERE obligation_id=$1`, [o.id]);
    const files = (req.files || []).filter((f) => f.size > 0);
    if (!files.length && !(o.status === 'returned' && existing.n && req.body.keep_docs === '1')) {
      req.flash('Attach the evidence document before submitting.');
      return res.redirect(withQuery(back, { item: o.id }));
    }
    const payload = { ...(o.payload || {}) };
    D.fieldsFor(o).forEach((f) => { if (req.body[f.k] !== undefined) payload[f.k] = String(req.body[f.k]).slice(0, 500); });
    await db.tx(async (c) => {
      for (const f of files) await c.q(`INSERT INTO documents (obligation_id, label, filename, mime, size_bytes, storage_path, uploaded_by) VALUES ($1,'Evidence',$2,$3,$4,$5,$6)`, [o.id, f.originalname.slice(0, 200), f.mimetype, f.size, f.path, req.user.id]);
      await c.q(`UPDATE obligations SET status='submitted', payload=$2, submitted_at=now(), submitted_by=$3 WHERE id=$1`, [o.id, JSON.stringify(payload), req.user.id]);
      await D.audit(req.user.id, 'item.submitted', (req.body.note || '').slice(0, 1000) || 'submitted with evidence', o.country_code, o.id, c);
      await D.notifyInbox(c, await D.reviewers(c), { kind: 'submitted', title: `${(await c.one(`SELECT name FROM countries WHERE code=$1`, [o.country_code])).name} submitted: ${o.title}`, body: `From ${req.user.name}`, link: `/review?item=${o.id}`, code: o.country_code }, req.user.id);
    });
    req.flash('Sent to HQ for review.');
    res.redirect(back);
  });

  r.post('/items/:id/na', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    if (!canPrepareIn(req, o.country_code) || o.area !== 'annual' || !['todo', 'returned'].includes(o.status)) throw httpError(403, 'Not allowed.');
    await db.q(`UPDATE obligations SET status='na' WHERE id=$1`, [o.id]);
    await D.audit(req.user.id, 'item.na', (req.body.note || 'marked not applicable this cycle').slice(0, 500), o.country_code, o.id);
    req.flash('Marked not applicable for this cycle.');
    res.redirect(safeReturn(req.body.returnTo));
  });

  // HQ nudges the country team about an item they have not submitted
  r.post('/items/:id/remind', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    if (!D.canReview(req.user) || !['todo', 'returned'].includes(o.status)) throw httpError(403, 'Not allowed.');
    const team = await db.q(`SELECT u.id, u.email FROM users u JOIN user_countries uc ON uc.user_id=u.id WHERE uc.country_code=$1 AND u.role IN ('director','focal') AND u.status='active'`, [o.country_code]);
    if (!team.length) { req.flash('Nobody is assigned to this country yet. Give someone the country under Users & access first.'); return res.redirect(safeReturn(req.body.returnTo)); }
    const country = (await db.one(`SELECT name FROM countries WHERE code=$1`, [o.country_code])).name;
    const msg = String(req.body.note || '').trim().slice(0, 500);
    await D.notifyInbox(db, team.map((u) => u.id), { kind: 'reminder', title: `Reminder from HQ: ${o.title}`, body: `${country} · due ${D.fmtDate(o.due_date)}${msg ? ' · ' + msg : ''}`, link: `/?item=${o.id}`, code: o.country_code }, req.user.id);
    const url = `${config.appBaseUrl}${config.basePath}/?item=${o.id}`;
    for (const u of team) graph.sendMail(u.email, `Reminder from HQ: ${o.title}`, `<p>${req.user.name} sent a reminder about <b>${o.title}</b> for ${country}, due ${D.fmtDate(o.due_date)}.</p>${msg ? `<p>${msg.replace(/[<>&]/g, '')}</p>` : ''}<p><a href="${url}">Open it in ECR 2.0</a></p>`).catch(() => {});
    await D.audit(req.user.id, 'item.reminded', msg || `reminder sent to ${team.length} ${team.length === 1 ? 'person' : 'people'}`, o.country_code, o.id);
    req.flash(`Reminder sent to ${team.length} ${team.length === 1 ? 'person' : 'people'}.`);
    res.redirect(safeReturn(req.body.returnTo));
  });

  // HQ sets the real statutory date for this country
  r.post('/items/:id/due', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    const due = String(req.body.due_date || '');
    if (!D.canReview(req.user) || !['todo', 'returned'].includes(o.status) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(403, 'Not allowed.');
    await db.q(`UPDATE obligations SET due_date=$2 WHERE id=$1`, [o.id, due]);
    const why = String(req.body.note || '').trim().slice(0, 300);
    await D.audit(req.user.id, 'item.due_changed', `Due date: ${D.fmtDate(o.due_date)} → ${D.fmtDate(due)}${why ? ' · ' + why : ''}`, o.country_code, o.id);
    req.flash('Due date changed.');
    res.redirect(safeReturn(req.body.returnTo));
  });

  r.post('/items/:id/accept', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    if (!D.canReview(req.user) || o.status !== 'submitted') throw httpError(403, 'Not allowed.');
    await db.tx(async (c) => {
      await c.q(`UPDATE obligations SET status='accepted', reviewed_at=now(), reviewed_by=$2, review_note=NULL WHERE id=$1`, [o.id, req.user.id]);
      await D.audit(req.user.id, 'item.accepted', (req.body.note || '').slice(0, 1000) || 'accepted', o.country_code, o.id, c);
      await D.notifyInbox(c, (await D.countryTeam(c, o.country_code)).concat([o.submitted_by]), { kind: 'accepted', title: `Accepted: ${o.title}`, body: `${(await c.one(`SELECT name FROM countries WHERE code=$1`, [o.country_code])).name} · by ${req.user.name}`, link: `/?item=${o.id}`, code: o.country_code }, req.user.id);
      await D.applyAccepted(c, o, req.user.id);
    });
    await D.syncCountry(o.country_code);
    req.flash('Accepted. The country sees this as done.');
    res.redirect(safeReturn(req.body.returnTo));
  });

  r.post('/items/:id/return', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    if (!D.canReview(req.user) || o.status !== 'submitted') throw httpError(403, 'Not allowed.');
    const note = (req.body.note || '').trim().slice(0, 1000);
    const back = safeReturn(req.body.returnTo);
    if (!note) { req.flash('Add a comment so the country knows what to fix.'); return res.redirect(withQuery(back, { item: o.id })); }
    await db.q(`UPDATE obligations SET status='returned', review_note=$2, reviewed_at=now(), reviewed_by=$3, due_date=COALESCE(due_date, CURRENT_DATE + 14) WHERE id=$1`, [o.id, note, req.user.id]);
    await D.audit(req.user.id, 'item.returned', note, o.country_code, o.id);
    await D.notifyInbox(db, (await D.countryTeam(db, o.country_code)).concat([o.submitted_by]), { kind: 'returned', title: `Returned: ${o.title}`, body: note, link: `/?item=${o.id}`, code: o.country_code }, req.user.id);
    req.flash('Returned. It is back at the top of the country’s list.');
    res.redirect(back);
  });

  // Close-out steps: tick on and off (stage gating enforced)
  r.post('/items/:id/toggle', async (req, res) => {
    const o = await loadItem(req, req.params.id);
    if (o.area !== 'close' || !(canPrepareIn(req, o.country_code) || D.canReview(req.user))) throw httpError(403, 'Not allowed.');
    if (o.stage > 1) {
      const prev = await db.one(`SELECT count(*)::int n FROM obligations WHERE country_code=$1 AND area='close' AND stage < $2 AND status <> 'accepted'`, [o.country_code, o.stage]);
      if (prev.n) { req.flash('Finish the earlier stage first.'); return res.redirect(safeReturn(req.body.returnTo)); }
    }
    const next = o.status === 'accepted' ? 'todo' : 'accepted';
    await db.q(`UPDATE obligations SET status=$2, reviewed_at=now(), reviewed_by=$3 WHERE id=$1`, [o.id, next, req.user.id]);
    await D.audit(req.user.id, next === 'accepted' ? 'close.step.done' : 'close.step.reopened', o.title, o.country_code, o.id);
    res.redirect(safeReturn(req.body.returnTo));
  });

  r.get('/documents/:id', async (req, res) => {
    const d = await db.one(`SELECT d.*, o.country_code, o.area, o.change_type FROM documents d JOIN obligations o ON o.id=d.obligation_id WHERE d.id=$1`, [Number(req.params.id) || 0]);
    if (!d || !inScope(req, d.country_code)) throw httpError(404, 'Not found');
    const restricted = D.RESTRICTED_AREAS.has(d.area) || (d.change_type && D.CHANGES[d.change_type] && D.RESTRICTED_AREAS.has(D.CHANGES[d.change_type].area));
    if (restricted) await D.audit(req.user.id, 'document.viewed', d.filename, d.country_code, d.obligation_id);
    res.download(d.storage_path, d.filename);
  });

  // ------------------------------------------------------------ country actions
  r.post('/countries/:code/signoff', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!(req.user.role === 'director' && inScope(req, code))) throw httpError(403, 'Only the Country Director signs off.');
    const cyc = await D.currentCycle(code, 'annual');
    const left = await db.one(`SELECT count(*)::int n FROM obligations WHERE cycle_id=$1 AND status NOT IN ('accepted','na')`, [cyc.id]);
    if (left.n) { req.flash('Every item must be done or not applicable first.'); return res.redirect(`/countries/${code}`); }
    await db.q(`UPDATE cycles SET status='signed_off', signed_by=$2, signed_at=now() WHERE id=$1`, [cyc.id, req.user.id]);
    await D.audit(req.user.id, 'cycle.signed_off', `${cyc.label} signed off`, code);
    const cname = (await db.one(`SELECT name FROM countries WHERE code=$1`, [code])).name;
    await D.notifyInbox(db, (await D.reviewers(db)).concat(await D.leadersFor(db, code)), { kind: 'signoff', title: `${cname} signed off ${cyc.label}`, body: `By ${req.user.name}`, link: `/countries/${code}`, code }, req.user.id);
    req.flash(`${cyc.label} signed off. HQ has been notified.`);
    res.redirect(`/countries/${code}`);
  });

  r.post('/countries/:code/close', async (req, res) => {
    const code = req.params.code.toUpperCase();
    const country = await db.one(`SELECT * FROM countries WHERE code=$1`, [code]);
    if (!country || !inScope(req, code)) throw httpError(404, 'Not found');
    if (D.canReview(req.user)) {
      await db.tx(async (c) => {
        await c.q(`UPDATE obligations SET status='accepted', reviewed_at=now(), reviewed_by=$2 WHERE country_code=$1 AND change_type='close' AND status='submitted'`, [code, req.user.id]);
        await D.startClose(c, code, req.user.id);
      });
      await D.notifyInbox(db, (await D.countryTeam(db, code)).concat(await D.leadersFor(db, code)), { kind: 'close', title: `Close-out plan started for ${country.name}`, body: `Stage 1 is open · by ${req.user.name}`, link: `/countries/${code}?phase=close`, code }, req.user.id);
      req.flash(`Close-out plan started for ${country.name}. Stage 1 is open.`);
    } else if (canPrepareIn(req, code) && country.close_status === 'none') {
      await db.tx(async (c) => {
        await c.q(`UPDATE countries SET close_status='requested' WHERE code=$1`, [code]);
        const ob = await c.one(`INSERT INTO obligations (country_code, area, change_type, title, requirement, status, submitted_at, submitted_by, payload) VALUES ($1,'change','close','Close-out plan requested',$2,'submitted',now(),$3,$4) RETURNING id`,
          [code, `The country office asks HQ to start a close-out plan. Reason: ${(req.body.reason || 'not given').slice(0, 500)}`, req.user.id, JSON.stringify({ reason: req.body.reason || '' })]);
        await D.audit(req.user.id, 'close.requested', req.body.reason || '', code, ob.id, c);
        await D.notifyInbox(c, await D.reviewers(c), { kind: 'close', title: `${country.name} requests a close-out plan`, body: req.body.reason || '', link: `/countries/${code}?phase=close`, code }, req.user.id);
      });
      req.flash('Close-out requested. HQ approves before the plan starts.');
    } else throw httpError(403, 'Not allowed.');
    res.redirect(`/countries/${code}?phase=close`);
  });

  r.post('/countries/:code/phase', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!D.canReview(req.user)) throw httpError(403, 'Not allowed.');
    const to = req.body.to;
    if (to === 'operate') {
      await db.q(`UPDATE countries SET phase='operate' WHERE code=$1`, [code]);
      await D.audit(req.user.id, 'phase.changed', 'Moved to Operate', code);
      const s = await D.getSettings();
      await db.tx((c) => D.openPlan(c, code, 'annual', D.fyLabel(D.todayISO(), s.cycle_month), req.user.id));
      await D.syncCountry(code);
      req.flash('Moved to Operate. The first annual cycle is open.');
    } else if (to === 'closed') {
      await db.q(`UPDATE countries SET phase='closed', close_status='done' WHERE code=$1`, [code]);
      await D.audit(req.user.id, 'phase.changed', 'Country closed. File is read-only.', code);
      req.flash('Country marked closed.');
    }
    res.redirect(`/countries/${code}`);
  });

  // ------------------------------------------------------------ registers (HQ keeps them accurate)
  const FREQS = ['Annual', 'Biennial', 'Every 3 years', 'Every 5 years', 'No renewal (declaration regime)'];
  const REG_FIELDS = {
    registration: [['category', 'Category / legal entity type'], ['authority', 'Registering authority'], ['reg_number', 'Registration number'], ['registered_on', 'Registered on', 'date'],
      ['expires_on', 'Certificate expires on (if it has a date)', 'date'], ['renewal_frequency', 'Renewal frequency', 'select', FREQS], ['last_renewed_on', 'Last renewed on', 'date'], ['next_renewal_due', 'Next renewal due (if no expiry date)', 'date'],
      ['last_legal_review', 'Last legal review', 'date'], ['cd_confirmed_on', 'Last Country Director confirmation', 'date'], ['tax_status', 'Tax identification / exemption status'], ['documents_link', 'Where the documents are kept (link)'],
      ['doc_verified', 'Latest certificate verified by the country office', 'bool'], ['ngo_law_on_file', 'Copy of the local NGO law on file', 'bool'], ['recent_changes', 'Recent legal or regulatory changes'], ['notes', 'Notes']],
    board: [['name', 'Name'], ['position', 'Position or role'], ['appointed_on', 'Appointed on', 'date'], ['term_ends', 'Term ends', 'date'], ['local_national', 'Local national', 'bool'], ['independent', 'Independent member', 'bool'], ['coi_on_file', 'Conflict-of-interest declaration on file', 'bool'], ['vetting_done', 'Background check done', 'bool']],
    poa: [['holder', 'Holder'], ['position', 'Position or title'], ['scope', 'Scope of authority'], ['entity_covered', 'Legal entity covered'], ['effective_on', 'Effective on', 'date'], ['expires_on', 'Expires on', 'date'], ['notarised', 'Notarised or apostilled', 'bool'], ['registered_locally', 'Registered with local authority', 'bool'], ['cd_confirmed', 'Confirmed by the Country Director', 'bool']],
    bank: [['bank', 'Bank'], ['account_type', 'Account type'], ['currency', 'Currency'], ['last4', 'Last 4 digits of account'], ['signatories', 'Signatories (comma separated)'], ['rule', 'Signing rule, e.g. any 2'], ['threshold', 'Dual signature threshold'], ['approval_levels', 'Approval levels'], ['last_confirmed_on', 'Last bank confirmation', 'date'],
      ['mandate_on_file', 'Bank mandate on file', 'bool'], ['kyc_on_file', 'AML/KYC documents on file', 'bool'], ['board_member_required', 'Local rules require a board member as signatory', 'bool'], ['poa_required', 'Bank requires a POA for signatories', 'bool'], ['verified_by_finance', 'Latest verified by Finance', 'bool']],
    rules: [['board_required', 'Local law requires a board', 'bool'], ['board_min', 'Minimum number of members'], ['local_majority', 'Local nationals must be the majority', 'bool'], ['independent_required', 'At least one independent member required', 'bool'], ['term_limit', 'Term length and limit, e.g. two terms of three years'], ['meeting_frequency', 'Meetings required', 'select', ['Quarterly', 'Twice a year', 'Annual', 'Not specified']], ['source', 'Where the rule comes from (law, constitution)']],
  };
  const LABEL_OF = (kind, k) => ((REG_FIELDS[kind] || []).find((f) => f[0] === k) || [k, k])[1];
  // "Expires on: 2026-01-31 → 2027-01-31; COI on file: no → yes"
  function diffText(kind, before, after) {
    const show = (v) => (v === true ? 'yes' : v === false ? 'no' : v == null || v === '' ? '(blank)' : String(v));
    return Object.keys(after).filter((k) => show(before[k]) !== show(after[k]) && !(before[k] == null && after[k] === false)).map((k) => `${LABEL_OF(kind, k)}: ${show(before[k])} → ${show(after[k])}`).join('; ');
  }
  const REG_TAB = { registration: 'reg', board: 'board', poa: 'poa', bank: 'bank', rules: 'board' };

  r.get('/countries/:code/registers/:kind/:id', async (req, res) => {
    const code = req.params.code.toUpperCase(); const kind = req.params.kind;
    if (!D.canReview(req.user) || !REG_FIELDS[kind] || !inScope(req, code)) throw httpError(403, 'Not allowed.');
    const country = await db.one(`SELECT * FROM countries WHERE code=$1`, [code]);
    const rec = kind === 'rules' ? { id: 'rules', data: country ? country.rules || {} : {} } : req.params.id === 'new' ? { id: 'new', data: {} } : await db.one(`SELECT * FROM register_records WHERE id=$1 AND country_code=$2 AND kind=$3`, [req.params.id, code, kind]);
    if (!rec) throw httpError(404, 'Not found');
    res.render('register_edit', { title: 'Edit register', nav: 'overview', country, kind, rec, fields: REG_FIELDS[kind], back: `/countries/${code}?tab=${REG_TAB[kind]}` });
  });
  r.post('/countries/:code/registers/:kind/:id', async (req, res) => {
    const code = req.params.code.toUpperCase(); const kind = req.params.kind;
    if (!D.canReview(req.user) || !REG_FIELDS[kind] || !inScope(req, code)) throw httpError(403, 'Not allowed.');
    if (req.body.action === 'deactivate' && req.params.id !== 'new' && kind !== 'rules') {
      await db.q(`UPDATE register_records SET active=false, updated_at=now() WHERE id=$1 AND country_code=$2`, [req.params.id, code]);
      await D.audit(req.user.id, 'register.removed', `${kind} record #${req.params.id} removed`, code);
      req.flash('Record removed from the register. It stays in the history.');
      return res.redirect(`/countries/${code}?tab=${REG_TAB[kind]}`);
    }
    const data = {};
    REG_FIELDS[kind].forEach(([k, , t]) => { data[k] = t === 'bool' ? req.body[k] === 'on' : (String(req.body[k] || '').trim().slice(0, 500) || null); });
    if (data.last4) data.last4 = data.last4.replace(/\D/g, '').slice(-4);
    if (kind === 'rules') {
      const before = (await db.one(`SELECT rules FROM countries WHERE code=$1`, [code])).rules || {};
      await db.q(`UPDATE countries SET rules=$2 WHERE code=$1`, [code, JSON.stringify(data)]);
      await D.audit(req.user.id, 'register.edited', `board rules: ${diffText(kind, before, data) || 'no change'}`, code);
      await D.syncCountry(code);
      req.flash('Board rules saved. The board is checked against them.');
      return res.redirect(`/countries/${code}?tab=board`);
    }
    if (req.params.id === 'new') {
      await db.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,$2,$3)`, [code, kind, JSON.stringify(data)]);
      await D.audit(req.user.id, 'register.added', `${kind}: ${data.name || data.holder || data.bank || data.reg_number || 'record'}`, code);
    } else {
      const prev = await db.one(`SELECT data FROM register_records WHERE id=$1 AND country_code=$2`, [req.params.id, code]);
      // Keep fields this form doesn't show (e.g. set by an accepted change), and log what changed field by field.
      const merged = { ...(prev ? prev.data : {}), ...data };
      await db.q(`UPDATE register_records SET data=$3, updated_at=now() WHERE id=$1 AND country_code=$2`, [req.params.id, code, JSON.stringify(merged)]);
      await D.audit(req.user.id, 'register.edited', `${kind} ${data.name || data.holder || data.bank || data.reg_number || 'record'}: ${diffText(kind, prev ? prev.data : {}, data) || 'no change'}`, code);
    }
    await D.syncCountry(code);
    req.flash('Register saved. Deadlines have been recalculated.');
    res.redirect(`/countries/${code}?tab=${REG_TAB[kind]}`);
  });

  // ------------------------------------------------------------ change requests
  r.get('/changes/new', async (req, res) => {
    if (!D.isPreparer(req.user)) throw httpError(403, 'Only country staff report changes.');
    const type = D.CHANGES[req.query.type] ? req.query.type : null;
    const code = inScope(req, (req.query.country || '').toUpperCase()) ? req.query.country.toUpperCase() : req.scope[0];
    const countries = await countriesInScope(req);
    const regs = await db.q(`SELECT * FROM register_records WHERE country_code=$1 AND active ORDER BY id`, [code]);
    res.render('change_new', { title: 'Report a change', nav: 'change', type, def: type ? D.CHANGES[type] : null, changes: D.CHANGES, code, countries, accounts: regs.filter((x) => x.kind === 'bank'), members: regs.filter((x) => x.kind === 'board') });
  });

  r.post('/changes', upload.any(), csrfCheck, async (req, res) => {
    const type = req.body.type; const def = D.CHANGES[type]; const code = String(req.body.country || '').toUpperCase();
    if (!def || !canPrepareIn(req, code)) throw httpError(403, 'Not allowed.');
    const payload = {};
    def.fields.forEach((f) => { payload[f.k] = String(req.body[f.k] || '').trim().slice(0, 500) || null; });
    const files = (req.files || []).filter((f) => f.size > 0);
    const labelFor = (field) => { const m = /^evidence_(\d+)$/.exec(field); return m ? def.evidence[Number(m[1])] : 'Evidence'; };
    if (type === 'board') { payload.has_coi = files.some((f) => f.fieldname === 'evidence_1'); payload.has_vetting = files.some((f) => f.fieldname === 'evidence_2'); }
    const country = await db.one(`SELECT name FROM countries WHERE code=$1`, [code]);
    const summary = def.fields.filter((f) => payload[f.k] && f.type !== 'account' && f.type !== 'member').map((f) => `${f.label}: ${payload[f.k]}`).join(' · ');
    const id = await db.tx(async (c) => {
      const ob = await c.one(`INSERT INTO obligations (country_code, area, change_type, title, requirement, status, payload, submitted_at, submitted_by) VALUES ($1,'change',$2,$3,$4,'submitted',$5,now(),$6) RETURNING id`,
        [code, type, def.title, `${summary || 'Change reported by the country office'}. Missing evidence: ${def.evidence.filter((e, i) => !files.some((f) => f.fieldname === 'evidence_' + i)).join(', ') || 'none'}.`, JSON.stringify(payload), req.user.id]);
      for (const f of files) await c.q(`INSERT INTO documents (obligation_id, label, filename, mime, size_bytes, storage_path, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ob.id, labelFor(f.fieldname), f.originalname.slice(0, 200), f.mimetype, f.size, f.path, req.user.id]);
      await D.audit(req.user.id, 'change.reported', def.title + (req.body.note ? ` · ${req.body.note.slice(0, 500)}` : ''), code, ob.id, c);
      await D.notifyInbox(c, await D.reviewers(c), { kind: 'change', title: `${country.name} reported a change: ${def.title}`, body: `From ${req.user.name}`, link: `/review?item=${ob.id}`, code }, req.user.id);
      if (type === 'board') {
        await c.q(`INSERT INTO obligations (country_code, area, title, requirement, due_date, source_type) VALUES ($1,'registration',$2,$3,CURRENT_DATE + 14,'director_notice')`,
          [code, 'Notify the registering authority of the director change', `Board change reported: ${summary}. File the notice of change with the registering authority.`]);
      }
      return ob.id;
    });
    req.flash(`Change sent to HQ for ${country.name}. The register updates when it is accepted.`);
    res.redirect(`/?item=${id}`);
  });

  // ------------------------------------------------------------ review queue
  r.get('/review', async (req, res) => {
    if (!D.canReview(req.user)) throw httpError(403, 'Only HQ reviewers see the review queue.');
    const all = (await obligationsInScope(req, `o.status='submitted'`)).map((o) => D.decorate(o)).sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    const country = req.query.country || 'all';
    const counts = {}; all.forEach((o) => { counts[o.country_code] = (counts[o.country_code] || 0) + 1; });
    res.render('review', { title: 'Review queue', nav: 'review', items: all.filter((o) => country === 'all' || o.country_code === country), country, counts, total: all.length, names: Object.fromEntries(all.map((o) => [o.country_code, o.country_name])) });
  });

  // ------------------------------------------------------------ calendar
  async function calendarItems(req, country) {
    const obs = (await obligationsInScope(req, `o.status IN ('todo','returned','submitted') AND o.due_date IS NOT NULL`)).map((o) => D.decorate(o));
    return obs.filter((o) => country === 'all' || o.country_code === country);
  }
  r.get('/calendar', async (req, res) => {
    const country = req.query.country || 'all';
    const items = await calendarItems(req, country);
    const groups = [];
    items.forEach((o) => { const m = D.monthName(o.due_date); let g = groups.find((x) => x.name === m); if (!g) { g = { name: m, items: [] }; groups.push(g); } g.items.push(o); });
    res.render('calendar', { title: 'Calendar', nav: 'calendar', groups, country, countries: await countriesInScope(req), calUrl: `${config.appBaseUrl}${bp}/cal/${req.user.cal_token}.ics` });
  });
  r.get('/calendar.csv', async (req, res) => {
    const items = await calendarItems(req, req.query.country || 'all');
    sendCsv(res, 'ecr2-deadlines.csv', ['Due date', 'Country', 'Area', 'Obligation', 'Status'], items.map((o) => [o.due_date, o.country_name, o.areaLabel, o.title, o.statusLabel]));
  });
  r.get('/cal/:token.ics', async (req, res) => {
    const u = await db.one(`SELECT * FROM users WHERE cal_token=$1 AND status='active'`, [req.params.token]);
    if (!u) return res.status(404).send('Not found');
    const fake = { user: u, scope: await D.loadScope(u) };
    const items = await calendarItems(fake, 'all');
    const esc = (s) => String(s).replace(/[,;\\]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EGPAF//ECR 2.0//EN', 'X-WR-CALNAME:EGPAF compliance deadlines'];
    items.forEach((o) => {
      const dt = o.due_date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:ecr2-${o.id}@pedaids.org`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART;VALUE=DATE:${dt}`, `SUMMARY:${esc(`[${o.country_name}] ${o.title}`)}`, `DESCRIPTION:${esc(`${o.areaLabel} · ${o.statusLabel}\n${config.appBaseUrl}${bp}/?item=${o.id}`)}`, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    res.type('text/calendar').send(lines.join('\r\n'));
  });

  // ------------------------------------------------------------ notifications (the bell)
  r.get('/notifications', async (req, res) => {
    const items = await db.q(`SELECT * FROM inbox WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.user.id]);
    res.render('notifications', { title: 'Notifications', nav: '', items });
  });
  r.get('/notifications/:id', async (req, res) => {
    const n = await db.one(`UPDATE inbox SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING link`, [Number(req.params.id) || 0, req.user.id]);
    res.redirect(n && n.link ? safeReturn(n.link) : '/notifications');
  });
  r.post('/notifications/read-all', async (req, res) => {
    await db.q(`UPDATE inbox SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [req.user.id]);
    res.redirect(safeReturn(req.body.returnTo));
  });

  // ------------------------------------------------------------ search
  r.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    let countries = []; let items = []; let people = [];
    if (q.length >= 2) {
      const like = `%${q}%`;
      countries = await db.q(`SELECT * FROM countries WHERE code = ANY($1) AND (name ILIKE $2 OR code ILIKE $2) ORDER BY name`, [req.scope, like]);
      items = (await obligationsInScope(req, `o.title ILIKE $2`, [like])).slice(0, 30).map((o) => D.decorate(o));
      if (D.isAdmin(req.user)) people = await db.q(`SELECT * FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 10`, [like]);
    }
    res.render('search', { title: 'Search', nav: '', q, countries, items, people });
  });

  function sendCsv(res, name, header, rows) {
    const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send('﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n'));
  }

  return r;
};
