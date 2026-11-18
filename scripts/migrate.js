// Applies migrations/*.sql in order, once each.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, '..', 'migrations');
  const done = new Set((await pool.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    console.log(`[migrate] apply ${f}`);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); console.error(`[migrate] ${f} failed:`, e.message); process.exit(1); } finally { c.release(); }
  }
  console.log('[migrate] up to date');
  await pool.end();
})();
