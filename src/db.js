const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates shifted by timezone.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ ...config.db, max: 10 });

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn({
      q: async (t, p) => (await c.query(t, p)).rows,
      one: async (t, p) => (await c.query(t, p)).rows[0] || null,
    });
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, q, one, tx };
