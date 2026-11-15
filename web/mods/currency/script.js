// Replaces the currency in the game's text files (D:\TEXTE\*.TXT and, in the English release,
// C:\HOLIDAY\UPGRADE\*.TXT; Windows-1252 encoded).
//   German release:  "DM", "DM/M" (per month), "DM/W" (per week), "500.000.000 DM"
//   English release: "£", "£/m", "£/w", "£200,000,000"
// The game draws its texts with its own bitmap font (GRAFIK\FONT.BMP). It has letters, digits,
// $ and £, but no € or ¥: characters it doesn't know are drawn with a filled circle (slot 74 of
// the font). For those symbols the text gets such an unknown character and the circle in
// FONT.BMP is redrawn as the symbol. (Normal Windows text, e.g. message boxes, shows € for it.)
let cur = String(api.settings.currency || '€');
if (cur === 'custom') cur = String(api.settings.custom || '').trim() || '€';
if (cur === (api.lang === 'de' ? 'DM' : '£')) return;          // nothing to change

const GLYPHS = {
  '€': ['...####', '..##...', '#####..', '.##....', '#####..', '.##....', '.##....', '..##...', '...####'],
  '¥': ['##...##', '##...##', '.##.##.', '..###..', '#######', '...#...', '#######', '...#...', '...#...'],
  '₿': ['.#.#...', '######.', '.##..##', '.##..##', '.#####.', '.##..##', '.##..##', '.##..##', '######.', '.#.#...'],
};
const custom = GLYPHS[cur] ? cur : null;                        // symbol drawn into the font
const UNKNOWN = 0x80;                                           // shown with font slot 74 by the game
const enc = (s) => Uint8Array.from([...s].map((c) => (c === custom ? UNKNOWN : c === '£' ? 0xa3 : c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f)));
const dec = (b) => [...b].map((x) => String.fromCharCode(x)).join('');
const letters = /^[A-Za-z]/.test(cur);                          // "EUR", "BTC": space before numbers

function convert(text) {
  if (api.lang === 'de') return text.replace(/(^|[\s(])DM(?=$|[\s/.,:;)])/gm, (m, p) => p + cur);
  return text.replace(/\u00a3(?=\d)/g, letters ? cur + ' ' : cur).replace(/\u00a3/g, cur);
}

api.onFile((drive, path, read) => {
  if (/(^|\\)(TEXTE|UPGRADE)\\[^\\]+\.TXT$/i.test(path)) {
    const orig = read(); if (!orig) return null;
    const before = dec(orig), after = convert(before);
    return after === before ? null : enc(after);
  }
  if (custom && /(^|\\)GRAFIK\\FONT\.BMP$/i.test(path)) {
    const orig = read(); if (!orig) return null;
    return drawGlyph(orig.slice(), GLYPHS[custom]);
  }
  return null;
});

// FONT.BMP: 12 px wide character slots, 12 bands of 14 rows: band 0 is the mask (0 = ink,
// 255 = transparent), bands 1-11 are the coloured versions (0 = transparent).
function drawGlyph(bmp, rows) {
  const dv = new DataView(bmp.buffer);
  const off = dv.getUint32(10, true), w = dv.getInt32(18, true), hh = dv.getInt32(22, true);
  if (dv.getUint16(28, true) !== 8 || w < 900) return null;
  const h = Math.abs(hh), stride = (w + 3) & ~3;
  const at = (x, y) => off + (hh > 0 ? h - 1 - y : y) * stride + x;
  const SLOT = 74 * 12, BAND = 14;
  for (let band = 0; band < Math.floor(h / BAND); band++) {
    const y0 = band * BAND;
    // ink colour of this band: the most common colour of the letter "A" (slot 1)
    const count = new Map();
    for (let y = y0; y < y0 + BAND; y++) for (let x = 12; x < 24; x++) { const v = bmp[at(x, y)]; if (v !== 0 && v !== 255) count.set(v, (count.get(v) || 0) + 1); }
    const ink = band === 0 ? 0 : [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 255;
    const clear = band === 0 ? 255 : 0;
    for (let y = y0; y < y0 + BAND; y++) for (let x = SLOT; x < SLOT + 12; x++) bmp[at(x, y)] = clear;
    const top = rows.length > 9 ? 1 : 2;                         // cap height of the font: rows 2..10
    rows.forEach((r, i) => { for (let x = 0; x < r.length; x++) if (r[x] === '#') bmp[at(SLOT + x, y0 + top + i)] = ink; });
  }
  return bmp;
}
api.log(`currency: ${api.lang === 'de' ? 'DM' : '£'} -> ${cur}`);
