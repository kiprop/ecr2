// Standard templates and default settings. Safe to run more than once.
const { pool } = require('../src/db');
const { DEFAULT_SETTINGS } = require('../src/domain');

const SETUP = [
  'Apply within the legal window after establishing a place of business', 'Submit the registration application to the authority', 'Application signed by or for the organisation',
  'Provide the organisation name', 'Provide directors’ names, nationalities and addresses', 'Provide the local office address', 'Submit proof of foreign incorporation',
  'Submit constitutional and governing documents', 'Provide certified translations where required', 'Obtain name approval', 'Appoint local authorised representative(s)', 'Obtain the Certificate of Registration',
];
// [text, due days after the cycle opens]
const ANNUAL = [
  ['File the annual return with the registering authority', 120], ['Prepare annual financial statements', 90], ['Maintain accounting records', 60], ['Comply with accounting standards', 60],
  ['Appoint an auditor where required', 30], ['Facilitate the audit and keep the auditor report', 75], ['Maintain a registered office', 30], ['Maintain an address for service', 30],
  ['Maintain statutory records', 60], ['Notify the authority of director changes', 365], ['Notify the authority of governing document changes', 365], ['Notify the authority of local representative changes', 365],
  ['Notify the authority of registered office changes', 365], ['Maintain board governance and meeting records', 90], ['Use funds only for approved non-profit purposes', 300], ['Renew sector-specific licences and approvals', 30],
];
// [text, stage]
const CLOSE = [
  ['Approve dissolution or closure under the governing documents', 1], ['Commence dissolution proceedings', 1], ['Notify stakeholders and creditors', 2], ['Identify all liabilities and creditor claims', 2],
  ['Settle debts and obligations', 2], ['Distribute remaining assets under the governing documents', 2], ['Complete liquidator responsibilities (if applicable)', 2], ['Prepare notice of completion of dissolution', 3],
  ['Confirm all known claims are resolved', 3], ['Confirm all assets have been distributed', 3], ['Submit the final notice to the authorities', 3], ['Obtain the deregistration recording', 4], ['Cease legal existence in the country', 4],
];

(async () => {
  const n = (await pool.query(`SELECT count(*)::int n FROM templates`)).rows[0].n;
  if (!n) {
    for (const [i, t] of SETUP.entries()) await pool.query(`INSERT INTO templates (phase, seq, text, due_days) VALUES ('setup',$1,$2,$3)`, [i + 1, t, 30 + i * 5]);
    for (const [i, [t, dd]] of ANNUAL.entries()) await pool.query(`INSERT INTO templates (phase, seq, text, due_days) VALUES ('annual',$1,$2,$3)`, [i + 1, t, dd]);
    for (const [i, [t, st]] of CLOSE.entries()) await pool.query(`INSERT INTO templates (phase, seq, text, due_days, stage) VALUES ('close',$1,$2,60,$3)`, [i + 1, t, st]);
    console.log('[seed] templates added');
  } else console.log('[seed] templates already present');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await pool.query(`INSERT INTO settings VALUES ($1,$2) ON CONFLICT DO NOTHING`, [k, JSON.stringify(v)]);
  console.log('[seed] settings ok');
  await pool.end();
})();
