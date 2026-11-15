// Standard MIDI File duration (ms) with tempo map
export function smfDurationMs(d: Uint8Array): number {
  const str = (o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
  const r32 = (o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
  let p = 0;
  if (str(0) === 'RIFF') { // RMID
    p = 12; while (p + 8 < d.length && str(p) !== 'data') p += 8 + (d[p + 4] | (d[p + 5] << 8) | (d[p + 6] << 16) | (d[p + 7] << 24)); p += 8;
  }
  if (str(p) !== 'MThd') return 60000;
  const ntr = (d[p + 10] << 8) | d[p + 11]; const div = (d[p + 12] << 8) | d[p + 13];
  p += 8 + r32(p + 4);
  const tempos: [number, number][] = []; let maxTick = 0;
  for (let t = 0; t < ntr && p + 8 <= d.length; t++) {
    if (str(p) !== 'MTrk') break;
    const len = r32(p + 4); let q = p + 8; const end = Math.min(d.length, q + len); let tick = 0; let rs = 0;
    const vlq = () => { let v = 0; for (let i = 0; i < 4; i++) { const b = d[q++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return v; };
    while (q < end) {
      tick += vlq();
      let st = d[q];
      if (st & 0x80) { q++; if (st < 0xf0) rs = st; } else st = rs;
      if (st === 0xff) { const type = d[q++]; const l = vlq(); if (type === 0x51 && l === 3) tempos.push([tick, (d[q] << 16) | (d[q + 1] << 8) | d[q + 2]]); q += l; if (type === 0x2f) break; }
      else if (st === 0xf0 || st === 0xf7) { const l = vlq(); q += l; }
      else { const hi = st & 0xf0; q += (hi === 0xc0 || hi === 0xd0) ? 1 : 2; }
    }
    maxTick = Math.max(maxTick, tick);
    p = end;
  }
  if (div & 0x8000) { const fps = 256 - (div >> 8), tpf = div & 0xff; return maxTick / (fps * tpf) * 1000; }
  tempos.sort((a, b) => a[0] - b[0]);
  let ms = 0, lastTick = 0, tempo = 500000;
  for (const [tk, tp] of tempos) { if (tk > maxTick) break; ms += (tk - lastTick) * tempo / div / 1000; lastTick = tk; tempo = tp; }
  ms += (maxTick - lastTick) * tempo / div / 1000;
  return ms;
}
