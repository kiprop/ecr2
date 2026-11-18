// Background jobs: keep register deadlines in sync, open the annual cycle, send reminders and the weekly digest.
const config = require('./config');
const db = require('./db');
const D = require('./domain');
const graph = require('./graph');

const link = (id) => `${config.appBaseUrl}${config.basePath}/?item=${id}`;
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${Math.ceil(((t - y) / 86400000 + 1) / 7)}`; };

async function notify(user, kind, key, subject, html, obligationId) {
  const ins = await db.one(`INSERT INTO notifications (user_id, obligation_id, kind, dedupe_key, subject) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [user.id, obligationId || null, kind, key, subject]);
  if (!ins) return;
  if (kind === 'reminder' && obligationId) {
    const o = await db.one(`SELECT o.title, o.due_date, o.country_code, c.name FROM obligations o JOIN countries c ON c.code=o.country_code WHERE o.id=$1`, [obligationId]);
    const days = D.daysUntil(o.due_date);
    await D.notifyInbox(db, [user.id], { kind: days < 0 ? 'overdue' : 'deadline', title: days < 0 ? `Overdue: ${o.title}` : `Due in ${days} days: ${o.title}`, body: `${o.name} · due ${D.fmtDate(o.due_date)}`, link: `/?item=${obligationId}`, code: o.country_code });
  }
  const status = await graph.sendMail(user.email, subject, html);
  await db.q(`UPDATE notifications SET status=$2 WHERE id=$1`, [ins.id, status]);
}

async function run() {
  const s = await D.getSettings();
  const now = new Date();

  // 1. Open the annual cycle from the 1st of the cycle month
  if (now.getMonth() + 1 === s.cycle_month) {
    const out = await D.openAnnualCycles(null);
    if (out.opened) console.log(`[worker] opened ${out.label} for ${out.opened} countries`);
  }

  // 2. Register-driven deadlines
  await D.syncAll();

  // 3. Reminders to the country team at each lead time, then weekly when overdue
  const obs = await db.q(`SELECT o.*, c.name AS country_name FROM obligations o JOIN countries c ON c.code=o.country_code WHERE o.status IN ('todo','returned') AND o.due_date IS NOT NULL AND c.phase <> 'closed'`);
  const team = await db.q(`SELECT u.*, uc.country_code FROM users u JOIN user_countries uc ON uc.user_id=u.id WHERE u.status='active' AND u.role IN ('director','focal')`);
  const week = isoWeek(now);
  for (const o of obs) {
    const days = D.daysUntil(o.due_date);
    let key = null;
    if (s.lead_days.includes(days)) key = `${o.id}:lead:${days}`;
    else if (days < 0 && now.getDay() === 1) key = `${o.id}:overdue:${week}`;
    if (!key) continue;
    const subject = days < 0 ? `Overdue: ${o.title} (${o.country_name})` : `Due in ${days} days: ${o.title} (${o.country_name})`;
    const html = `<p><b>${o.title}</b><br>${o.country_name} · ${D.AREAS[o.area]} · due ${D.fmtDate(o.due_date)}</p><p><a href="${link(o.id)}">Open it in ECR 2.0</a></p>`;
    for (const u of team.filter((x) => x.country_code === o.country_code)) await notify(u, 'reminder', `${key}:${u.id}`, subject, html, o.id);
  }

  // 4. Monday digest
  if (s.digest && now.getDay() === 1) {
    const users = await db.q(`SELECT * FROM users WHERE status='active'`);
    for (const u of users) {
      const scope = await D.loadScope(u);
      let lines = [];
      if (D.canReview(u)) {
        const n = (await db.one(`SELECT count(*)::int n FROM obligations WHERE status='submitted' AND country_code = ANY($1)`, [scope])).n;
        if (n) lines.push(`${n} submissions are waiting for review.`);
      }
      const open = await db.q(`SELECT o.*, c.name AS country_name FROM obligations o JOIN countries c ON c.code=o.country_code WHERE o.status IN ('todo','returned') AND o.due_date <= CURRENT_DATE + 30 AND o.country_code = ANY($1) ORDER BY o.due_date LIMIT 15`, [scope]);
      if (D.isPreparer(u)) lines = lines.concat(open.map((o) => `${o.country_name}: ${o.title} · ${o.status === 'returned' ? 'returned by HQ' : 'due ' + D.fmtDate(o.due_date)}`));
      else if (open.length) lines.push(`${open.filter((o) => D.daysUntil(o.due_date) < 0).length} overdue and ${open.length} due within 30 days across your countries.`);
      if (!lines.length) continue;
      await notify(u, 'digest', `digest:${u.id}:${D.todayISO()}`, 'Your week in the EGPAF Compliance Registry', `<p>Hello ${u.name.split(' ')[0]},</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul><p><a href="${config.appBaseUrl}${config.basePath}/">Open ECR 2.0</a></p>`);
    }
  }
}

async function loop() {
  try { await run(); } catch (e) { console.error('[worker]', e); }
  setTimeout(loop, config.workerIntervalMin * 60000);
}
if (require.main === module) { console.log(`[worker] every ${config.workerIntervalMin} min`); loop(); }
module.exports = { run };
