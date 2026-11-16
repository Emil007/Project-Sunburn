// Unlock all buildings. The game makes buildings available through "new building" events
// (DATA\EREIGN*.DAT, type 6, the building id in column 10) that fire at a random time inside a
// time window (columns 2 and 3). We move every window to the very start of the game, so the
// game's own code unlocks them all on the first day.
// Landmarks are otherwise only sold at auctions and are in no build menu: with the setting on we
// add them to the Attractions menu (DATA\BAUMENU.DAT, section "Freizeit:").
const LANDMARKS = [29, 30, 35, 37, 60, 110, 108, 125, 126]; // Easter Island … Brandenburg Gate
// Landmarks cost 1 in HAUSPREI.DAT (the auction sets the real price). In the build menu they cost
// the auction's starting bid instead (DM, from EREIGNIS.DAT).
const PRICE = { 29: 120000, 30: 80000, 35: 1600000, 37: 1000000, 60: 3000000, 110: 500000, 108: 2000000, 125: 1200000, 126: 700000 };
const dec = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

function events(text) {
  let n = 0;
  const out = text.split('\r\n').map((l) => {
    const c = l.trim().split(/\s+/);
    if (c.length < 12 || c[10] !== '6') return l;
    n++;
    // keep the column widths: replace the 2nd and 3rd number in place
    return l.replace(/^(\s*\S+\s+)(\S+)(\s+)(\S+)/, (m, a, from, sp, to) => a + '1'.padStart(from.length) + sp + '3'.padStart(to.length));
  });
  return { text: out.join('\r\n'), n };
}

function menu(text) {
  const lines = text.split('\r\n');
  const start = lines.findIndex((l) => /^Freizeit:/i.test(l.trim()));
  if (start < 0) return { text, n: 0 };
  const have = new Set();
  let i = start + 1, n = 0;
  for (; i < lines.length && !/:\s*$/.test(lines[i]); i++) {
    const c = lines[i].trim().split(/\s+/).map(Number);
    if (c[0] >= 0) { have.add(c[0]); continue; }
    const id = LANDMARKS.find((x) => !have.has(x));
    if (id === undefined) break;
    have.add(id); n++;
    lines[i] = [id, -1, -1, -1].map((v) => String(v).padStart(6)).join('');
  }
  return { text: lines.join('\r\n'), n };
}

function prices(text) {
  let n = 0;
  const lines = text.split('\r\n').map((l, i) => {
    if (!(i in PRICE)) return l;
    const m = /^(\s*)(\S+)/.exec(l); if (!m || m[2] !== '1') return l;
    n++;
    return String(PRICE[i]).padStart(m[0].length) + l.slice(m[0].length);
  });
  return { text: lines.join('\r\n'), n };
}

api.onFile((drive, path, read) => {
  const p = path.toUpperCase();
  if (/(^|\\)EREIGN[^\\]*\.DAT$/.test(p)) {
    const raw = read(); if (!raw) return null;
    const r = events(dec(raw));
    api.log(`${path}: ${r.n} buildings available from the start`);
    return enc(r.text);
  }
  if (api.settings.landmarks && /(^|\\)BAUMENU\.DAT$/.test(p)) {
    const raw = read(); if (!raw) return null;
    const r = menu(dec(raw));
    api.log(`${path}: ${r.n} landmarks added to the Attractions menu`);
    return enc(r.text);
  }
  if (api.settings.landmarks && /(^|\\)HAUSPREI\.DAT$/.test(p)) {
    const raw = read(); if (!raw) return null;
    const r = prices(dec(raw));
    api.log(`${path}: ${r.n} landmark prices set`);
    return enc(r.text);
  }
  return null;
});
