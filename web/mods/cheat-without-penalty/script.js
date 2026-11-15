// Ctrl+Shift+Alt+G adds 1,000,000,000 and sets a "cheated" flag that the game checks when deciding
// whether you won. Keep the money, drop the flag: the cheat no longer sets it, and it is kept cleared
// (a save made with the original after cheating carries the flag along).
let FLAG = -1;
api.onLoad((ctx) => {
  // push 3B9Ah; push 0CA00h; push 1; call AddMoney; mov byte [FLAG],1
  const hits = ctx.find('68 9a 3b 68 00 ca 6a 01 9a ?? ?? ?? ?? c6 06 ?? ?? 01');
  if (hits.length !== 1) { api.log(`cheat code not found (${hits.length})`); return; }
  const h = hits[0]; const b = ctx.read(h.seg, h.off, 18);
  FLAG = b[15] | (b[16] << 8);
  ctx.patch(h.seg, h.off + 17, '01', '00');
  api.log(`cheat no longer flagged (flag at DS:${FLAG.toString(16)})`);
});
api.onTick(() => { if (FLAG >= 0) { const m = api.mem; if (m.r8(m.ds(), FLAG)) m.w8(m.ds(), FLAG, 0); } });
