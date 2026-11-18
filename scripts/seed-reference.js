// Real starting data for ECR 2.0, taken from the Country Compliance Registry prototype and Forms 01-08:
// the six country offices, their registration regimes and board rules, and the Lesotho, Malawi and
// Côte d'Ivoire wording of the standard checklists. It adds no people, numbers or dates: those are
// entered by HQ and the country teams. Safe to run more than once; it never overwrites edits.
// Usage: node scripts/seed-reference.js     (refuses while the sample data is loaded; clear it first)
const db = require('../src/db');
const D = require('../src/domain');

const VERIFY = 'Starting point from the compliance registry prototype. Confirm against the certificate and local law.';
// [code, name, entity type, authority, currency, renewal frequency, board rules]
const COUNTRIES = [
  ['LSO', 'Lesotho', 'External company (foreign NGO)', 'Registrar of Companies, Ministry of Trade', 'LSL', 'Annual', { board_min: '3', term_limit: 'Two terms of three years' }],
  ['MWI', 'Malawi', 'Registered NGO', 'NGO Regulatory Authority (NGORA)', 'MWK', 'Annual', { board_min: '5', term_limit: 'Three terms of two years' }],
  ['MOZ', 'Mozambique', 'Foreign NGO accreditation', 'Ministry of Foreign Affairs and Cooperation', 'MZN', 'Every 5 years', { board_min: '3', term_limit: 'Two terms of four years' }],
  ['CMR', 'Cameroon', 'Foreign association (authorisation)', 'Ministry of Territorial Administration (MINAT)', 'XAF', 'Every 3 years', { board_min: '3', term_limit: 'Not specified' }],
  ['COD', 'DRC', 'International NGO (favourable opinion)', 'Ministry of Justice', 'CDF', 'Every 5 years', null],
  ['CIV', "Côte d'Ivoire", 'NGO declaration', 'Ministry of the Interior', 'XOF', 'No renewal (declaration regime)', null],
];
// Local wording of standard items: [phase, seq, country, text]
const LOCAL = [
  ['setup', 1, 'LSO', 'Apply within 10 days of establishing a place of business in Lesotho'],
  ['setup', 2, 'LSO', 'Submit the Form 3 application to the Registrar'],
  ['annual', 1, 'LSO', 'File the annual report / annual return (Form 12) with the Registrar'],
  ['annual', 7, 'LSO', 'Maintain a registered office in Lesotho'],
  ['close', 11, 'LSO', 'Submit the notice of completion to the Master and the Registrar'],
  ['close', 13, 'LSO', 'Cease legal existence in Lesotho after completion'],
  ['annual', 1, 'MWI', 'File the annual NGO return with the NGO Regulatory Authority (NGORA)'],
  ['annual', 6, 'MWI', 'Submit audited financial statements to NGORA'],
  ['annual', 1, 'CIV', 'Submit the annual activity report to the Ministry of the Interior'],
];
// Items that exist in one country only: [phase, country, text, due days]
const ONLY = [
  ['annual', 'MWI', 'File the tax exemption renewal with the Malawi Revenue Authority', 120],
  ['setup', 'MWI', 'Obtain affiliation with the Council for NGOs in Malawi (CONGOMA)', 60],
  ['setup', 'MWI', 'Register with the Malawi Revenue Authority for tax exemption', 75],
];

(async () => {
  const demo = await db.one(`SELECT count(*)::int n FROM users WHERE email LIKE '%.demo@pedaids.org'`);
  if (demo.n) { console.log('[reference] sample data is loaded. Run: node scripts/seed-demo.js --clear   then run this again.'); await db.pool.end(); return; }
  let added = 0;
  for (const [code, name, entity, authority, ccy, freq, board] of COUNTRIES) {
    const r = await db.one(`INSERT INTO countries (code, name, phase, entity_type, authority, currency, rules) VALUES ($1,$2,'operate',$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, name, entity, authority, ccy, JSON.stringify(board ? { board_required: true, ...board, local_majority: true, independent_required: true, meeting_frequency: 'Quarterly', source: VERIFY } : {})]);
    if (!r) continue;
    added++;
    await db.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'registration',$2)`, [code, JSON.stringify({ category: entity, authority, renewal_frequency: freq, renewal_required: !/No renewal/.test(freq), notes: VERIFY })]);
    await D.audit(null, 'country.added', `${name} added from the reference data (${entity}; ${authority})`, code);
  }
  for (const [phase, seq, code, text] of LOCAL) {
    const t = await db.one(`SELECT id FROM templates WHERE phase=$1 AND seq=$2 AND country_code IS NULL`, [phase, seq]);
    if (t) await db.q(`INSERT INTO template_local (template_id, country_code, text) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t.id, code, text]);
  }
  for (const [phase, code, text, due] of ONLY) {
    const have = await db.one(`SELECT id FROM templates WHERE phase=$1 AND country_code=$2 AND text=$3`, [phase, code, text]);
    if (have) continue;
    const n = await db.one(`SELECT COALESCE(max(seq),0)+1 AS n FROM templates WHERE phase=$1`, [phase]);
    await db.q(`INSERT INTO templates (phase, seq, text, due_days, country_code) VALUES ($1,$2,$3,$4,$5)`, [phase, n.n, text, due, code]);
  }
  const { label, opened } = await D.openAnnualCycles(null);
  await D.syncAll();
  console.log(`[reference] ${added} countries added, local wording and country items in place, ${label} opened for ${opened} countries`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
