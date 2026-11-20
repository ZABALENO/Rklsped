// Vlastní měření zdrojů služby (paměť, CPU, běh) – bez Render API klíče: čte cgroup kontejneru (limit = zaplacený plán)
const fs = require('fs');
const rd = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } };
const num = s => { const n = Number(s); return Number.isFinite(n) ? n : null; };
function memory() {
  let cur = num(rd('/sys/fs/cgroup/memory.current')), lim = rd('/sys/fs/cgroup/memory.max');
  if (cur == null) { cur = num(rd('/sys/fs/cgroup/memory/memory.usage_in_bytes')); lim = rd('/sys/fs/cgroup/memory/memory.limit_in_bytes'); }
  lim = lim && lim !== 'max' ? num(lim) : null; if (lim && lim > 1e13) lim = null;
  return { cur: cur == null ? process.memoryUsage().rss : cur, lim };
}
function cpuLimit() {   // počet jader z cgroup (cpu.max "200000 100000" = 2 jádra)
  const m = rd('/sys/fs/cgroup/cpu.max'); if (m) { const [q, p] = m.split(' '); if (q !== 'max' && +p) return +q / +p; }
  return require('os').cpus().length || 1;
}
const BOOT = new Date().toISOString(), ring = []; let last = { t: Date.now(), cpu: process.cpuUsage() };
function sample() {
  const now = Date.now(), c = process.cpuUsage(), dt = (now - last.t) / 1000;
  const cpuS = ((c.user - last.cpu.user) + (c.system - last.cpu.system)) / 1e6;
  last = { t: now, cpu: c };
  const m = memory(), pm = process.memoryUsage(), cores = cpuLimit();
  ring.push({ t: new Date(now).toISOString(), mem: m.cur, lim: m.lim, rss: pm.rss, heap: pm.heapUsed, cpu: dt > 0 ? cpuS / dt / cores : 0 });
  if (ring.length > 360) ring.shift();   // 6 h po minutě
}
function snapshot() { const m = memory(); return { boot: BOOT, uptime: Math.round(process.uptime()), node: process.version, cores: cpuLimit(), mem: m.cur, lim: m.lim, rss: process.memoryUsage().rss, ring: ring.slice(-360) }; }
function start() { sample(); setInterval(sample, 60000).unref(); }
module.exports = { start, snapshot, BOOT };
