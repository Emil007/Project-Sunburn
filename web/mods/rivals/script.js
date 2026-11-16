// Rivals overview, game side: every in-game day it reads each player's name, colour and money
// (located by signature, as in the cheat menu) and sends them to ui.js (F8).
let A = null;
const word = (b, i) => b[i] | (b[i + 1] << 8);
api.onLoad((ctx) => {
  const one = (pat) => { const r = ctx.find(pat); return r.length === 1 ? r[0] : null; };
  const day = one('c8 06 00 00 83 06 ?? ?? 01 83 16 ?? ?? 00 c6 46 ff 00');
  const money = one('8b 8d ?? ?? 8b 9d ?? ?? b8 ff ff ba ff 7f');
  const count = one('80 7e 06 01 73 03 e9 ?? ?? 8a 46 06 3a 06 ?? ??');
  if (!day || !money || !count) { api.log('signatures not found - overview disabled'); return; }
  // money is shown multiplied by the release's currency factor (TEXTE\SONSTIGE.TXT: 4 for £ in the English release)
  const t = ctx.readFile('D:\\TEXTE\\SONSTIGE.TXT'); let factor = 1;
  if (t) { const lines = String.fromCharCode(...t).split(/\r?\n/); const i = lines.findIndex((l) => l.trim() === 'Waehrungsfaktor'); if (i >= 0) factor = parseInt(lines[i + 1], 10) || 1; }
  A = { factor, day: word(ctx.read(day.seg, day.off, 8), 6), money: word(ctx.read(money.seg, money.off, 4), 2), players: word(ctx.read(count.seg, count.off, 16), 14) };
});
let mem = null; const M = () => (mem ||= api.mem);
const r32 = (o) => (M().r16(M().ds(), o) | (M().r16(M().ds(), o + 2) << 16));
const name = (p) => { const ds = M().ds(), n = M().r8(ds, 2 + p * 0x100); let s = ''; for (let i = 1; i <= n && i < 40; i++) s += String.fromCharCode(M().r8(ds, 2 + p * 0x100 + i)); return s; };
let lastDay = -1;
api.onTick(() => {
  if (!A) return;
  const n = M().r8(M().ds(), A.players); if (!n) return;
  const day = r32(A.day); if (day === lastDay || day <= 0) return; lastDay = day;
  const players = [];
  for (let p = 1; p <= n; p++) players.push({ p, name: name(p), colour: M().r8(M().ds(), 0x73 + p), money: r32(A.money + p * 4) * A.factor });
  api.toUI({ day, players });
});
