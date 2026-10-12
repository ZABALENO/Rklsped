// Denní kurz EUR/CZK z ČNB, ukládá se do úložiště (cfg.rate) a obnovuje každé 3 hodiny.
const RATE_TTL = 3 * 3600 * 1000;
const DEFAULT_RATE = 25;
async function eurRate(store) {
  const c = store.mem.cfg.rate;
  if (c && Date.now() - c.t < RATE_TTL) return c;
  try {
    const r = await fetch('https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt',
      { signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    const date = (txt.split('\n')[0].match(/^(\d{2}\.\d{2}\.\d{4})/) || [])[1] || '';
    const parts = txt.split('\n').find(l => l.includes('|EUR|')).split('|');
    const value = parseFloat(parts[4].replace(',', '.')) / (parseFloat(parts[2]) || 1);
    if (value > 10 && value < 60) {
      const v = { value, date, t: Date.now(), src: 'ČNB' };
      await store.put('cfg', 'rate', v);
      return v;
    }
  } catch (e) { console.error('Kurz ČNB nedostupný:', e.message); }
  return c || { value: DEFAULT_RATE, date: '', t: 0, src: 'výchozí' };
}
module.exports = { eurRate };
