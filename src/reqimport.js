// Country requirements in Excel: a template generated from the live checklist, and an import that
// turns a filled-in template into local wording, local due dates, items not used in that country,
// and items for that country only. The import is previewed before anything is saved.
const ExcelJS = require('exceljs');
const db = require('./db');
const D = require('./domain');

const STAGES = { setup: 'Establish', annual: 'Annual cycle', close: 'Close out' };
const STAGE_OF = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [v.toLowerCase(), k]));
const TEAL = 'FF0F5A64'; const ORANGE = 'FFE39A2F'; const GREY = 'FFF1F5F5'; const PALE = 'FFE8F1F2';
const EXTRA_ROWS = 25;
const HEAD_ROW = 7;
const COLS = [
  ['Stage', 15], ['No.', 6], ['Standard requirement (all countries)', 52], ['Used in this country?', 13],
  ['Country wording (blank keeps the standard)', 52], ['Due: days after the cycle opens', 14], ['Close-out stage (1 to 4, new items only)', 14], ['Legal reference / notes', 34],
];

async function loadTemplates() {
  return db.q(`SELECT * FROM templates WHERE active AND country_code IS NULL ORDER BY CASE phase WHEN 'setup' THEN 1 WHEN 'annual' THEN 2 ELSE 3 END, seq`);
}

// ---------------------------------------------------------------- template
async function buildTemplate(countryCode) {
  const countries = await db.q(`SELECT code, name FROM countries ORDER BY name`);
  const country = countries.find((c) => c.code === countryCode) || null;
  const tpls = await loadTemplates();
  const locals = country ? await db.q(`SELECT * FROM template_local WHERE country_code=$1`, [country.code]) : [];
  const extras = country ? await db.q(`SELECT * FROM templates WHERE active AND country_code=$1 ORDER BY phase, seq`, [country.code]) : [];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECR 2.0';

  // How to fill this in
  const help = wb.addWorksheet('How to fill this in', { properties: { tabColor: { argb: ORANGE } } });
  help.getColumn(1).width = 110;
  const lines = [
    ['ECR 2.0 country requirements template', { bold: true, size: 16, color: { argb: TEAL } }],
    ['One file per country. It tells ECR how that country’s law differs from the standard checklist.', {}],
    ['', {}],
    ['On the Requirements sheet:', { bold: true }],
    ['1. Choose the country in cell B2, and fill in your name and the date.', {}],
    ['2. Every standard requirement is listed (Establish, Annual cycle, Close out). For each one:', {}],
    ['     • Used in this country?  Choose No if it never applies under this country’s law.', {}],
    ['     • Country wording  Write it as the country’s law says it, with form numbers and the authority, e.g. "File the annual return (Form 12) with the Registrar". Leave blank to keep the standard wording.', {}],
    ['     • Due  Only if the law sets a different deadline: days after the yearly cycle opens (the cycle opens on 1 October). Leave blank to keep the standard.', {}],
    ['     • Legal reference / notes  The act, regulation or section, if known.', {}],
    ['3. Requirements that exist only in this country go in the rows under "Additional requirements for this country only": choose the stage and write the requirement. For close-out items, give the stage (1 Decide, 2 Settle, 3 Report, 4 Deregister).', {}],
    ['4. Do not change the Stage, No. or Standard requirement columns of the listed rows; ECR uses them to match each line.', {}],
    ['', {}],
    ['Then send the file to the ECR administrator, who uploads it in ECR (Templates, Import from Excel). ECR shows every change for review before anything is saved, and the changes apply from the country’s next cycle.', {}],
  ];
  lines.forEach(([t, f], i) => { const c = help.getCell(i + 1, 1); c.value = t; c.font = { name: 'Calibri', size: 11, ...f }; c.alignment = { wrapText: true, vertical: 'top' }; });

  // Lists for drop-downs (hidden)
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  countries.forEach((c, i) => { lists.getCell(i + 1, 1).value = c.name; });
  ['Establish', 'Annual cycle', 'Close out'].forEach((v, i) => { lists.getCell(i + 1, 2).value = v; });
  const countryRange = `Lists!$A$1:$A$${Math.max(countries.length, 1)}`;

  // Requirements
  const ws = wb.addWorksheet('Requirements', { views: [{ state: 'frozen', ySplit: HEAD_ROW }], properties: { tabColor: { argb: TEAL } } });
  COLS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = 'ECR 2.0 · Country requirements';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: TEAL } };
  const meta = [['Country', country ? country.name : ''], ['Filled in by', ''], ['Date', '']];
  meta.forEach(([k, v], i) => {
    const r = 2 + i;
    ws.getCell(r, 1).value = k; ws.getCell(r, 1).font = { bold: true };
    ws.mergeCells(r, 2, r, 3);
    const c = ws.getCell(r, 2); c.value = v; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8EC' } }; c.border = { bottom: { style: 'thin', color: { argb: ORANGE } } };
  });
  ws.getCell('B2').dataValidation = { type: 'list', allowBlank: false, formulae: [countryRange], showErrorMessage: true, errorTitle: 'Country', error: 'Choose a country from the list.' };
  ws.getCell('E2').value = 'See "How to fill this in" for guidance.'; ws.getCell('E2').font = { italic: true, color: { argb: 'FF5B6B70' } };

  const head = ws.getRow(HEAD_ROW);
  COLS.forEach(([t], i) => { const c = head.getCell(i + 1); c.value = t; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
  head.height = 34;

  const yesNo = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'] };
  const dueRule = { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 730], showErrorMessage: true, error: 'A number of days between 1 and 730.' };
  let r = HEAD_ROW + 1;
  for (const t of tpls) {
    const l = locals.find((x) => x.template_id === t.id) || {};
    const row = ws.getRow(r);
    row.values = [STAGES[t.phase], t.seq, t.text, l.excluded ? 'No' : 'Yes', l.text || '', l.due_days || '', t.phase === 'close' ? t.stage : '', ''];
    [1, 2, 3].forEach((i) => { row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }; row.getCell(i).font = { color: { argb: 'FF3D5358' } }; });
    row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
    row.getCell(4).dataValidation = yesNo;
    if (t.phase !== 'close') row.getCell(6).dataValidation = dueRule; else row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
    row.alignment = { wrapText: true, vertical: 'top' };
    r++;
  }
  ws.mergeCells(r, 1, r, 8);
  const sec = ws.getCell(r, 1);
  sec.value = 'Additional requirements for this country only'; sec.font = { bold: true, color: { argb: TEAL } }; sec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE } };
  r++;
  for (let i = 0; i < EXTRA_ROWS; i++, r++) {
    const e = extras[i];
    const row = ws.getRow(r);
    row.values = e ? [STAGES[e.phase], '', '', 'Yes', e.text, e.phase === 'close' ? '' : e.due_days, e.phase === 'close' ? e.stage : '', ''] : ['', '', '', '', '', '', '', ''];
    row.getCell(1).dataValidation = { type: 'list', allowBlank: true, formulae: ['Lists!$B$1:$B$3'] };
    row.getCell(6).dataValidation = dueRule;
    row.getCell(7).dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 4] };
    [2, 3, 4].forEach((i2) => { row.getCell(i2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }; });
    row.alignment = { wrapText: true, vertical: 'top' };
  }
  ws.getColumn(2).alignment = { horizontal: 'center', vertical: 'top' };
  // One font throughout, and print on landscape pages one sheet wide
  for (const sh of [ws, help]) {
    sh.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (c) => { c.font = { name: 'Calibri', size: 11, ...(c.font || {}) }; }));
    sh.pageSetup = { orientation: sh === ws ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  }
  ws.pageSetup.printTitlesRow = `${HEAD_ROW}:${HEAD_ROW}`;
  return { buffer: await wb.xlsx.writeBuffer(), name: `ECR country requirements${country ? ' - ' + country.name : ''}.xlsx` };
}

// ---------------------------------------------------------------- import
const cellText = (c) => {
  const v = c && c.value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.result != null ? v.result : v.text != null ? v.text : (v.richText ? v.richText.map((x) => x.text).join('') : '')).trim();
  return String(v).trim();
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function parse(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { return { error: 'That file could not be read. Upload the .xlsx template, saved from Excel.' }; }
  const ws = wb.getWorksheet('Requirements');
  if (!ws) return { error: 'This is not the ECR requirements template (there is no Requirements sheet). Download the template from ECR and fill that in.' };
  const countries = await db.q(`SELECT code, name FROM countries`);
  const cname = cellText(ws.getCell('B2'));
  const country = countries.find((c) => norm(c.name) === norm(cname) || norm(c.code) === norm(cname));
  if (!country) return { error: cname ? `"${cname}" in cell B2 is not a country in ECR. Add the country first, or correct the name.` : 'Choose the country in cell B2 of the Requirements sheet.' };

  let headRow = 0;
  ws.eachRow((row, n) => { if (!headRow && norm(cellText(row.getCell(1))) === 'stage' && norm(cellText(row.getCell(2))) === 'no.') headRow = n; });
  if (!headRow) return { error: 'The header row (Stage, No., ...) is missing. Use the template downloaded from ECR.' };

  const tpls = await loadTemplates();
  const locals = await db.q(`SELECT * FROM template_local WHERE country_code=$1`, [country.code]);
  const extras = await db.q(`SELECT * FROM templates WHERE country_code=$1`, [country.code]);
  const plan = { country: country.code, countryName: country.name, by: cellText(ws.getCell('B3')), local: [], add: [], warnings: [], unchanged: 0 };

  for (let n = headRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const stageTxt = cellText(row.getCell(1)); const no = cellText(row.getCell(2));
    const used = norm(cellText(row.getCell(4))); const wording = cellText(row.getCell(5)).slice(0, 500);
    const dueTxt = cellText(row.getCell(6)); const stageNo = cellText(row.getCell(7)); const ref = cellText(row.getCell(8)).slice(0, 300);
    if (!stageTxt && !no && !wording) continue;
    if (norm(stageTxt).startsWith('additional requirements')) continue;
    const phase = STAGE_OF[norm(stageTxt)];
    if (!phase) { plan.warnings.push(`Row ${n}: stage "${stageTxt}" is not Establish, Annual cycle or Close out, so the row was skipped.`); continue; }
    let due = null;
    if (dueTxt) { due = Math.round(Number(dueTxt)); if (!(due >= 1 && due <= 730)) { plan.warnings.push(`Row ${n}: due "${dueTxt}" is not a number of days, so it was ignored.`); due = null; } }
    if (phase === 'close') due = null;

    if (no) { // a standard requirement
      const t = tpls.find((x) => x.phase === phase && String(x.seq) === String(Number(no)));
      if (!t) { plan.warnings.push(`Row ${n}: ${STAGES[phase]} item ${no} is not in the current checklist, so the row was skipped.`); continue; }
      const text = wording && norm(wording) !== norm(t.text) ? wording : null;
      const excluded = used === 'no';
      const cur = locals.find((x) => x.template_id === t.id) || {};
      if ((cur.text || null) === text && (cur.due_days || null) === due && !!cur.excluded === excluded) { plan.unchanged++; continue; }
      plan.local.push({ template_id: t.id, phase, seq: t.seq, standard: t.text, text, due, excluded, ref, was: { text: cur.text || null, due: cur.due_days || null, excluded: !!cur.excluded } });
    } else { // an item for this country only
      if (!wording) { plan.warnings.push(`Row ${n}: no requirement written, so the row was skipped.`); continue; }
      if (used === 'no') continue;
      if (extras.some((x) => x.phase === phase && norm(x.text) === norm(wording))) { plan.unchanged++; continue; }
      let stage = null;
      if (phase === 'close') { stage = Number(stageNo); if (!(stage >= 1 && stage <= 4)) { stage = 4; plan.warnings.push(`Row ${n}: close-out stage missing, so it was put in stage 4 (Deregister).`); } }
      plan.add.push({ phase, text: wording, due: due || 90, stage, ref });
    }
  }
  return { plan };
}

async function apply(plan, userId) {
  await db.tx(async (c) => {
    for (const l of plan.local) {
      if (!l.text && !l.due && !l.excluded) await c.q(`DELETE FROM template_local WHERE template_id=$1 AND country_code=$2`, [l.template_id, plan.country]);
      else await c.q(`INSERT INTO template_local (template_id, country_code, text, due_days, excluded) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (template_id, country_code) DO UPDATE SET text=EXCLUDED.text, due_days=EXCLUDED.due_days, excluded=EXCLUDED.excluded`, [l.template_id, plan.country, l.text, l.due, l.excluded]);
    }
    for (const a of plan.add) {
      const n = await c.one(`SELECT COALESCE(max(seq),0)+1 AS n FROM templates WHERE phase=$1`, [a.phase]);
      await c.q(`INSERT INTO templates (phase, seq, text, due_days, stage, country_code) VALUES ($1,$2,$3,$4,$5,$6)`, [a.phase, n.n, a.text, a.due, a.stage, plan.country]);
    }
    const parts = [`${plan.local.length} standard item${plan.local.length === 1 ? '' : 's'} adapted`, `${plan.add.length} added for ${plan.countryName} only`];
    await D.audit(userId, 'template.imported', `${plan.countryName} requirements imported from Excel${plan.by ? ' (filled in by ' + plan.by + ')' : ''}: ${parts.join(', ')}`, plan.country, null, c);
  });
}

module.exports = { buildTemplate, parse, apply, STAGES };
