// Čas poslední skutečné změny obsahu zdrojové tabulky (hash celého listu).
// Uloženo v cfg.chg {h, at, url}; při první detekci / změně odkazu se bere „teď“.
async function trackChange(cfg, put, out, url) {
  if (!out || !out.hash) return;
  const c = cfg.chg;
  if (!c || c.url !== url || c.h !== out.hash) await put('cfg', 'chg', { h: out.hash, at: new Date().toISOString(), url });
}
module.exports = { trackChange };
