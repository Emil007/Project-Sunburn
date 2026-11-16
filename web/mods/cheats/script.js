// Cheat menu, game side. The menu itself is ui.js (F9); it sends commands here (api.onCommand),
// and this script changes the game through the game's own data and routines:
//
//  - money: the routine the original Ctrl+Shift+Alt+G cheat calls (AddMoney(amount, player)),
//    without setting the game's "cheated" mark
//  - buildings: the game unlocks buildings through timed events (DATA\EREIGN*.DAT, type 6); we
//    call the event's unlock routine directly for the next or for all pending ones
//  - attractions: landmarks are sold at auctions (events of type 1); "next" makes the next auction
//    start tomorrow, "all" puts every landmark into the Attractions build menu at its starting bid
//  - time: fast-forward by speeding up the game clock, or stop the clock
//  - rivals: a rival whose money is deeply negative goes bankrupt by the game's own rules
//
// Everything is located by code signatures, so it works with the English and the German release.
const CMD = { MONEY: 1, FREEZE_MONEY: 2, KEEP_WIN: 3, NEXT_BUILDING: 4, ALL_BUILDINGS: 5, NEXT_AUCTION: 6, ALL_ATTRACTIONS: 7,
  SKIP_DAYS: 8, FREEZE_TIME: 9, BANKRUPT: 10, STATE: 11, STOP_FF: 12 };
const FF_SPEED = 100;  // the game clock runs 100x as fast (the most the emulator keeps up with is about 40 days a second)
const EV_SIZE = 0x34, TYPE_AUCTION = 1, TYPE_NEW_BUILDING = 6, CERTAIN = 1000000;
const LANDMARK_PRICE = { 29: 120000, 30: 80000, 35: 1600000, 37: 1000000, 60: 3000000, 110: 500000, 108: 2000000, 125: 1200000, 126: 700000 };

let A = null;          // addresses found in onLoad
let menuFile = null, priceFile = null;
const bankrupted = new Set();
const st = { freezeMoney: false, frozenMoney: 0, keepWin: false, freezeTime: false, ff: 0, ffPaused: false, speedBefore: 1 };

const hex = (n) => n.toString(16);
const word = (b, i) => b[i] | (b[i + 1] << 8);

api.onLoad((ctx) => {
  const one = (name, pat) => { const r = ctx.find(pat); if (r.length !== 1) throw new Error(`${name}: ${r.length} matches`); return r[0]; };
  try {
    const ev = one('events', '6b c0 34 c4 3e ?? ?? 03 f8 26 8b 45 0c 26 0b 45 0e');
    const day = one('day', 'c8 06 00 00 83 06 ?? ?? 01 83 16 ?? ?? 00 c6 46 ff 00');
    const money = one('money', '8b 8d ?? ?? 8b 9d ?? ?? b8 ff ff ba ff 7f');
    const count = one('players', '80 7e 06 01 73 03 e9 ?? ?? 8a 46 06 3a 06 ?? ??');
    const cheat = one('cheat', '68 9a 3b 68 00 ca 6a 01 9a ?? ?? ?? ?? c6 06 ?? ?? 01');
    const unlock = one('unlock', '26 8a 45 24 50 6a 00 9a ?? ?? ?? ??');
    const evn = one('event count', '80 7e ff ?? 74 03 e9 ?? ?? c9 cb');
    const rd = (f, n) => ctx.read(f.seg, f.off, n);
    const c = rd(cheat, 18), u = rd(unlock, 12);
    A = {
      events: word(rd(ev, 7), 5), eventCount: rd(evn, 4)[3] + 1, day: word(rd(day, 8), 6), money: word(rd(money, 4), 2),
      players: word(rd(count, 16), 14), flag: word(c, 15),
      addMoney: { off: word(c, 9), sel: word(c, 11) }, unlock: { off: word(u, 8), sel: word(u, 10) },
    };
    api.log(`ready: events [${hex(A.events)}] x${A.eventCount}, day [${hex(A.day)}], money [${hex(A.money)}], players [${hex(A.players)}], mark [${hex(A.flag)}]`);
  } catch (e) { api.log('not available: ' + e.message); A = null; }
  menuFile = ctx.readFile('D:\\DATA\\BAUMENU.DAT');
  priceFile = ctx.readFile('C:\\HOLIDAY\\UPGRADE\\HAUSPREI.DAT') || ctx.readFile('D:\\DATA\\HAUSPREI.DAT');
});

// ---- game memory helpers ----
let memApi = null;
const M = () => (memApi ||= api.mem);   // only usable once the game is loaded
const ds = () => M().ds();
const r32 = (sel, off) => (M().r16(sel, off) | (M().r16(sel, off + 2) << 16));
const w32 = (sel, off, v) => { M().w16(sel, off, v & 0xffff); M().w16(sel, off + 2, (v >>> 16) & 0xffff); };
const today = () => r32(ds(), A.day);
const playerCount = () => M().r8(ds(), A.players);
const moneyOf = (p) => r32(ds(), A.money + p * 4);
// each player's colour, 1..8 in the order of the start menu (DS:73h + player, same in both releases)
const colourOf = (p) => M().r8(ds(), 0x73 + p);
const nameOf = (p) => { const n = M().r8(ds(), 2 + p * 0x100); let s = ''; for (let i = 1; i <= n && i < 40; i++) s += String.fromCharCode(M().r8(ds(), 2 + p * 0x100 + i)); return s; };
function eventTable() {
  const off = M().r16(ds(), A.events), sel = M().r16(ds(), A.events + 2);
  if (!sel) return null;
  const list = [];
  for (let i = 0; i < A.eventCount; i++) {
    const o = off + i * EV_SIZE;
    list.push({ o, sel, prob: r32(sel, o), from: r32(sel, o + 4), to: r32(sel, o + 8), running: r32(sel, o + 0xc), house: r32(sel, o + 0x24), type: M().r16(sel, o + 0x28) });
  }
  return list;
}
// events that haven't happened yet (an event that happened has its probability set to 0)
const pending = (type) => (eventTable() || []).filter((e) => e.type === type && e.prob > 0 && e.running === 0).sort((a, b) => a.from - b.from);
const inGame = () => !!A && playerCount() > 0 && !!eventTable();

// calling game routines is only safe between messages, with no dialog open (like autosave)
function safeNow() {
  const u = api.win16.user;
  if (u.capture) return false;
  for (const w of u.tops) {
    if (!(w.style & 0x10000000)) continue;
    const n = w.cls && w.cls.name;
    if (n === 'THauptschirm' && (w.style & 0x08000000)) return false;
  }
  return true;
}
const queue = [];
const later = (fn) => queue.push(fn);
for (const name of ['USER.GetMessage', 'USER.PeekMessage']) {
  api.wrapApi(name, (args, orig) => { while (queue.length && safeNow()) { try { queue.shift()(); } catch (e) { api.log('error: ' + e.message); } } return orig(args); });
}

// ---- the cheats ----
function addMoney(amount) {
  later(() => { api.call(A.addMoney.sel, A.addMoney.off, [[amount, 4], [1, 2]]); if (st.freezeMoney) st.frozenMoney = moneyOf(1); api.redraw(); send(); });
}
function unlockBuilding(e) {
  api.call(A.unlock.sel, A.unlock.off, [[e.house & 0xff, 2], [0, 2]]);
  w32(e.sel, e.o, 0);   // the event has happened
}
// the next one goes through the game's own event, so the news announces it (tomorrow)
function nextBuilding() { const e = pending(TYPE_NEW_BUILDING)[0]; if (e) { fireTomorrow(e); api.log(`building ${e.house} unlocks tomorrow`); } send(); }
function fireTomorrow(e) { const d = today(); w32(e.sel, e.o, CERTAIN); w32(e.sel, e.o + 4, d); w32(e.sel, e.o + 8, d + 3); }
function allBuildings() { later(() => { const list = pending(TYPE_NEW_BUILDING); for (const e of list) unlockBuilding(e); api.log(`unlocked ${list.length} buildings`); send(); }); }
function nextAuction() {
  const e = pending(TYPE_AUCTION)[0]; if (!e) return;
  // happens on the next day: the game checks from <= day <= to and rolls the probability
  fireTomorrow(e);
  api.log(`auction ${e.house || ''} starts tomorrow (event at ${hex(e.o)})`); send();
}

// the build menu table (DATA\BAUMENU.DAT: 13 sections of 20 rows x 4 words) and the price table
// (HAUSPREI.DAT: 16 bytes per building, price first) are found in memory by their contents
let menuAt = -1, priceAt = -1;
function parseMenu() {
  const text = String.fromCharCode(...menuFile); const sections = []; let cur = null;
  for (const l of text.split(/\r?\n/)) {
    if (/:\s*$/.test(l)) { cur = []; sections.push(cur); continue; }
    const v = l.trim().split(/\s+/).map(Number); if (cur && v.length >= 4 && v.every((x) => !isNaN(x))) cur.push(v.slice(0, 4));
  }
  return sections;
}
function findBytes(pat, from = 0) {
  const u8 = M().u8; const first = pat[0];
  for (let i = u8.indexOf(first, from); i >= 0; i = u8.indexOf(first, i + 1)) {
    let k = 1; while (k < pat.length && u8[i + k] === pat[k]) k++;
    if (k === pat.length) return i;
  }
  return -1;
}
const words = (rows) => { const b = []; for (const r of rows) for (const v of r) b.push(v & 0xff, (v >> 8) & 0xff); return b; };
function allAttractions() { later(allAttractionsNow); }
function allAttractionsNow() {
  if (!menuFile || !priceFile) { api.log('menu files not found'); return; }
  const sections = parseMenu(); const fz = sections[5]; if (!fz || fz.length < 20) { api.log('unexpected BAUMENU.DAT'); return; }
  if (menuAt < 0) { const at = findBytes(words(fz.slice(0, 8))); if (at < 0) { api.log('build menu not found in memory'); return; } menuAt = at; }
  if (priceAt < 0) {
    const prices = String.fromCharCode(...priceFile).split(/\r?\n/).map((l) => parseInt(l, 10)).filter((n) => !isNaN(n));
    const pat = []; for (let i = 0; i < 3; i++) { const v = prices[i]; const b = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; pat.push(...b, ...(i < 2 ? new Array(12).fill(-1) : [])); }
    priceAt = findMasked(pat);
  }
  const u8 = M().u8; const ids = Object.keys(LANDMARK_PRICE).map(Number);
  const have = new Set(); for (let r = 0; r < 20; r++) { const v = u8[menuAt + r * 8] | (u8[menuAt + r * 8 + 1] << 8); if (v !== 0xffff) have.add(v); }
  let added = 0;
  for (let r = 0; r < 20; r++) {
    const a = menuAt + r * 8; if ((u8[a] | (u8[a + 1] << 8)) !== 0xffff) continue;
    const id = ids.find((x) => !have.has(x)); if (id === undefined) break;
    have.add(id); u8[a] = id; u8[a + 1] = 0; added++;
  }
  if (priceAt >= 0) for (const id of ids) { const a = priceAt + id * 16; const p = LANDMARK_PRICE[id]; if ((u8[a] | (u8[a + 1] << 8) | (u8[a + 2] << 16)) === 1) { u8[a] = p & 0xff; u8[a + 1] = (p >> 8) & 0xff; u8[a + 2] = (p >> 16) & 0xff; u8[a + 3] = 0; } }
  // the menu only lists buildings the game has made available (as its new-building events do)
  for (const id of ids) api.call(A.unlock.sel, A.unlock.off, [[id, 2], [0, 2]]);
  api.log(`added ${added} landmarks to the Attractions menu (prices ${priceAt >= 0 ? 'set' : 'not found'})`); send();
}
function findMasked(pat) {
  const u8 = M().u8; const first = pat[0];
  for (let i = u8.indexOf(first); i >= 0; i = u8.indexOf(first, i + 1)) {
    let k = 1; while (k < pat.length && (pat[k] < 0 || u8[i + k] === pat[k])) k++;
    if (k === pat.length) return i;
  }
  return -1;
}
// fast-forward: the game clock runs FF_SPEED times faster and the game skips most of its drawing.
// News and auctions pause it (they run at normal speed, as in the game) and it goes on when they close.
function skipDays(n) {
  if (st.ff) return;
  st.ff = today() + n; st.ffPaused = false;
  if (st.freezeTime) st.freezeTime = false;
  ffRun(true); send();
}
// the speed is held while fast-forwarding or with frozen time; letting go returns to the speed the
// player chose with the speed buttons (and the game's own Game Speed option applies throughout)
function ffRun(on) { api.skipDrawing(on); api.holdSpeed(on ? FF_SPEED : st.freezeTime ? 0 : null, 100); }
function stopFF() {
  if (!st.ff) return;
  st.ff = 0; st.ffPaused = false; api.skipDrawing(false);
  api.holdSpeed(st.freezeTime ? 0 : null, 100);
  repaintAll(); send();
}
function repaintAll() { const u = api.win16.user; for (const w of u.tops) if (w.style & 0x10000000) u.invalidate(w.h, null, true); api.redraw(); }
// a news broadcast or an auction is on screen
function interrupted() {
  for (const w of api.win16.user.tops) {
    if (!(w.style & 0x10000000)) continue;
    const n = (w.cls && w.cls.name || '').toUpperCase();
    if (n === 'TFERNSEHER' || n === 'TAUKTIONSFORM') return true;
  }
  return false;
}
function bankrupt(p) {
  if (p < 2 || p > playerCount()) return;   // never the player
  w32(ds(), A.money + p * 4, -100000000); bankrupted.add(p);
  api.log(`${nameOf(p)} is broke`); send();
}

api.onCommand((cmd, arg) => {
  if (!inGame()) { send(); return; }
  switch (cmd) {
    case CMD.MONEY: addMoney(arg); break;
    case CMD.FREEZE_MONEY: st.freezeMoney = !!arg; st.frozenMoney = moneyOf(1); send(); break;
    case CMD.KEEP_WIN: st.keepWin = !!arg; send(); break;
    case CMD.NEXT_BUILDING: nextBuilding(); break;
    case CMD.ALL_BUILDINGS: allBuildings(); break;
    case CMD.NEXT_AUCTION: nextAuction(); break;
    case CMD.ALL_ATTRACTIONS: allAttractions(); break;
    case CMD.SKIP_DAYS: skipDays(arg); break;
    case CMD.FREEZE_TIME: st.freezeTime = !!arg; if (!st.ff) api.holdSpeed(st.freezeTime ? 0 : null, 100); send(); break;
    case CMD.BANKRUPT: bankrupt(arg); break;
    case CMD.STATE: send(); break;
    case CMD.STOP_FF: stopFF(); break;
  }
});

let lastSent = '';
function send() {
  if (!inGame()) { api.toUI({ inGame: false }); return; }
  const rivals = [];
  for (let p = 2; p <= playerCount(); p++) rivals.push({ p, name: nameOf(p), colour: colourOf(p), broke: bankrupted.has(p) });
  const s = { inGame: true, rivals, buildingsLeft: pending(TYPE_NEW_BUILDING).length, auctionsLeft: pending(TYPE_AUCTION).length,
    freezeMoney: st.freezeMoney, keepWin: st.keepWin, freezeTime: st.freezeTime, ff: st.ff ? Math.max(0, st.ff - today()) : 0, ffPaused: st.ffPaused };
  const j = JSON.stringify(s); if (j === lastSent) return; lastSent = j; api.toUI(s);
}

let n = 0;
api.onTick(() => {
  if (!inGame()) return;
  if (st.freezeMoney && moneyOf(1) !== st.frozenMoney) w32(ds(), A.money + 4, st.frozenMoney);
  if (st.keepWin && M().r8(ds(), A.flag)) M().w8(ds(), A.flag, 0);
  if (st.ff) {
    if (today() >= st.ff) stopFF();
    else if (interrupted() !== st.ffPaused) { st.ffPaused = !st.ffPaused; ffRun(!st.ffPaused); if (st.ffPaused) repaintAll(); send(); }
  }
  if (++n % (st.ff ? 3 : 20) === 0) send();
});
