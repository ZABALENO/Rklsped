// Zjištění řádků, které jsou v tabulce napsané červeným písmem (jen u xlsx – CSV barvy neobsahuje).
// SheetJS (community) barvu písma nevrací, proto se čte přímo z XML souboru (styles.xml + list).
const txt = f => (f && f.content ? Buffer.from(f.content).toString('utf8') : '');

function isRedRgb(hex) {
  const h = String(hex || '').slice(-6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return r >= 0x99 && g <= 0x66 && b <= 0x66 && r - Math.max(g, b) >= 0x66;
}
const colIdx = letters => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// styly: pro každý index xf (cellXfs) true/false = je písmo červené
function redXfs(stylesXml) {
  const fontsBlock = (stylesXml.match(/<fonts[\s\S]*?<\/fonts>/) || [''])[0];
  const fonts = (fontsBlock.match(/<font(?:\s[^>]*)?>[\s\S]*?<\/font>|<font\s*\/>/g) || []).map(f => {
    const c = f.match(/<color\s+([^>]*?)\/?>/);
    if (!c) return false;
    const rgb = c[1].match(/rgb="([0-9a-fA-F]+)"/);
    if (rgb) return isRedRgb(rgb[1]);
    const ind = c[1].match(/indexed="(\d+)"/);
    return !!ind && (ind[1] === '10' || ind[1] === '2');
  });
  const xfsBlock = (stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0];
  return (xfsBlock.match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || []).map(x => {
    const m = x.match(/fontId="(\d+)"/);
    return m ? !!fonts[+m[1]] : false;
  });
}

function sheetPath(files, idx) {
  try {
    const wbx = txt(files['xl/workbook.xml']);
    const rels = txt(files['xl/_rels/workbook.xml.rels']);
    const sh = wbx.match(/<sheet\b[^>]*>/g) || [];
    const rid = (sh[idx] || '').match(/r:id="([^"]+)"/);
    if (rid) {
      for (const r of rels.match(/<Relationship\b[^>]*>/g) || []) {
        if (r.includes('Id="' + rid[1] + '"')) {
          const t = (r.match(/Target="([^"]+)"/) || [])[1];
          if (t) return t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
        }
      }
    }
  } catch {}
  return 'xl/worksheets/sheet' + (idx + 1) + '.xml';
}

// vrací Map: číslo řádku v listu (1 = první) -> { n: počet neprázdných buněk, red: počet červených, cols: Set sloupců s červeným písmem }
function redRowInfo(wb, sheetIdx) {
  const files = wb && wb.files;
  if (!files) return null;
  const st = txt(files['xl/styles.xml']);
  const xml = txt(files[sheetPath(files, sheetIdx)]);
  if (!st || !xml) return null;
  const xf = redXfs(st);
  const out = new Map();
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rn = +((rm[1].match(/\br="(\d+)"/) || [])[1] || 0);
    if (!rn || !rm[2]) continue;
    const rowS = rm[1].match(/\bs="(\d+)"/) && /customFormat="(1|true)"/.test(rm[1]) ? +rm[1].match(/\bs="(\d+)"/)[1] : null;
    const info = { n: 0, red: 0, cols: new Set() };
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = cm[2] || '';
      const has = /<v>[^<]+<\/v>|<is>[\s\S]*?<t[^>]*>[^<]+<\/t>/.test(body);
      if (!has) continue;
      info.n++;
      const s = cm[1].match(/\bs="(\d+)"/);
      const sIdx = s ? +s[1] : rowS;
      if (sIdx != null && xf[sIdx]) {
        info.red++;
        const col = cm[1].match(/\br="([A-Z]+)\d+"/);
        if (col) info.cols.add(colIdx(col[1]));
      }
    }
    if (info.n) out.set(rn, info);
  }
  return out;
}

module.exports = { redRowInfo, isRedRgb };
