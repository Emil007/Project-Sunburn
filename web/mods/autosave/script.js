// Autosave: on the 1st of each in-game month, call the game's own "save" routine (the one the file
// menu runs when you type a name and press Enter) with the name AUTOyymm, then delete the oldest
// autosaves so only the newest `keep` remain.
//
// Everything is located by code signatures, so it works with the English and the German release.
const KEEP = Math.max(1, Math.min(12, Number(api.settings.keep) || 5));
let SAVE = null;     // { sel, off } of the file menu's save method (only used to find the parts below)
let SAVEGAME = null; // far address of SaveGame(path: string), called by that method
let PREFIX = 0;      // DS offset of the save folder string ('Maps\\')
let DIRTY = 0;       // DS offset of the 'changed since last save' flag the method clears
let BUF = null;      // our buffer for the path
let DAYVAR = 0;      // DS offset of the day of the month
let COUNTER = 0;     // DS offset of the 32-bit day counter (1 = 1 January 1996)

api.onLoad((ctx) => {
  // file menu "Enter" handler: ... call [di+14]; leave; retf 4 | push bp; mov bp,sp; les di,[FORM]; push es di; call SAVE
  const h = ctx.find('26 8b 7d 09 ff 5d 14 c9 ca 04 00 55 89 e5 c4 3e ?? ?? 06 57 9a ?? ?? ?? ?? c9 ca 04 00');
  const d = ctx.find('30 e4 3b 06 ?? ?? 74 16 55 e8');
  const c = ctx.find('c8 06 00 00 83 06 ?? ?? 01 83 16 ?? ?? 00 c6 46 ff 00');
  if (h.length !== 1 || d.length < 1 || c.length !== 1) { api.log(`signatures not found (${h.length}/${d.length}/${c.length}) - autosave disabled`); return; }
  const b = ctx.read(h[0].seg, h[0].off, 29);   // b[21..22]: offset of the save method
  SAVE = { seg: h[0].seg, sel: ctx.segment(h[0].seg).sel, off: b[21] | (b[22] << 8) };
  const s = ctx.read(SAVE.seg, SAVE.off, 18);   // enter 100h,0; les di,[bp+6]; cmp byte es:[di+18Fh],0
  if (s[0] !== 0xc8 || s[10] !== 0x8f || s[11] !== 0x01) { api.log('save routine looks different - autosave disabled'); SAVE = null; return; }
  // inside the method: mov di,PREFIX ... lcall SaveGame ; mov byte [DIRTY],0
  const m = ctx.read(SAVE.seg, SAVE.off, 0x62);
  if (m[0x35] !== 0xbf || m[0x57] !== 0x9a || m[0x5c] !== 0xc6 || m[0x5d] !== 0x06) { api.log('save routine looks different - autosave disabled'); SAVE = null; return; }
  PREFIX = m[0x36] | (m[0x37] << 8);
  SAVEGAME = { off: m[0x58] | (m[0x59] << 8), sel: m[0x5a] | (m[0x5b] << 8) };
  DIRTY = m[0x5e] | (m[0x5f] << 8);
  BUF = ctx.allocData(256);
  const db = ctx.read(d[0].seg, d[0].off, 6); DAYVAR = db[4] | (db[5] << 8);
  const cb = ctx.read(c[0].seg, c[0].off, 8); COUNTER = cb[6] | (cb[7] << 8);
  api.log(`ready: SaveGame ${SAVEGAME.sel.toString(16)}:${SAVEGAME.off.toString(16)}, folder [${PREFIX.toString(16)}], day [${DAYVAR.toString(16)}], counter [${COUNTER.toString(16)}], keep ${KEEP}`);
});

let lastDay = -1, lastCounter = -1, pending = null, busy = false;

// date of the game day counter; the game's calendar is checked against its own day of the month
function dateOf(counter, dom) {
  const g = new Date(Date.UTC(1996, 0, counter));
  if (g.getUTCDate() === dom) return { y: g.getUTCFullYear(), m: g.getUTCMonth() + 1 };
  // fall back to a calendar without leap days
  const L = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; let n = counter - 1, y = 1996, m = 0;
  while (n >= 365) { n -= 365; y++; }
  while (n >= L[m]) { n -= L[m]; m++; }
  return { y, m: m + 1 };
}

function safeNow() {
  const u = api.win16.user;
  if (u.capture) return false;                                   // mouse button held / dragging
  for (const w of u.tops) {
    if (!(w.style & 0x10000000)) continue;                       // not visible
    const n = w.cls && w.cls.name;
    if (n === 'THauptschirm' && (w.style & 0x08000000)) return false; // main window disabled: a modal dialog is open
    if (n === 'TDateimenue') return false;                       // the player is in the file menu
  }
  return true;
}

function check() {
  if (!SAVE || busy) return;
  const mem = api.mem, ds = mem.ds();
  const day = mem.r16(ds, DAYVAR);
  const counter = mem.r16(ds, COUNTER) + mem.r16(ds, COUNTER + 2) * 65536;
  if (day !== lastDay || counter !== lastCounter) {
    // a month ended: the day of the month goes from 28..31 to 1 (starting a game goes 0 -> 1).
    // The day counter is updated a moment later than the day of the month, so take whichever
    // of counter / counter + 1 is the 1st of a month.
    if (day === 1 && lastDay >= 28) {
      const c1 = [counter, counter + 1].find((n) => new Date(Date.UTC(1996, 0, n)).getUTCDate() === 1) || counter + 1;
      const { y, m } = dateOf(c1, 1);
      pending = `AUTO${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`;
      api.log(`new month (day counter ${counter}) -> ${pending}`);
    }
    lastDay = day; lastCounter = counter;
  }
  if (!pending || !safeNow()) return;
  const name = pending; pending = null;
  // path = the game's save folder + name + '.map', as the file menu builds it
  let prefix = ''; const n = mem.r8(ds, PREFIX);
  for (let i = 0; i < n; i++) prefix += String.fromCharCode(mem.r8(ds, PREFIX + 1 + i));
  const path = prefix + name + '.map';
  mem.w8(BUF.sel, BUF.off, path.length);
  for (let i = 0; i < path.length; i++) mem.w8(BUF.sel, BUF.off + 1 + i, path.charCodeAt(i));
  busy = true;
  try {
    api.call(SAVEGAME.sel, SAVEGAME.off, [[((BUF.sel << 16) | BUF.off) >>> 0, 4]]);
    mem.w8(ds, DIRTY, 0);
    api.log(`saved ${path}`);
  } catch (e) { api.log(`save failed: ${e && e.message || e}`); }
  finally { busy = false; }
  prune();
}

function prune() {
  const age = (n) => { const yy = +n.slice(4, 6), mm = +n.slice(6, 8); return (yy < 90 ? 2000 + yy : 1900 + yy) * 12 + mm; };
  const autos = api.disk.list('HOLIDAY\\MAPS').map((e) => e.name.toUpperCase()).filter((n) => /^AUTO\d{4}\.MAP$/.test(n)).sort((a, b) => age(a) - age(b));
  for (const n of autos.slice(0, Math.max(0, autos.length - KEEP))) { api.disk.remove('HOLIDAY\\MAPS\\' + n); api.log(`removed old ${n}`); }
}

// run at the game's top-level message loop: the only place where calling into the game is safe
api.wrapApi('USER.GetMessage', (a, orig) => { check(); return orig(a); });
api.wrapApi('USER.PeekMessage', (a, orig) => { check(); return orig(a); });
