// Core rules: roles, scope, display, register-driven obligations, cycles, review outcomes.
const db = require('./db');

// ---------------------------------------------------------------- roles
const ROLES = {
  admin:    { label: 'Administrator', desc: 'HQ Legal & Compliance lead. Everything, including users, templates and settings.', all: true },
  reviewer: { label: 'HQ reviewer', desc: 'Reviews and accepts submissions from every country. Starts close-out plans and keeps registers accurate.', all: true },
  leader:   { label: 'Leadership (view only)', desc: 'Sees status for the countries chosen, or all if none are chosen. Cannot edit or review.', all: false },
  director: { label: 'Country Director', desc: 'Prepares and submits for their countries, and signs off the annual cycle.', all: false },
  focal:    { label: 'Country focal point', desc: 'Prepares and submits evidence for their countries.', all: false },
  viewer:   { label: 'Country viewer', desc: 'Default for new sign-ins. Read-only view of their own country, without powers of attorney or bank details.', all: false },
};
const canSeeRestricted = (u) => u.role !== 'viewer';
// Match a Microsoft office location (e.g. "Maseru, Lesotho") to a country code.
const CITY = { LSO: ['maseru'], MWI: ['lilongwe', 'blantyre'], MOZ: ['maputo'], CMR: ['yaounde', 'douala'], COD: ['drc', 'congo', 'kinshasa'], CIV: ['ivory coast', 'cote d', 'abidjan'], SWZ: ['eswatini', 'swaziland', 'mbabane'], KEN: ['nairobi'], TZA: ['dar es salaam', 'dodoma'], UGA: ['kampala'], NGA: ['abuja', 'lagos'], ZWE: ['harare'] };
function countryFromOffice(countries, ...texts) {
  const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const t of texts.map(norm).filter(Boolean)) {
    const hit = countries.find((c) => t.includes(norm(c.name)) || t.split(/[^a-z]+/).includes(c.code.toLowerCase()) || (CITY[c.code] || []).some((w) => t.includes(w)));
    if (hit) return hit.code;
  }
  return null;
}
const canReview = (u) => u.role === 'admin' || u.role === 'reviewer';
const isAdmin = (u) => u.role === 'admin';
const isPreparer = (u) => u.role === 'director' || u.role === 'focal';

async function loadScope(user) {
  const all = await db.q(`SELECT code FROM countries ORDER BY name`);
  if (ROLES[user.role].all) return all.map((c) => c.code);
  const mine = await db.q(`SELECT country_code FROM user_countries WHERE user_id=$1`, [user.id]);
  if (!mine.length && user.role === 'leader') return all.map((c) => c.code);
  const set = new Set(mine.map((r) => r.country_code));
  return all.map((c) => c.code).filter((c) => set.has(c));
}

// ---------------------------------------------------------------- labels
const AREAS = {
  setup: 'Registration set-up', annual: 'Annual cycle', registration: 'Registration', board: 'Board',
  poa: 'Power of attorney', banking: 'Banking', change: 'Change request', close: 'Close-out',
};
const RESTRICTED_AREAS = new Set(['poa', 'banking']);
const STATUS = {
  todo: ['To do', 'c-neutral'], overdue: ['Overdue', 'c-red'], returned: ['Returned', 'c-orange'],
  submitted: ['Awaiting review', 'c-blue'], accepted: ['Done', 'c-green'], na: ['Not applicable', 'c-muted'],
};
const PHASES = { establish: ['Establish', 'c-orange'], operate: ['Operate', 'c-teal'], close: ['Close out', 'c-muted'], closed: ['Closed', 'c-muted'] };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysUntil(iso) { if (!iso) return null; return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayISO() + 'T00:00:00Z')) / 86400000); }
function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; }
function fmtShort(iso) { if (!iso) return ''; const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; }
function monthName(iso) { const [y, m] = iso.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; }
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts); const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (iso === todayISO()) return 'Today';
  return fmtShort(iso);
}

function decorate(o, countryName) {
  const days = daysUntil(o.due_date);
  const key = o.status === 'todo' && days !== null && days < 0 ? 'overdue' : o.status;
  let dueText;
  if (o.status === 'accepted') dueText = 'Accepted by HQ';
  else if (o.status === 'na') dueText = 'Not applicable this cycle';
  else if (days === null) dueText = 'No deadline';
  else if (days < 0) dueText = `Was due ${fmtDate(o.due_date)} · ${-days} days overdue`;
  else if (days === 0) dueText = 'Due today';
  else dueText = `Due ${fmtDate(o.due_date)} · in ${days} days`;
  const dueShort = (o.status === 'accepted' || o.status === 'na' || days === null) ? '' : (days < 0 ? `${-days} days overdue` : fmtDate(o.due_date));
  return {
    ...o, days, statusKey: key, statusLabel: STATUS[key][0], chipCls: STATUS[key][1], dueText, dueShort,
    areaLabel: AREAS[o.area], countryName: countryName || o.country_name || o.country_code,
    isOpen: o.status === 'todo' || o.status === 'returned',
  };
}

// Fields a preparer fills when completing an obligation, by source/area.
function fieldsFor(o) {
  const d = (k, label) => ({ k, label, type: 'date' });
  const t = (k, label) => ({ k, label, type: 'text' });
  const map = {
    registration_renewal: [d('completed_on', 'Renewal date'), d('new_expiry', 'New expiry date (if the certificate has one)')],
    cd_confirmation: [d('confirmed_on', 'Confirmed on')],
    board_composition: [d('completed_on', 'Resolved on')],
    legal_review: [d('completed_on', 'Review date'), t('changes', 'Legal or regulatory changes found (if any)')],
    board_term: [d('decision_on', 'Decision date'), { k: 'outcome', label: 'Outcome', type: 'select', options: ['Reappointed', 'Replaced (report the change too)', 'Left the board'] }, d('new_term_end', 'New term end (if reappointed)')],
    board_coi: [d('received_on', 'Declaration signed on')],
    poa_expiry: [d('new_expiry', 'New expiry date'), d('notarised_on', 'Notarised or apostilled on')],
    bank_confirmation: [d('confirmed_on', 'Bank confirmation date')],
    director_notice: [d('completed_on', 'Notice filed on')],
  };
  if (o.source_type && map[o.source_type]) return map[o.source_type];
  if (o.area === 'annual' || o.area === 'setup') return [d('completed_on', 'Date completed')];
  return [];
}

// ---------------------------------------------------------------- audit
async function audit(userId, action, detail, countryCode, obligationId, c = db) {
  await c.q(`INSERT INTO events (user_id, action, detail, country_code, obligation_id) VALUES ($1,$2,$3,$4,$5)`,
    [userId || null, action, detail || null, countryCode || null, obligationId || null]);
}

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = { lead_days: [90, 60, 30, 7], digest: true, cycle_month: 10, horizon_days: 180, coi_due_days: 30, signup_role: 'viewer' };
async function getSettings() {
  const rows = await db.q(`SELECT key, value FROM settings`);
  const s = { ...DEFAULT_SETTINGS };
  rows.forEach((r) => { s[r.key] = r.value; });
  return s;
}

// ---------------------------------------------------------------- registers -> obligations
async function upsertSourceObligation(c, code, area, sourceType, sourceId, title, requirement, due) {
  const open = await c.one(`SELECT id, due_date FROM obligations WHERE country_code=$1 AND source_type=$2 AND source_id=$3 AND status IN ('todo','submitted','returned')`, [code, sourceType, sourceId]);
  if (open) {
    if (due && open.due_date !== due) await c.q(`UPDATE obligations SET due_date=$1 WHERE id=$2`, [due, open.id]);
    return null;
  }
  // Don't recreate one just accepted for the same due date
  const done = await c.one(`SELECT id FROM obligations WHERE country_code=$1 AND source_type=$2 AND source_id=$3 AND due_date=$4`, [code, sourceType, sourceId, due]);
  if (done) return null;
  const r = await c.one(`INSERT INTO obligations (country_code, area, title, requirement, due_date, source_type, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [code, area, title, requirement, due, sourceType, sourceId]);
  return r.id;
}

async function syncCountry(code, c = db) {
  const country = await c.one(`SELECT * FROM countries WHERE code=$1`, [code]);
  if (!country || country.phase === 'establish' || country.phase === 'closed') return;
  const s = await getSettings();
  const horizon = addDays(todayISO(), s.horizon_days);
  const within = (iso) => iso && iso <= horizon;
  const recs = await c.q(`SELECT * FROM register_records WHERE country_code=$1 AND active`, [code]);
  for (const r of recs) {
    const d = r.data || {};
    if (r.kind === 'registration') {
      if (within(d.expires_on)) await upsertSourceObligation(c, code, 'registration', 'registration_renewal', r.id, 'Renew Certificate of Registration', `Renew the registration with the ${d.authority || country.authority || 'registering authority'} before it expires on ${fmtDate(d.expires_on)}.`, d.expires_on);
      // No expiry on the certificate: renewal comes from the next-renewal date, or the last renewal plus the frequency.
      const months = FREQ_MONTHS[d.renewal_frequency];
      const renewDue = !d.expires_on && d.renewal_required !== false ? (d.next_renewal_due || (d.last_renewed_on && months ? addMonths(d.last_renewed_on, months) : null)) : null;
      if (within(renewDue)) await upsertSourceObligation(c, code, 'registration', 'registration_renewal', r.id, `Renew registration (${d.renewal_frequency || 'periodic'})`, `Lodge the renewal with the ${d.authority || country.authority || 'registering authority'} by ${fmtDate(renewDue)}.`, renewDue);
      if (d.cd_confirmed_on && within(addDays(d.cd_confirmed_on, 365))) await upsertSourceObligation(c, code, 'registration', 'cd_confirmation', r.id, 'Country Director confirms registration details', 'The Country Director confirms the registration record, certificate and authority details are current, and that the latest certificate has been checked.', addDays(d.cd_confirmed_on, 365));
      const lr = d.last_legal_review ? addDays(d.last_legal_review, 365) : addDays(todayISO(), 60);
      if (within(lr)) await upsertSourceObligation(c, code, 'registration', 'legal_review', r.id, 'Annual legal review of NGO law', 'Check for changes to NGO, tax and labour law that affect the registration, and record what you found.', lr);
    }
    if (r.kind === 'board') {
      if (within(d.term_ends)) await upsertSourceObligation(c, code, 'board', 'board_term', r.id, `Board term ending: ${d.name}${d.position ? ' (' + d.position + ')' : ''}`, 'Reappoint or replace before the term ends. A replacement must be notified to the registering authority.', d.term_ends);
      if (!d.coi_on_file) await upsertSourceObligation(c, code, 'board', 'board_coi', r.id, `Conflict-of-interest declaration: ${d.name}`, 'Collect a signed annual conflict-of-interest declaration from this board member.', addDays(r.created_at.toISOString().slice(0, 10), s.coi_due_days));
    }
    if (r.kind === 'poa' && within(d.expires_on)) await upsertSourceObligation(c, code, 'poa', 'poa_expiry', r.id, `Renew POA: ${d.holder}${d.position ? ' (' + d.position + ')' : ''}`, 'Renew the power of attorney, notarise or apostille it, and register it locally before it expires.', d.expires_on);
    if (r.kind === 'bank') {
      const due = d.last_confirmed_on ? addDays(d.last_confirmed_on, 365) : todayISO();
      if (within(due)) await upsertSourceObligation(c, code, 'banking', 'bank_confirmation', r.id, `Bank confirmation: ${d.bank} (${d.currency || ''})`.replace(' ()', ''), 'Get written confirmation from the bank of the current signatories and mandate.', due);
    }
  }
  const issues = boardIssues(country.rules || {}, recs.filter((r) => r.kind === 'board').map((r) => r.data || {}));
  const openComp = await c.one(`SELECT id FROM obligations WHERE country_code=$1 AND source_type='board_composition' AND status IN ('todo','submitted','returned')`, [code]);
  if (issues.length && !openComp) await upsertSourceObligation(c, code, 'board', 'board_composition', 0, 'Board does not meet the local rules', `${issues.join('. ')}. Appoint members (and report the change) so the board meets the law.`, addDays(todayISO(), s.coi_due_days));
}
// What the local law requires of the board, checked against the active members.
function boardIssues(rules, members) {
  if (!rules.board_required || !members.length) return []; // an empty register is missing data, not a breach
  const out = [];
  if (rules.board_min && members.length < Number(rules.board_min)) out.push(`${members.length} of the ${rules.board_min} members required`);
  if (rules.independent_required && !members.some((m) => m.independent)) out.push('No independent member');
  if (rules.local_majority && members.length && members.filter((m) => m.local_national).length * 2 <= members.length) out.push('Local nationals are not a majority');
  return out;
}
const FREQ_MONTHS = { Annual: 12, Biennial: 24, 'Every 3 years': 36, 'Every 5 years': 60 };
function addMonths(iso, n) { const [y, m, dd] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); dt.setUTCDate(Math.min(dd, last)); return dt.toISOString().slice(0, 10); }
async function syncAll() { const cs = await db.q(`SELECT code FROM countries`); for (const c of cs) await syncCountry(c.code); }

// ---------------------------------------------------------------- cycles
function fyLabel(iso, cycleMonth) { const [y, m] = iso.split('-').map(Number); return 'FY' + (cycleMonth >= 7 && m >= cycleMonth ? y + 1 : y); }

async function openPlan(c, code, kind, label, userId) {
  const exists = await c.one(`SELECT id FROM cycles WHERE country_code=$1 AND kind=$2 AND label=$3`, [code, kind, label]);
  if (exists) return null;
  const cyc = await c.one(`INSERT INTO cycles (country_code, kind, label) VALUES ($1,$2,$3) RETURNING id, opened_on`, [code, kind, label]);
  const tpls = await c.q(`SELECT t.*, l.text AS local, l.due_days AS local_due FROM templates t LEFT JOIN template_local l ON l.template_id=t.id AND l.country_code=$2 WHERE t.phase=$1 AND t.active AND (t.country_code IS NULL OR t.country_code=$2) AND NOT COALESCE(l.excluded, false) ORDER BY t.seq`, [kind, code]);
  const area = kind;
  for (const t of tpls) {
    const title = t.local || t.text;
    await c.q(`INSERT INTO obligations (country_code, cycle_id, area, template_id, seq, stage, title, requirement, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [code, cyc.id, area, t.id, t.seq, t.stage, title, title + '.', kind === 'close' ? null : addDays(cyc.opened_on, t.local_due || t.due_days)]);
  }
  await audit(userId, `${kind}.opened`, `${label} opened with ${tpls.length} items`, code, null, c);
  return cyc.id;
}

async function openAnnualCycles(userId, label) {
  const s = await getSettings();
  const lab = label || fyLabel(todayISO(), s.cycle_month);
  const countries = await db.q(`SELECT code FROM countries WHERE phase IN ('operate','close')`);
  let n = 0;
  for (const c of countries) { const id = await db.tx((t) => openPlan(t, c.code, 'annual', lab, userId)); if (id) n++; }
  return { label: lab, opened: n };
}

async function currentCycle(code, kind = 'annual') {
  return db.one(`SELECT * FROM cycles WHERE country_code=$1 AND kind=$2 ORDER BY opened_on DESC, id DESC LIMIT 1`, [code, kind]);
}

// ---------------------------------------------------------------- review outcomes
// Called inside a transaction when HQ accepts an obligation.
async function applyAccepted(c, o, userId) {
  const p = o.payload || {};
  const rec = o.source_id ? await c.one(`SELECT * FROM register_records WHERE id=$1`, [o.source_id]) : null;
  const patch = async (id, obj) => c.q(`UPDATE register_records SET data = data || $2::jsonb, updated_at=now() WHERE id=$1`, [id, JSON.stringify(obj)]);
  switch (o.source_type) {
    case 'registration_renewal': if (rec) await patch(rec.id, { last_renewed_on: p.completed_on || todayISO(), next_renewal_due: null, ...(p.new_expiry ? { expires_on: p.new_expiry } : {}) }); break;
    case 'cd_confirmation': if (rec) await patch(rec.id, { cd_confirmed_on: p.confirmed_on || todayISO(), doc_verified: true }); break;
    case 'legal_review': if (rec) await patch(rec.id, { last_legal_review: p.completed_on || todayISO(), recent_changes: p.changes || '' }); break;
    case 'board_term':
      if (rec && p.new_term_end && /Reappointed/.test(p.outcome || '')) await patch(rec.id, { term_ends: p.new_term_end });
      if (rec && /Left/.test(p.outcome || '')) await c.q(`UPDATE register_records SET active=false, updated_at=now() WHERE id=$1`, [rec.id]);
      break;
    case 'board_coi': if (rec) await patch(rec.id, { coi_on_file: true }); break;
    case 'poa_expiry': if (rec && p.new_expiry) await patch(rec.id, { expires_on: p.new_expiry, notarised: true }); break;
    case 'bank_confirmation': if (rec) await patch(rec.id, { last_confirmed_on: p.confirmed_on || todayISO() }); break;
    default: break;
  }
  if (o.area === 'change') await applyChange(c, o, userId);
  if (o.area === 'setup') {
    const left = await c.one(`SELECT count(*)::int n FROM obligations WHERE country_code=$1 AND area='setup' AND status NOT IN ('accepted','na')`, [o.country_code]);
    if (left.n === 0) await audit(userId, 'setup.complete', 'All registration set-up requirements accepted', o.country_code, null, c);
  }
}

async function applyChange(c, o, userId) {
  const p = o.payload || {};
  const code = o.country_code;
  if (o.change_type === 'signatory' && p.account_id) {
    const acc = await c.one(`SELECT * FROM register_records WHERE id=$1 AND country_code=$2`, [p.account_id, code]);
    if (acc) {
      let sig = (acc.data.signatories || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (p.leaving) sig = sig.filter((s) => s.toLowerCase() !== p.leaving.toLowerCase());
      if (p.joining && !sig.includes(p.joining)) sig.push(p.joining);
      await c.q(`UPDATE register_records SET data = data || $2::jsonb, updated_at=now() WHERE id=$1`, [acc.id, JSON.stringify({ signatories: sig.join(', '), mandate_on_file: true })]);
    }
  }
  if (o.change_type === 'board') {
    if (p.leaving_id) await c.q(`UPDATE register_records SET active=false, updated_at=now() WHERE id=$1 AND country_code=$2 AND kind='board'`, [p.leaving_id, code]);
    if (p.joining) await c.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'board',$2)`, [code, JSON.stringify({ name: p.joining, position: p.position || '', appointed_on: p.appointed_on || null, term_ends: p.term_ends || null, coi_on_file: !!p.has_coi, vetting_done: !!p.has_vetting })]);
  }
  if (o.change_type === 'poa' && p.holder) {
    if (p.position) await c.q(`UPDATE register_records SET active=false, updated_at=now() WHERE country_code=$1 AND kind='poa' AND active AND lower(data->>'position')=lower($2)`, [code, p.position]);
    await c.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'poa',$2)`, [code, JSON.stringify({ holder: p.holder, position: p.position || '', scope: p.scope || '', effective_on: p.effective_on || null, expires_on: p.expires_on || null, notarised: true, registered_locally: !!p.registered_locally })]);
  }
  if (o.change_type === 'registration') {
    const reg = await c.one(`SELECT * FROM register_records WHERE country_code=$1 AND kind='registration' AND active ORDER BY id LIMIT 1`, [code]);
    const data = {}; if (p.reg_number) data.reg_number = p.reg_number; if (p.expires_on) data.expires_on = p.expires_on; if (p.what) data.notes = p.what;
    if (reg) await c.q(`UPDATE register_records SET data = data || $2::jsonb, updated_at=now() WHERE id=$1`, [reg.id, JSON.stringify(data)]);
    else await c.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'registration',$2)`, [code, JSON.stringify(data)]);
  }
  if (o.change_type === 'close') await startClose(c, code, userId);
  await audit(userId, 'register.updated', `${o.title} applied to the register`, code, o.id, c);
}

async function startClose(c, code, userId) {
  await c.q(`UPDATE countries SET phase='close', close_status='running' WHERE code=$1`, [code]);
  await openPlan(c, code, 'close', 'Close-out', userId);
}

const CLOSE_STAGES = [
  { n: 1, name: 'Decide', gate: '' },
  { n: 2, name: 'Settle', gate: 'Before stage 3: final tax clearance obtained, and statutory employee payouts confirmed.' },
  { n: 3, name: 'Report', gate: 'Record the asset transfer recipient for the final report.' },
  { n: 4, name: 'Deregister', gate: 'Record the deregistration certificate number. The country file then becomes read-only.' },
];

// ---------------------------------------------------------------- change request definitions
const CHANGES = {
  signatory: { title: 'Change bank signatories', short: 'Bank signatory changed', desc: 'Someone joins or leaves a bank mandate', area: 'banking',
    fields: [{ k: 'account_id', label: 'Bank account', type: 'account' }, { k: 'leaving', label: 'Signatory leaving', type: 'text' }, { k: 'joining', label: 'Signatory joining', type: 'text' }, { k: 'effective_on', label: 'Effective date', type: 'date' }],
    evidence: ['Board resolution approving the change', 'Updated bank mandate', 'AML/KYC documents for the new signatory'],
    followups: ['HQ Compliance reviews the change', 'The bank account record updates when HQ accepts', 'The next bank confirmation is scheduled automatically'] },
  board: { title: 'Board member joins or leaves', short: 'Board member joined or left', desc: 'Appointments, resignations, end of term', area: 'board',
    fields: [{ k: 'leaving_id', label: 'Member leaving (if any)', type: 'member' }, { k: 'joining', label: 'Member joining (if any)', type: 'text' }, { k: 'position', label: 'Position or role', type: 'text' }, { k: 'appointed_on', label: 'Appointment date', type: 'date' }, { k: 'term_ends', label: 'Term ends', type: 'date' }],
    evidence: ['Board resolution or minutes', 'Conflict-of-interest declaration', 'Background check confirmation'],
    followups: ['Creates a task to notify the registering authority, due in 14 days', 'The board register updates when HQ accepts', 'A term-end reminder is set for the new member'] },
  poa: { title: 'Grant or renew a power of attorney', short: 'Power of attorney granted or renewed', desc: 'New POA, renewal, revocation', area: 'poa',
    fields: [{ k: 'holder', label: 'POA holder', type: 'text' }, { k: 'position', label: 'Position or title', type: 'text' }, { k: 'scope', label: 'Scope of authority', type: 'text' }, { k: 'effective_on', label: 'Effective date', type: 'date' }, { k: 'expires_on', label: 'Expiry date', type: 'date' }],
    evidence: ['Signed POA, notarised or apostilled', 'Proof of registration with the local authority'],
    followups: ['HQ Compliance reviews the POA', 'Any earlier POA for the same position is marked superseded', 'A renewal reminder appears ahead of expiry'] },
  registration: { title: 'Registration renewed or changed', short: 'Registration renewed or changed', desc: 'Renewal, new number, change of category', area: 'registration',
    fields: [{ k: 'what', label: 'What changed', type: 'text' }, { k: 'reg_number', label: 'Registration number', type: 'text' }, { k: 'expires_on', label: 'New expiry date', type: 'date' }],
    evidence: ['New certificate or approval letter'],
    followups: ['The registration record updates when HQ accepts', 'The next renewal date recalculates on the calendar'] },
};

// ---------------------------------------------------------------- in-app notifications (the bell)
async function countryTeam(c, code) {
  return (await c.q(`SELECT DISTINCT u.id FROM users u JOIN user_countries uc ON uc.user_id=u.id WHERE u.status='active' AND u.role IN ('director','focal') AND uc.country_code=$1`, [code])).map((r) => r.id);
}
async function reviewers(c) {
  return (await c.q(`SELECT id FROM users WHERE status='active' AND role IN ('admin','reviewer')`)).map((r) => r.id);
}
async function leadersFor(c, code) {
  return (await c.q(`SELECT u.id FROM users u WHERE u.status='active' AND u.role='leader' AND (NOT EXISTS (SELECT 1 FROM user_countries x WHERE x.user_id=u.id) OR EXISTS (SELECT 1 FROM user_countries x WHERE x.user_id=u.id AND x.country_code=$1))`, [code])).map((r) => r.id);
}
// Deliver one notification to several people, never to the person who caused it.
async function notifyInbox(c, userIds, n, actorId) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== actorId);
  for (const id of ids) {
    await c.q(`INSERT INTO inbox (user_id, kind, title, body, link, country_code) VALUES ($1,$2,$3,$4,$5,$6)`, [id, n.kind, n.title, n.body || null, n.link || null, n.code || null]);
  }
}

module.exports = {
  ROLES, canReview, isAdmin, isPreparer, loadScope, AREAS, RESTRICTED_AREAS, STATUS, PHASES, CLOSE_STAGES, CHANGES,
  canSeeRestricted, countryFromOffice,
  todayISO, addDays, addMonths, boardIssues, FREQ_MONTHS, daysUntil, fmtDate, fmtShort, monthName, fmtWhen, decorate, fieldsFor,
  audit, getSettings, DEFAULT_SETTINGS, syncCountry, syncAll, openPlan, openAnnualCycles, currentCycle, fyLabel,
  applyAccepted, startClose, countryTeam, reviewers, leadersFor, notifyInbox,
};
