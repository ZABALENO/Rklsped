// Jednoduché úložiště klíč–hodnota: Postgres (Neon) přes DATABASE_URL, jinak soubor.
const fs = require('fs');
const path = require('path');

async function createStore(table, namespaces, fileName) {
  const mem = Object.fromEntries(namespaces.map(n => [n, {}]));
  let pool = null;
  const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), fileName);
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const u = new URL(process.env.DATABASE_URL.trim());
    const host = u.hostname;
    const needSsl = host.includes('.') && host !== '127.0.0.1' && u.searchParams.get('sslmode') !== 'disable';
    for (const p of ['sslmode', 'channel_binding', 'sslrootcert']) u.searchParams.delete(p);
    pool = new Pool({ connectionString: u.toString(), ssl: needSsl ? { rejectUnauthorized: false } : false, max: 3, idleTimeoutMillis: 30000 });
    pool.on('error', e => console.error('DB:', e.message));
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      ns text NOT NULL, k text NOT NULL, v jsonb NOT NULL, u timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ns, k))`);
    const { rows } = await pool.query(`SELECT ns, k, v FROM ${table}`);
    for (const r of rows) if (mem[r.ns]) mem[r.ns][r.k] = r.v;
    console.log(`Úložiště: Postgres/${table} (${rows.length} záznamů)`);
  } else {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      if (fs.existsSync(FILE)) Object.assign(mem, JSON.parse(fs.readFileSync(FILE, 'utf8')));
      for (const n of namespaces) mem[n] = mem[n] || {};
    } catch (e) { console.error('Soubor úložiště nelze načíst:', e.message); }
    console.log('Úložiště: soubor (dočasné – nastav DATABASE_URL)');
  }
  let timer = null;
  async function put(ns, k, v) {
    if (v == null) delete mem[ns][k]; else mem[ns][k] = v;
    if (pool) {
      try {
        if (v == null) await pool.query(`DELETE FROM ${table} WHERE ns=$1 AND k=$2`, [ns, k]);
        else await pool.query(`INSERT INTO ${table} (ns,k,v,u) VALUES ($1,$2,$3,now())
          ON CONFLICT (ns,k) DO UPDATE SET v=EXCLUDED.v, u=now()`, [ns, k, JSON.stringify(v)]);
      } catch (e) { console.error('DB zápis selhal:', e.message); }
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { console.error(e.message); } }, 300);
    }
  }
  return { mem, put, kind: pool ? 'db' : 'file' };
}
module.exports = { createStore };
