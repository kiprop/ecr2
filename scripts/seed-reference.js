// Production starting data for ECR 2.0: the six country offices with their entity type, registering
// authority and currency, and checklist wording taken from the Lesotho Forms 01-03. Only facts that
// fit production are loaded. Renewal frequency, board rules, registration numbers, dates and people
// are left for HQ and the country teams to enter. Safe to run more than once; never overwrites edits.
// Usage: node scripts/seed-reference.js     (refuses while the sample data is loaded; clear it first)
const db = require('../src/db');
const D = require('../src/domain');

// [code, name, entity type, registering authority, currency]
const COUNTRIES = [
  ['LSO', 'Lesotho', 'External company (foreign NGO)', 'Registrar of Companies', 'LSL'],
  ['MWI', 'Malawi', 'Registered NGO', 'NGO Regulatory Authority (NGORA)', 'MWK'],
  ['MOZ', 'Mozambique', 'Foreign NGO', 'Ministry of Foreign Affairs and Cooperation', 'MZN'],
  ['CMR', 'Cameroon', 'Foreign association', 'Ministry of Territorial Administration (MINAT)', 'XAF'],
  ['COD', 'DRC', 'International NGO', 'Ministry of Justice', 'CDF'],
  ['CIV', "Côte d'Ivoire", 'NGO', 'Ministry of the Interior', 'XOF'],
];
// Local wording of standard items, from the Lesotho source forms: [phase, seq, country, text]
const LOCAL = [
  ['setup', 1, 'LSO', 'Apply within 10 days of establishing a place of business in Lesotho'],
  ['setup', 2, 'LSO', 'Submit the Form 3 application to the Registrar'],
  ['annual', 1, 'LSO', 'File the annual report / annual return (Form 12) with the Registrar'],
  ['annual', 7, 'LSO', 'Maintain a registered office in Lesotho'],
  ['close', 11, 'LSO', 'Submit the notice of completion to the Master and the Registrar'],
  ['close', 13, 'LSO', 'Cease legal existence in Lesotho after completion'],
];

(async () => {
  const demo = await db.one(`SELECT count(*)::int n FROM users WHERE email LIKE '%.demo@pedaids.org'`);
  if (demo.n) { console.log('[reference] sample data is loaded. Run: node scripts/seed-demo.js --clear   then run this again.'); await db.pool.end(); return; }
  let added = 0;
  for (const [code, name, entity, authority, ccy] of COUNTRIES) {
    const r = await db.one(`INSERT INTO countries (code, name, phase, entity_type, authority, currency) VALUES ($1,$2,'operate',$3,$4,$5) ON CONFLICT (code) DO NOTHING RETURNING code`, [code, name, entity, authority, ccy]);
    if (!r) continue;
    added++;
    await db.q(`INSERT INTO register_records (country_code, kind, data) VALUES ($1,'registration',$2)`, [code, JSON.stringify({ category: entity, authority })]);
    await D.audit(null, 'country.added', `${name} added from the reference data (${entity}; ${authority})`, code);
  }
  for (const [phase, seq, code, text] of LOCAL) {
    const t = await db.one(`SELECT id FROM templates WHERE phase=$1 AND seq=$2 AND country_code IS NULL`, [phase, seq]);
    if (t) await db.q(`INSERT INTO template_local (template_id, country_code, text) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t.id, code, text]);
  }
  const { label, opened } = await D.openAnnualCycles(null);
  await D.syncAll();
  console.log(`[reference] ${added} countries added, Lesotho wording in place, ${label} opened for ${opened} countries`);
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
