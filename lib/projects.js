// „Aktuálně agentizujeme“: strom odvětví (libovolně do hloubky), v každém checklist, zápisy (text) a dokumenty.
// Uložení: ns 'proj' (uzly bez souborů) a 'pfile' (obsah nahraných souborů, base64). Přístup má každý přihlášený na /ai.
const crypto = require('crypto');
const express = require('express');
const MAX_FILE = 4 * 1024 * 1024;   // 4 MB na dokument
const MAX_FILES = 25;               // dokumentů na jedno odvětví
const id = () => crypto.randomBytes(5).toString('hex');
const txt = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n);
const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i;

function setup(app, store, who) {
  const P = () => store.mem.proj, F = () => store.mem.pfile;
  const save = n => store.put('proj', n.id, n);
  const descendants = nid => { const out = [nid]; for (const n of Object.values(P())) if (n.parent === nid) out.push(...descendants(n.id)); return out; };

  app.get('/api/agents/proj', (req, res) => res.json({ nodes: Object.values(P()).sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt.localeCompare(b.createdAt)) }));

  app.post('/api/agents/proj/op', async (req, res) => {
    const b = req.body || {}, now = new Date().toISOString(), by = who(req);
    const node = () => P()[txt(b.node, 20)];
    try {
      switch (b.op) {
        case 'addNode': {
          const name = txt(b.name, 80).trim(); if (!name) return res.status(400).json({ error: 'Zadej název.' });
          const parent = b.parent ? txt(b.parent, 20) : null; if (parent && !P()[parent]) return res.status(404).json({ error: 'Nadřazené odvětví neexistuje.' });
          const nid = id(), order = Math.max(0, ...Object.values(P()).filter(n => n.parent === parent).map(n => n.order || 0)) + 1;
          await save({ id: nid, name, parent, order, items: [], notes: [], files: [], createdAt: now, by });
          return res.json({ ok: true, id: nid });
        }
        case 'renameNode': { const n = node(); if (!n) return res.status(404).json({ error: 'Odvětví neexistuje.' }); const name = txt(b.name, 80).trim(); if (!name) return res.status(400).json({ error: 'Zadej název.' }); n.name = name; await save(n); return res.json({ ok: true }); }
        case 'delNode': {
          const n = node(); if (!n) return res.json({ ok: true });
          for (const d of descendants(n.id)) { const dn = P()[d]; if (dn) for (const f of dn.files || []) await store.put('pfile', f.id, null); await store.put('proj', d, null); }
          return res.json({ ok: true });
        }
        case 'moveNode': {   // posun nahoru/dolů mezi sourozenci
          const n = node(); if (!n) return res.status(404).json({ error: 'Odvětví neexistuje.' });
          const sib = Object.values(P()).filter(x => x.parent === n.parent).sort((x, y) => (x.order || 0) - (y.order || 0) || x.createdAt.localeCompare(y.createdAt));
          const i = sib.findIndex(x => x.id === n.id), j = i + (b.dir === 'up' ? -1 : 1);
          if (j >= 0 && j < sib.length) { sib.splice(j, 0, sib.splice(i, 1)[0]); for (let k = 0; k < sib.length; k++) { if (sib[k].order !== k + 1) { sib[k].order = k + 1; await save(sib[k]); } } }
          return res.json({ ok: true });
        }
        case 'addItem': { const n = node(); if (!n) return res.status(404).json({ error: 'Odvětví neexistuje.' }); const t = txt(b.text, 300).trim(); if (!t) return res.status(400).json({ error: 'Zadej text bodu.' }); if (n.items.length >= 300) return res.status(400).json({ error: 'Příliš mnoho bodů.' }); n.items.push({ id: id(), text: t, done: false, by, at: now }); await save(n); return res.json({ ok: true }); }
        case 'toggleItem': { const n = node(), it = n && n.items.find(x => x.id === b.item); if (!it) return res.status(404).json({ error: 'Bod neexistuje.' }); it.done = !!b.done; it.doneBy = it.done ? by : ''; it.doneAt = it.done ? now : ''; await save(n); return res.json({ ok: true }); }
        case 'editItem': { const n = node(), it = n && n.items.find(x => x.id === b.item); if (!it) return res.status(404).json({ error: 'Bod neexistuje.' }); const t = txt(b.text, 300).trim(); if (!t) return res.status(400).json({ error: 'Zadej text bodu.' }); it.text = t; await save(n); return res.json({ ok: true }); }
        case 'delItem': { const n = node(); if (!n) return res.json({ ok: true }); n.items = n.items.filter(x => x.id !== b.item); await save(n); return res.json({ ok: true }); }
        case 'addNote': { const n = node(); if (!n) return res.status(404).json({ error: 'Odvětví neexistuje.' }); const title = txt(b.title, 120).trim(), text = txt(b.text, 20000); if (!title && !text.trim()) return res.status(400).json({ error: 'Zadej nadpis nebo text zápisu.' }); if (n.notes.length >= 200) return res.status(400).json({ error: 'Příliš mnoho zápisů.' }); n.notes.unshift({ id: id(), title: title || 'Zápis', date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : now.slice(0, 10), text, by, at: now }); await save(n); return res.json({ ok: true }); }
        case 'editNote': { const n = node(), nt = n && n.notes.find(x => x.id === b.note); if (!nt) return res.status(404).json({ error: 'Zápis neexistuje.' }); nt.title = txt(b.title, 120).trim() || 'Zápis'; nt.text = txt(b.text, 20000); if (/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) nt.date = b.date; await save(n); return res.json({ ok: true }); }
        case 'delNote': { const n = node(); if (!n) return res.json({ ok: true }); n.notes = n.notes.filter(x => x.id !== b.note); await save(n); return res.json({ ok: true }); }
        case 'delFile': { const n = node(); if (!n) return res.json({ ok: true }); n.files = n.files.filter(x => x.id !== b.file); await store.put('pfile', txt(b.file, 20), null); await save(n); return res.json({ ok: true }); }
        default: return res.status(400).json({ error: 'Neznámá akce.' });
      }
    } catch (e) { console.error('proj:', e.message); res.status(500).json({ error: 'Chyba serveru.' }); }
  });

  // nahrání dokumentu: tělo = surový soubor, ?node=ID&name=NÁZEV
  app.post('/api/agents/proj/upload', express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
    const n = P()[txt(req.query.node, 20)];
    if (!n) return res.status(404).json({ error: 'Odvětví neexistuje.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Soubor je prázdný.' });
    if (req.body.length > MAX_FILE) return res.status(413).json({ error: 'Soubor je větší než 4 MB.' });
    if ((n.files || []).length >= MAX_FILES) return res.status(400).json({ error: 'Příliš mnoho dokumentů v tomto odvětví.' });
    const name = txt(req.query.name, 120).replace(/[\\/\u0000-\u001f]/g, '_').trim() || 'dokument', type = txt(req.headers['x-file-type'] || '', 100) || 'application/octet-stream';
    const fid = id() + id();
    await store.put('pfile', fid, { name, type, data: req.body.toString('base64') });
    n.files.push({ id: fid, name, type, size: req.body.length, by: who(req), at: new Date().toISOString() });
    await save(n);
    res.json({ ok: true });
  });
  app.use('/api/agents/proj/upload', (err, req, res, next) => res.status(err && err.status === 413 ? 413 : 400).json({ error: err && err.status === 413 ? 'Soubor je větší než 4 MB.' : 'Nahrání selhalo.' }));

  app.get('/api/agents/proj/file/:id', (req, res) => {
    const f = F()[txt(req.params.id, 20)];
    if (!f) return res.status(404).send('Soubor nenalezen');
    const inline = INLINE.test(f.type);
    res.set({ 'Content-Type': inline ? f.type : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      'Content-Disposition': `${inline && req.query.dl !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
    res.send(Buffer.from(f.data, 'base64'));
  });
}
module.exports = { setup };
