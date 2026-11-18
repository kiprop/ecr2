// Sample countries, people, registers and a part-finished cycle so testers have something real to click.
// Usage: node scripts/seed-demo.js          (refuses if countries already exist)
//        node scripts/seed-demo.js --force  (wipes ALL data except templates, settings and real users first)
//        node scripts/seed-demo.js --clear  (wipes it and stops: use before going live with real data)
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const D = require('../src/domain');

function rng(seed) { let h = 2166136261; for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const COUNTRIES = [
  ['LSO', 'Lesotho', 'operate', 0.5, 'Foreign NGO (external company)', 'Registrar of Companies', 'Mar 2019', 'LSL', ['Standard Lesotho Bank', 'Nedbank Lesotho'], ['Mokhele', 'Lerotholi', 'Sello', 'Phiri', 'Moshoeshoe']],
  ['SWZ', 'Eswatini', 'operate', 1, 'Foreign NGO', 'Registrar of Companies', 'Jun 2011', 'SZL', ['Standard Bank Eswatini', 'FNB Eswatini'], ['Dlamini', 'Simelane', 'Nxumalo', 'Mamba', 'Shongwe']],
  ['MWI', 'Malawi', 'operate', 0.72, 'International NGO', 'NGO Regulatory Authority', 'Feb 2005', 'MWK', ['National Bank of Malawi', 'Standard Bank Malawi'], ['Banda', 'Chirwa', 'Mwale', 'Kachali', 'Nyirenda']],
  ['TZA', 'Tanzania', 'operate', 0.38, 'International NGO', 'Registrar of NGOs', 'Aug 2004', 'TZS', ['CRDB Bank', 'NMB Bank'], ['Mushi', 'Kimaro', 'Mrema', 'Juma', 'Mollel']],
  ['UGA', 'Uganda', 'operate', 0.62, 'Foreign NGO', 'National Bureau for NGOs', 'Jan 2006', 'UGX', ['Stanbic Bank Uganda', 'Absa Uganda'], ['Okello', 'Namubiru', 'Mugisha', 'Atim', 'Kato']],
  ['KEN', 'Kenya', 'operate', 0.78, 'International public benefit organisation', 'PBO Regulatory Authority', 'Apr 2007', 'KES', ['Stanbic Kenya', 'Equity Bank'], ['Wanjiru', 'Otieno', 'Kiprono', 'Mutua', 'Achieng']],
  ['MOZ', 'Mozambique', 'establish', 0.6, 'Foreign NGO (pending)', 'Ministry of Foreign Affairs', null, 'MZN', [], []],
  ['CMR', 'Cameroon', 'close', 0.66, 'Foreign association', 'Ministry of Territorial Administration', 'Sep 2009', 'XAF', ['Afriland First Bank', 'Société Générale Cameroun'], ['Nkemelu', 'Fon', 'Mbah', 'Tchoua', 'Ngono']],
];
const USERS = [
  ['Grace Wanjiru', 'admin', []], ['David Okello', 'reviewer', []], ['Helen Banda', 'leader', []], ['Thabo Ramakatsa', 'director', ['LSO']],
  ['Palesa Mokoena', 'focal', ['LSO']], ['Chikondi Phiri', 'focal', ['MWI', 'TZA']], ['Amina Juma', 'director', ['TZA']], ['João Macuácua', 'focal', ['MOZ']], ['Paul Nkemelu', 'focal', ['CMR']],
];

(async () => {
  const clear = process.argv.includes('--clear');
  const force = clear || process.argv.includes('--force');
  const have = (await db.one(`SELECT count(*)::int n FROM countries`)).n;
  if (have && !force) { console.log('[demo] countries already exist; use --force to wipe and reseed'); process.exit(0); }
  if (force) {
    await db.q(`ALTER TABLE events DISABLE TRIGGER events_no_update`);
    await db.q(`TRUNCATE inbox, notifications, documents, obligations, register_records, cycles, template_local, user_countries, events, countries RESTART IDENTITY CASCADE`);
    await db.q(`DELETE FROM users WHERE email LIKE '%.demo@pedaids.org'`);
    await db.q(`ALTER TABLE events ENABLE TRIGGER events_no_update`);
    if (clear) { console.log('[demo] cleared: countries, registers, obligations, documents, events and sample people removed'); await db.pool.end(); return; }
  }
  const today = D.todayISO();
  const [y, m] = today.split('-').map(Number);
  const cycleOpen = `${m >= 10 ? y : y - 1}-10-01`;
  const label = D.fyLabel(cycleOpen, 10);
  const demoDir = path.join(config.storageDir, 'demo'); fs.mkdirSync(demoDir, { recursive: true });
  const ev = async (who, action, detail, code, oid, at) => db.q(`INSERT INTO events (user_id, action, detail, country_code, obligation_id, at) VALUES ($1,$2,$3,$4,$5,$6)`, [who, action, detail, code, oid, at]);
  const doc = async (oid, name, who) => { const p = path.join(demoDir, `${oid}-${name}`); fs.writeFileSync(p, `Sample evidence for ECR 2.0 testing.\n${name}\n`); await db.q(`INSERT INTO documents (obligation_id, label, filename, mime, size_bytes, storage_path, uploaded_by) VALUES ($1,'Evidence',$2,'text/plain',60,$3,$4)`, [oid, name, p, who]); };
  const ago = (days) => new Date(Date.now() - days * 86400000);

  for (const [code, name, phase, , entity, auth, reg, ccy] of COUNTRIES) await db.q(`INSERT INTO countries (code, name, phase, entity_type, authority, registered_on, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [code, name, phase, entity, auth, reg, ccy]);
  const t1 = await db.one(`SELECT id FROM templates WHERE phase='annual' AND seq=1`);
  await db.q(`INSERT INTO template_local VALUES ($1,'LSO','File annual return (Form 12) with the Registrar'), ($1,'MWI','File annual returns and audited accounts with the NGO Regulatory Authority'), ($1,'KEN','File the annual return with the PBO Regulatory Authority')`, [t1.id]);

  const uid = {};
  for (const [nm, role, cs] of USERS) {
    const email = nm.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.') + '.demo@pedaids.org';
    const u = await db.one(`INSERT INTO users (email, name, role, status, last_login_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET role=EXCLUDED.role RETURNING id`, [email, nm, role, nm.startsWith('João') ? 'invited' : 'active', nm.startsWith('João') ? null : ago(Math.floor(Math.random() * 5))]);
    uid[nm] = u.id;
    for (const c of cs) await db.q(`INSERT INTO user_countries VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, c]);
  }
  const reviewer = uid['David Okello'];
  await ev(uid['Grace Wanjiru'], 'user.invited', 'invited João Macuácua as Country focal point for Mozambique', null, null, ago(6));

  for (const [code, , phase, health, , , , ccy, banks, people] of COUNTRIES) {
    const r = rng(code); const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
    const preparer = Object.entries(uid).find(([nm]) => USERS.find((u) => u[0] === nm && u[2].includes(code) && (u[1] === 'focal' || u[1] === 'director')));
    const prep = preparer ? preparer[1] : null;

    if (phase === 'establish') {
      await db.tx((c) => D.openPlan(c, code, 'setup', 'Registration', uid['Grace Wanjiru']));
      await db.q(`UPDATE cycles SET opened_on=$2 WHERE country_code=$1`, [code, D.addDays(today, -70)]);
      const items = await db.q(`SELECT o.id, o.seq, t.due_days FROM obligations o JOIN templates t ON t.id=o.template_id WHERE o.country_code=$1 ORDER BY o.seq`, [code]);
      for (const o of items) {
        const st = o.seq <= 8 ? 'accepted' : o.seq === 9 ? 'submitted' : 'todo';
        await db.q(`UPDATE obligations SET due_date=$2, status=$3, submitted_at=$4, submitted_by=$5, reviewed_at=$6, reviewed_by=$7 WHERE id=$1`,
          [o.id, D.addDays(today, -70 + o.due_days), st, st !== 'todo' ? ago(20 - o.seq) : null, st !== 'todo' ? prep : null, st === 'accepted' ? ago(18 - o.seq) : null, st === 'accepted' ? reviewer : null]);
        if (st !== 'todo') { await doc(o.id, `setup_step_${o.seq}.pdf`, prep); await ev(prep, 'item.submitted', 'submitted with evidence', code, o.id, ago(20 - o.seq)); }
        if (st === 'accepted') await ev(reviewer, 'item.accepted', 'accepted', code, o.id, ago(18 - o.seq));
      }
      continue;
    }

    // registers
    const regId = (await db.one(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'registration',$2) RETURNING id`, [code, JSON.stringify({ category: COUNTRIES.find((x) => x[0] === code)[4], authority: COUNTRIES.find((x) => x[0] === code)[5], reg_number: `[${code}-REG-NO]`, registered_on: null, expires_on: D.addDays(today, ri(40, 210)), renewal_frequency: 'Annual', last_legal_review: D.addDays(today, -ri(250, 380)), tax_status: 'Exemption on file' })])).id;
    const initials = ['N.', 'M.', 'K.', 'R.', 'A.'];
    const roles = ['Chair', 'Treasurer', 'Secretary', 'Member (independent)', 'Member (local national)'];
    for (let i = 0; i < 5; i++) {
      await db.q(`INSERT INTO register_records (country_code, kind, data, created_at) VALUES ($1,'board',$2,$3)`, [code, JSON.stringify({
        name: `${initials[i]} ${people[i]}`, position: roles[i], appointed_on: D.addDays(today, -ri(300, 1400)), term_ends: i === 1 ? D.addDays(today, ri(15, 80)) : D.addDays(today, ri(400, 1200)),
        local_national: i === 4 || r() < 0.5, independent: i === 3, coi_on_file: !(i === 2 && r() < 0.6), vetting_done: true }), ago(ri(10, 40))]);
    }
    await db.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'poa',$2), ($1,'poa',$3)`, [code,
      JSON.stringify({ holder: 'Country Director', position: 'Country Director', scope: 'Full legal representation', effective_on: D.addDays(today, -300), expires_on: D.addDays(today, ri(10, 160)), notarised: true, registered_locally: true }),
      JSON.stringify({ holder: 'Finance Manager', position: 'Finance Manager', scope: 'Banking and contracts up to the delegated threshold', effective_on: D.addDays(today, -200), expires_on: D.addDays(today, ri(200, 500)), notarised: true, registered_locally: true })]);
    for (const [i, b] of banks.entries()) {
      await db.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'bank',$2)`, [code, JSON.stringify({ bank: b, account_type: i === 0 ? 'Operating' : 'Project', currency: i === 0 ? ccy : 'USD', last4: String(1000 + Math.floor(r() * 8999)), signatories: i === 0 ? 'Country Director, Finance Manager, Operations Lead' : 'Country Director, Finance Manager', rule: i === 0 ? 'any 2' : 'both', threshold: i === 0 ? 'USD 3,000 equivalent' : 'All payments', last_confirmed_on: D.addDays(today, i === 0 ? -ri(340, 390) : -ri(100, 300)), mandate_on_file: true, kyc_on_file: true })]);
    }

    // annual cycle
    await db.tx((c) => D.openPlan(c, code, 'annual', label, uid['Grace Wanjiru']));
    const cyc = await db.one(`UPDATE cycles SET opened_on=$2 WHERE country_code=$1 AND kind='annual' RETURNING id`, [code, cycleOpen]);
    const items = await db.q(`SELECT o.id, o.seq, t.due_days FROM obligations o JOIN templates t ON t.id=o.template_id WHERE o.cycle_id=$1 ORDER BY o.seq`, [cyc.id]);
    let returned = false;
    for (const o of items) {
      const due = D.addDays(cycleOpen, o.due_days); const x = r();
      let st;
      if (code === 'SWZ') st = o.seq >= 11 && o.seq <= 13 ? 'na' : 'accepted';
      else if (o.seq >= 11 && o.seq <= 13 && r() < 0.75) st = 'na';
      else if (code === 'LSO' && o.seq === 6) st = 'returned';
      else if (x < health) st = 'accepted';
      else if (x < health + 0.14) st = 'submitted';
      else st = 'todo';
      if (st === 'todo' && !returned && code !== 'LSO' && r() < 0.3) st = 'returned';
      if (st === 'returned') returned = true;
      const note = st === 'returned' ? (o.seq === 6 ? 'The report attached is for the previous year. Please upload this year’s audit engagement letter or the draft report.' : 'The document is unsigned. Please upload the signed version.') : null;
      const sAt = ago(ri(4, 40));
      await db.q(`UPDATE obligations SET due_date=$2, status=$3, review_note=$4, submitted_at=$5, submitted_by=$6, reviewed_at=$7, reviewed_by=$8 WHERE id=$1`,
        [o.id, due, st, note, st !== 'todo' && st !== 'na' ? sAt : null, st !== 'todo' && st !== 'na' ? prep : null, ['accepted', 'returned'].includes(st) ? ago(2) : null, ['accepted', 'returned'].includes(st) ? reviewer : null]);
      if (['accepted', 'submitted', 'returned'].includes(st)) { await doc(o.id, `evidence_item_${o.seq}.pdf`, prep); await ev(prep, 'item.submitted', 'submitted with evidence', code, o.id, sAt); }
      if (st === 'accepted') await ev(reviewer, 'item.accepted', 'accepted', code, o.id, ago(2));
      if (st === 'returned') await ev(reviewer, 'item.returned', note, code, o.id, ago(2));
      if (st === 'na') await ev(prep, 'item.na', 'not applicable this cycle', code, o.id, ago(30));
    }
    if (code === 'SWZ') await db.q(`UPDATE cycles SET status='signed_off', signed_at=$2 WHERE id=$1`, [cyc.id, ago(3)]);
    if (code === 'LSO') await db.q(`UPDATE obligations SET due_date=$2, status='todo', review_note=NULL WHERE cycle_id=$1 AND seq=16`, [cyc.id, D.addDays(today, -18)]);
    await D.syncCountry(code);
    if (code === 'CMR') {
      await db.tx((c) => D.startClose(c, code, reviewer));
      await db.q(`UPDATE obligations SET status='accepted', reviewed_at=now(), reviewed_by=$2 WHERE country_code=$1 AND area='close' AND seq <= 6`, [code, reviewer]);
    }
    // a few register tasks already submitted
    const regOpen = await db.q(`SELECT id FROM obligations WHERE country_code=$1 AND source_type IS NOT NULL AND status='todo'`, [code]);
    for (const o of regOpen) if (r() < 0.15) { await db.q(`UPDATE obligations SET status='submitted', submitted_at=$2, submitted_by=$3 WHERE id=$1`, [o.id, ago(3), prep]); await doc(o.id, 'confirmation.pdf', prep); await ev(prep, 'item.submitted', 'submitted with evidence', code, o.id, ago(3)); }
    void regId;
  }
  console.log(`[demo] seeded ${COUNTRIES.length} countries, ${USERS.length} sample people, cycle ${label}`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
