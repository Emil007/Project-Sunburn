// Large island view
// ------------------
// The original map renderer is built for a fixed window: 20 tile columns (32 px) and 27 half-rows
// (16 px) inside a 624x405 image. Screen tiles are mapped to island coordinates through projection
// tables loaded from DATA\DARSTELL.DAT (and stored in savegames).
//
// This mod
//   1. runs the game on a bigger desktop and stretches the main window's layout table,
//   2. builds its own, bigger projection tables from the original DARSTELL.DAT,
//   3. redirects the renderer and the mouse picking to those tables (far-call stubs) and patches
//      every tile-count constant of the renderer.
// The game's own tables, the loader and the savegame format stay untouched, so savegames remain
// compatible with the unmodded game. Every patch site is located by its byte signature: works on
// the English and the German release and refuses to touch anything it doesn't recognise.
// Desktop mode: the screen (desktop) can be bigger than the map window. The game's own windows then
// open around the map instead of on top of it, and every window - the map included - can be dragged
// by its title bar (the original game already supports dragging its borderless windows).
const parseSize = (v) => String(v).split('x').map(Number);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v) || lo));
const host = { w: clamp(api.host && api.host.w, 640, 3840), h: clamp(api.host && api.host.h, 480, 2160) };
const sizeSetting = String(api.settings.size || 'auto');
const desk = String(api.settings.desktop || 'auto');
// the desktop (screen of the game): the player's screen/window, a fixed size, or just the map window
let [SW, SH] = desk === 'auto' ? [host.w, host.h] : desk !== 'off' ? parseSize(desk) : [0, 0];
// the map window: a fixed size, or automatic - the whole screen without a desktop, else about two
// thirds of its width, so the finance and map windows (440 pixels wide) fit beside it
let [DW, DH] = sizeSetting !== 'auto' ? parseSize(sizeSetting)
  : desk === 'off' ? [host.w, host.h]
  : [SW - Math.max(440, SW / 3), SH - 40];
if (desk === 'off') [SW, SH] = [DW, DH];
SW = clamp(SW, 640, 3840); SH = clamp(SH, 480, 2160);
// the game's draw tables hold at most 63 tile columns and 63 half-rows: 2032 x 1064 pixels of window
DW = clamp(Math.floor(Math.min(DW, 2032) / 16) * 16, 640, SW); DH = clamp(Math.floor(Math.min(DH, 1064) / 8) * 8, 480, SH);
api.setScreenSize(SW, SH);
const MX = 0, MY = 0; // the game centres its main window itself
const VW = DW - 16, VH = DH - 75;           // map view (orig. 624 x 405)
const C = Math.ceil(VW / 32);               // tile columns  (orig. 20)
const R = Math.ceil(VH / 16) + 1;           // half rows     (orig. 27)
const h8 = (v) => (v & 0xff).toString(16).padStart(2, '0');
const h16 = (v) => h8(v) + h8(v >> 8);

function buildTables(ctx) {
  const raw = ctx.readFile('D:\\DATA\\DARSTELL.DAT');
  if (!raw) return null;
  const lines = new TextDecoder('latin1').decode(raw).split(/\r?\n/);
  const sections = {}; let cur = null;
  for (const ln of lines) {
    const m = ln.match(/Ansicht(Spalten|Zeilen)([xy])Korrektur/i);
    if (m) { cur = (m[1].toLowerCase() === 'spalten' ? 'col' : 'row') + m[2].toLowerCase(); sections[cur] = []; continue; }
    if (/:\s*array/i.test(ln)) { cur = null; continue; }
    if (!cur) continue;
    const v = ln.trim().split(/\s+/).map(Number);
    if (v.length >= 4 && !v.some(isNaN)) sections[cur].push(v);
  }
  const out = {};
  for (const [key, n] of [['colx', C], ['rowx', R], ['coly', C], ['rowy', R]]) {
    const rowsOfNums = sections[key];
    if (!rowsOfNums || rowsOfNums.length !== 8) return null;            // 4 view directions x 2 parities
    const tbl = ctx.allocData(8 * n * 2);
    rowsOfNums.forEach((v, k) => {
      const d = v[v.length - 1] - v[v.length - 3];                      // arithmetic progression in steps of 2
      while (v.length < n) v.push(v[v.length - 2] + d);
      for (let i = 0; i < n; i++) api.mem.w16(tbl.sel, k * n * 2 + i * 2, v[i] & 0xffff);
    });
    out[key] = tbl;
  }
  return out;
}

api.onLoad((ctx) => {
  let ok = true;
  const todo = [];
  const site = (pattern, expect, range) => {
    let hits = ctx.find(pattern); if (range) hits = hits.filter(range);
    if (hits.length !== expect) { api.log(`signature ${pattern}: ${hits.length} hits, expected ${expect}`); ok = false; return []; }
    return hits;
  };
  const add = (pattern, at, bytes, expect, range) => { for (const h of site(pattern, expect, range)) todo.push(() => ctx.patch(h.seg, h.off + at, null, bytes)); };

  // visible area globals (their data addresses differ between the English and German EXE)
  const gW = site('c7 06 ?? ?? 70 02', 1), gH = site('c7 06 ?? ?? 95 01', 1);
  const addrOf = (h, at) => { const b = ctx.read(h.seg, h.off + at, 2); return b[0] | (b[1] << 8); };
  const vwAddr = gW.length ? addrOf(gW[0], 2) : 0, vhAddr = gH.length ? addrOf(gH[0], 2) : 0;
  for (const h of gW) todo.push(() => ctx.patch(h.seg, h.off + 4, null, h16(VW)));
  for (const h of gH) todo.push(() => ctx.patch(h.seg, h.off + 4, null, h16(VH)));
  // renderer: last column index and row count
  add('6a 00 6a 13 ff 76 06 e8', 3, h8(C - 1), 1);
  add('6a 00 6a 13 8b 46 06 f7 d8', 3, h8(C - 1), 1);
  add('83 7e 08 13 7f', 3, h8(C - 1), 1);
  add('8b 46 06 99 52 50 6a 00 6a 13 9a', 9, h8(C - 1), 1);
  add('6a 00 6a 13 6a 00 e8', 3, h8(C - 1), 1);
  add('b8 1a 00 2b 46 04', 1, h16(R - 1), 1);
  // scroll routine: full-redraw thresholds and strip sizes
  const rseg = (ctx.find('6a 00 6a 13 6a 00 e8')[0] || {}).seg;
  const scroll = site('55 89 e5 80 3e ?? ?? 00 74', 1, (h) => h.seg === rseg);
  if (scroll.length) {
    const s = scroll[0]; const inScroll = (h) => h.seg === s.seg && h.off > s.off && h.off < s.off + 0x700;
    add('3d 12 00', 1, h16(C - 2), 4, inScroll);
    add('3d 17 00', 1, h16(R - 4), 4, inScroll);
    add('b8 15 00', 1, h16(C + 1), 2, inScroll);
    add('05 15 00', 1, h16(C + 1), 2, inScroll);
    add('6a 14', 1, h8(C), 4, inScroll);
  }
  // tile-in-view test and the two rotation helpers that mirror view coordinates (0x13 = C-1, 0x1a = R-1, 0x19 = R-2)
  add('83 7e 0e 13 7f 28 83 7e 0c 00', 3, h8(C - 1), 1);
  for (const sig of ['c8 0e 00 00 a0 ?? ?? 3c 00', 'c8 10 00 00 a0 ?? ?? 3c 00']) {
    const f = site(sig, 1, (h) => h.seg === rseg);
    if (!f.length) continue;
    const inF = (h) => h.seg === f[0].seg && h.off > f[0].off && h.off < f[0].off + 0x260;
    add('b8 13 00', 1, h16(C - 1), 3, inF);
    add('b8 1a 00', 1, h16(R - 1), 2, inF);
    add('b8 19 00', 1, h16(R - 2), 2, inF);
  }
  // background/title pictures: the game only has them for 640x480, 800x600, 1024x768, 1152x870 and
  // 1280x1024 and picks one by exact screen size. Make the 640x480 branch match our desktop; the
  // file hook below serves a picture scaled to it.
  add('81 3e ?? ?? 80 02 75 ?? 81 3e ?? ?? e0 01', 4, h16(SW), 3);
  for (const h of ctx.find('81 3e ?? ?? 80 02 75 ?? 81 3e ?? ?? e0 01')) todo.push(() => ctx.patch(h.seg, h.off + 12, null, h16(SH)));
  // toolbar repaint: BitBlt(..., 0, 0, 640, 25, ...)
  add('6a 00 6a 00 68 80 02 6a 19 ff 36', 5, h16(DW), 1);
  // per-parity strides at the renderer (imul [68ce]) and picking (imul [bp-0e]) sites
  const rowStride = site('6b 06 ?? ?? 36', 2, (h) => h.seg === rseg);
  if (rowStride.length) add('6b 06 ' + h16(addrOf(rowStride[0], 2)) + ' 28', 4, h8(C * 2), 2);
  for (const h of rowStride) todo.push(() => ctx.patch(h.seg, h.off + 4, null, h8(R * 2)));
  add('6b 46 f2 28', 3, h8(C * 2), 2);
  add('6b 46 f2 36', 3, h8(R * 2), 2);
  // "imul ax,ax,<dir stride>; les di,[table]" at renderer + picking sites -> far call into a stub using our tables
  const builder = site('83 7e fa 13 75', 2);  // the original table loader (left untouched)
  const notBuilder = (h) => !builder.some((b) => b.seg === h.seg && Math.abs(b.off - h.off) < 0x200);
  // The four table pointers differ per EXE: group the sites by pointer; the lower address is the x table.
  const redirect = {}, redirectSites = {};
  for (const [stride, kx, ky, n] of [['50', 'colx', 'coly', C], ['6c', 'rowx', 'rowy', R]]) {
    const hits = site('6b c0 ' + stride + ' c4 3e ?? ??', 4, notBuilder);
    const ptrs = [...new Set(hits.map((h) => addrOf(h, 5)))].sort((a, b) => a - b);
    if (ptrs.length !== 2) { ok = false; continue; }
    [kx, ky].forEach((k, i) => { redirect[k] = ['6b c0 ' + stride + ' c4 3e ' + h16(ptrs[i]), n]; redirectSites[k] = hits.filter((h) => addrOf(h, 5) === ptrs[i]); });
  }
  if (C * 2 > 127 || R * 2 > 127) { api.log('view too large'); ok = false; }
  const tblSeg = ctx.dataSegment();
  const layout = site('00 00 00 00 00 00 80 02 df 01 01 00 00 00 00 00 10 00 10 00', 1, (h) => h.seg === tblSeg);
  const tables = ok ? buildTables(ctx) : null;
  if (!tables) ok = false;
  if (!ok) { api.log('unsupported executable or data - large view disabled'); api.setScreenSize(640, 480); return; }

  // the view size globals are initialised data (the code above only runs on some paths): set them directly
  api.mem.w16(api.mem.ds(), vwAddr, VW); api.mem.w16(api.mem.ds(), vhAddr, VH);
  todo.forEach((f) => f());
  // savegames store the view size: point the stream read/write at a dummy holding the vanilla 624x405,
  // so loading a save doesn't shrink the view and our saves stay loadable by the original game
  for (const [sig, val] of [['bf ' + h16(vwAddr) + ' 1e 57 6a 02', 0x270], ['bf ' + h16(vhAddr) + ' 1e 57 6a 02', 0x195]]) {
    const hits = ctx.find(sig);
    if (hits.length !== 2) { api.log(`savegame view-size signature: ${hits.length} hits`); continue; }
    const d = ctx.allocData(2); api.mem.w16(d.sel, d.off, val);
    // stub: pop ax (ip); pop di (cs); push dummy far ptr; push cs; push ip; retf
    const stub = ctx.allocCode('585f68' + h16(d.sel) + '68' + h16(d.off) + '5750cb');
    for (const h of hits) ctx.patch(h.seg, h.off, sig, '9a' + h16(stub.off) + h16(stub.sel) + '6a02');
  }
  for (const k in redirect) {
    const t = tables[k], n = redirect[k][1];
    // stub: imul ax,ax,4n ; les di,cs:[ptr] ; retf ; ptr: dd table
    const ptr = ctx.allocCode(h16(t.off) + h16(t.sel));
    const stub = ctx.allocCode('69c0' + h16(n * 4) + '2ec43e' + h16(ptr.off) + 'cb');
    for (const s of redirectSites[k]) ctx.patch(s.seg, s.off, redirect[k][0], '9a' + h16(stub.off) + h16(stub.sel) + '9090');
  }
  // main window layout table (10-byte entries: flag, left, top, width, height)
  const ds = api.mem.ds(), base = layout[0].off;
  const ent = (i, L, T, W, H) => { const o = base + i * 10; if (L !== null) api.mem.w16(ds, o + 2, L); if (T !== null) api.mem.w16(ds, o + 4, T); if (W !== null) api.mem.w16(ds, o + 6, W); if (H !== null) api.mem.w16(ds, o + 8, H); };
  ent(0, MX, MY, DW, DH - 1);               // form (map window)
  ent(2, null, null, DW - 32, null);         // title bar
  ent(3, DW - 16, null, null, null);         // minimize button
  ent(4, null, null, DW, null);              // info bar
  ent(5, null, null, DW, null);              // toolbar
  ent(6, 0, 59, VW, VH - 1);                 // map image
  ent(7, DW - 16, 59, 16, VH - 1);           // vertical scrollbar
  ent(8, 0, DH - 17, 219, 16);               // status bar
  ent(9, 219, DH - 17, DW - 16 - 219, 16);   // horizontal scrollbar
  ent(10, DW - 16, DH - 17, 16, 16);         // corner
  api.log(`large view ${VW}x${VH}: ${C} columns x ${R} half-rows, desktop ${SW}x${SH}`);
});

// ---- window chrome: serve wider/taller versions of the bar bitmaps, built from the originals ----
// spec per axis: [newLength, endCap, tileStart, tileLength] - the original is kept, the gap before the end cap
// continues the pattern from tileStart with period tileLength, then the original end cap is appended.
const chrome = {
  'MENULEI3.BMP': { x: [DW - 32, 8, 100, 300] },          // title bar (grass)
  'STATUSLE.BMP': { x: [DW, 0, 0, 64] },                  // money/date bar (wood boards)
  'BUTTOFF.BMP':  { x: [DW, 0, 75, 13], planks: true },   // toolbar: continued with the info bar's wooden planks
  'BUTTON.BMP':   { x: [DW, 0, 75, 13], planks: true },
  'SCROWEOS.BMP': { x: [DW - 16 - 219 + 3, 20, 79, 62] }, // horizontal scrollbar track
  'SCRONOSU.BMP': { y: [VH, 17, 79, 62] },                // vertical scrollbar track
  // the buffer the game saves the map background into before it draws build outlines, floating money
  // and other temporary sprites (624x406 on the CD): too small for the enlarged view, which left
  // outlines and money smears behind outside the original 624x405 area
  'SECOND.BMP':   { x: [VW, 0, 0, 624], y: [VH + 1, 0, 0, 406] },
};
function extendBmp(d, spec) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const off = dv.getUint32(10, true), w = dv.getInt32(18, true), hh = dv.getInt32(22, true), bpp = dv.getUint16(28, true);
  if (bpp !== 8 || dv.getUint32(30, true) !== 0) return null;
  const h = Math.abs(hh), stride = (w + 3) & ~3;
  const px = (x, y) => d[off + (hh > 0 ? h - 1 - y : y) * stride + x];
  const map = (n, orig, s) => {        // new coordinate -> original coordinate
    if (!s) return n;
    const [len, cap, ts, tl] = s;
    if (n >= len - cap) return orig - (len - n);
    if (n < orig - cap) return n;
    return ts + ((n - ts) % tl);
  };
  const nw = spec.x ? spec.x[0] : w, nh = spec.y ? spec.y[0] : h;
  if (nw <= w && nh <= h) return null;
  const ns = (nw + 3) & ~3, out = new Uint8Array(off + ns * nh);
  out.set(d.subarray(0, off));
  const ov = new DataView(out.buffer);
  ov.setUint32(2, out.length, true); ov.setInt32(18, nw, true); ov.setInt32(22, nh, true); ov.setUint32(34, ns * nh, true);
  for (let y = 0; y < nh; y++) {
    const sy = map(y, h, spec.y), row = off + (nh - 1 - y) * ns;
    for (let x = 0; x < nw; x++) out[row + x] = px(map(x, w, spec.x), sy);
  }
  return out;
}
api.onFile((drive, path, read) => {
  const m = /(?:^|\\)GRAFIK\\([^\\]+)$/.exec(path);
  const spec = m && chrome[m[1].toUpperCase()];
  if (!spec) return null;
  const orig = read();
  const r = orig ? extendBmp(orig, spec) : null;
  if (r && spec.planks) planks(r, orig, drive);
  return r;
});
// Paint the toolbar's new area with the planks of the info bar above it (STATUSLE.BMP, 64 px boards),
// scaled to the toolbar's height and mapped to the toolbar bitmap's palette.
let plankBusy = false;
function planks(bmp, orig, drive) {
  if (plankBusy) return; plankBusy = true;
  let src; try { src = api.win16.vfs.read(drive + ':\\GRAFIK\\STATUSLE.BMP'); } finally { plankBusy = false; }
  if (!src) return;
  const I = (d) => { const v = new DataView(d.buffer, d.byteOffset, d.byteLength); return { off: v.getUint32(10, true), w: v.getInt32(18, true), h: v.getInt32(22, true), bpp: v.getUint16(28, true), pal: 14 + v.getUint32(14, true), n: v.getUint32(46, true) || 256 }; };
  const a = I(bmp), s = I(src), o = I(orig);
  if (a.bpp !== 8 || s.bpp !== 8) return;
  const ah = Math.abs(a.h), sh = Math.abs(s.h), astride = (a.w + 3) & ~3, sstride = (s.w + 3) & ~3;
  // palette mapping STATUSLE index -> nearest toolbar index
  const map = new Uint8Array(256);
  for (let i = 0; i < s.n; i++) {
    const r = src[s.pal + i * 4 + 2], g = src[s.pal + i * 4 + 1], b = src[s.pal + i * 4];
    let best = 0, bd = Infinity;
    for (let j = 0; j < a.n; j++) { const d = (bmp[a.pal + j * 4 + 2] - r) ** 2 + (bmp[a.pal + j * 4 + 1] - g) ** 2 + (bmp[a.pal + j * 4] - b) ** 2; if (d < bd) { bd = d; best = j; } }
    map[i] = best;
  }
  for (let y = 0; y < ah; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / ah));
    const srow = s.off + (s.h > 0 ? sh - 1 - sy : sy) * sstride, drow = a.off + (a.h > 0 ? ah - 1 - y : y) * astride;
    for (let x = o.w; x < a.w; x++) bmp[drow + x] = map[src[srow + ((x - o.w) % 64)]];
  }
}

// ---- desktop background and title picture, scaled from the best original to the desktop size ----
const BG_SIZES = ['64X48', '80X60', '10X76', '11X87', '12X10'];
function bmpInfo(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { off: dv.getUint32(10, true), w: dv.getInt32(18, true), h: dv.getInt32(22, true), bpp: dv.getUint16(28, true), comp: dv.getUint32(30, true) };
}
function scaledPicture(prefix, drive) {
  let best = null;
  for (const s of BG_SIZES) {
    const d = api.win16.vfs.read(`${drive}:\\GRAFIK\\${prefix}${s}.BMP`); if (!d) continue;
    const i = bmpInfo(d); if (i.bpp !== 8 || i.comp !== 0) continue;
    const covers = i.w >= SW && Math.abs(i.h) >= SH;
    // prefer the smallest picture that covers the desktop, else the biggest one
    if (!best || (covers && (!best.covers || i.w < best.i.w)) || (!covers && !best.covers && i.w > best.i.w)) best = { d, i, covers };
  }
  if (!best) return null;
  const { d, i } = best, h = Math.abs(i.h), stride = (i.w + 3) & ~3;
  const k = Math.max(SW / i.w, SH / h);                       // cover, centre crop
  const ox = (i.w - SW / k) / 2, oy = (h - SH / k) / 2;
  const ns = (SW + 3) & ~3, out = new Uint8Array(i.off + ns * SH);
  out.set(d.subarray(0, i.off));
  const dv = new DataView(out.buffer);
  dv.setUint32(2, out.length, true); dv.setInt32(18, SW, true); dv.setInt32(22, SH, true); dv.setUint32(34, ns * SH, true);
  for (let y = 0; y < SH; y++) {
    const sy = Math.min(h - 1, Math.floor(oy + (y + 0.5) / k)), srow = i.off + (i.h > 0 ? h - 1 - sy : sy) * stride, drow = i.off + (SH - 1 - y) * ns;
    for (let x = 0; x < SW; x++) out[drow + x] = d[srow + Math.min(i.w - 1, Math.floor(ox + (x + 0.5) / k))];
  }
  return out;
}
const bgCache = {}; let bgBusy = false;
api.onFile((drive, path) => {
  if (bgBusy || (SW === 640 && SH === 480)) return null;
  const m = /(?:^|\\)GRAFIK\\(BCK|TIT)64X48\.BMP$/.exec(path);
  if (!m) return null;
  bgBusy = true;
  try { return bgCache[m[1]] ??= scaledPicture(m[1], drive); } finally { bgBusy = false; }
});
