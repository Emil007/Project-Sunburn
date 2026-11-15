// Cinepak (cvid) decoder -> RGBA frame buffer
interface CB { y: Uint8Array; u: Int8Array; v: Int8Array; }
const newCB = (): CB => ({ y: new Uint8Array(256 * 4), u: new Int8Array(256), v: new Int8Array(256) });

export class Cinepak {
  rgba: Uint8Array;
  strips: { v1: CB; v4: CB }[] = [];
  constructor(public w: number, public h: number) { this.rgba = new Uint8Array(w * h * 4); for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255; }

  decode(d: Uint8Array) {
    if (d.length < 10) return;
    const flags = d[0];
    const nStrips = (d[8] << 8) | d[9];
    let p = 10; let y0 = 0;
    for (let i = 0; i < nStrips && p + 12 <= d.length; i++) {
      if (!this.strips[i]) this.strips[i] = { v1: newCB(), v4: newCB() };
      if (i > 0 && !(flags & 1)) {
        const a = this.strips[i - 1], b = this.strips[i];
        b.v1.y.set(a.v1.y); b.v1.u.set(a.v1.u); b.v1.v.set(a.v1.v); b.v4.y.set(a.v4.y); b.v4.u.set(a.v4.u); b.v4.v.set(a.v4.v);
      }
      const size = (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
      const sh = (d[p + 8] << 8) | d[p + 9];
      const y1 = y0, y2 = y0 + sh;
      const end = Math.min(d.length, p + size);
      let q = p + 12;
      while (q + 4 <= end) {
        const id = d[q]; const cs = (d[q + 1] << 16) | (d[q + 2] << 8) | d[q + 3];
        const ce = Math.min(end, q + cs); const body = q + 4;
        switch (id) {
          case 0x20: case 0x21: case 0x24: case 0x25: this.codebook(d, body, ce, id, this.strips[i].v4); break;
          case 0x22: case 0x23: case 0x26: case 0x27: this.codebook(d, body, ce, id, this.strips[i].v1); break;
          case 0x30: case 0x31: case 0x32: this.vectors(d, body, ce, id, this.strips[i], y1, y2); break;
        }
        if (cs < 4) break;
        q += cs;
      }
      y0 = y2; p += size;
      if (size < 12) break;
    }
  }
  private codebook(d: Uint8Array, p: number, end: number, id: number, cb: CB) {
    const n = id & 4 ? 4 : 6; let flag = 0, mask = 0;
    for (let i = 0; i < 256; i++) {
      if (id & 1) { mask >>>= 1; if (!mask) { if (p + 4 > end) return; flag = ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0; p += 4; mask = 0x80000000; } }
      if (!(id & 1) || (flag & mask)) {
        if (p + n > end) return;
        cb.y[i * 4] = d[p]; cb.y[i * 4 + 1] = d[p + 1]; cb.y[i * 4 + 2] = d[p + 2]; cb.y[i * 4 + 3] = d[p + 3];
        if (n === 6) { cb.u[i] = (d[p + 4] << 24) >> 24; cb.v[i] = (d[p + 5] << 24) >> 24; } else { cb.u[i] = 0; cb.v[i] = 0; }
        p += n;
      }
    }
  }
  private put(x: number, y: number, Y: number, u: number, v: number) {
    if (x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4; const px = this.rgba;
    let r = Y + v * 2, g = Y - (u >> 1) - v, b = Y + u * 2;
    px[o] = r < 0 ? 0 : r > 255 ? 255 : r; px[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g; px[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  private vectors(d: Uint8Array, p: number, end: number, id: number, st: { v1: CB; v4: CB }, y1: number, y2: number) {
    let flag = 0, mask = 0;
    const rd32 = () => { const v = ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0; p += 4; return v; };
    for (let y = y1; y < y2; y += 4) {
      for (let x = 0; x < this.w; x += 4) {
        if (p >= end) return;
        if (id & 1) { mask >>>= 1; if (!mask) { flag = rd32(); mask = 0x80000000; } }
        if (!(id & 1) || (flag & mask)) {
          if (!(id & 2)) { mask >>>= 1; if (!mask) { flag = rd32(); mask = 0x80000000; } }
          if ((id & 2) || (~flag & mask)) {
            const i = d[p++]; const cb = st.v1; const u = cb.u[i], v = cb.v[i];
            const Ys = [cb.y[i * 4], cb.y[i * 4 + 1], cb.y[i * 4 + 2], cb.y[i * 4 + 3]];
            for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) this.put(x + bx, y + by, Ys[(by >> 1) * 2 + (bx >> 1)], u, v);
          } else {
            const idx = [d[p], d[p + 1], d[p + 2], d[p + 3]]; p += 4; const cb = st.v4;
            for (let k = 0; k < 4; k++) {
              const i = idx[k]; const ox = (k & 1) * 2, oy = (k >> 1) * 2; const u = cb.u[i], v = cb.v[i];
              this.put(x + ox, y + oy, cb.y[i * 4], u, v); this.put(x + ox + 1, y + oy, cb.y[i * 4 + 1], u, v);
              this.put(x + ox, y + oy + 1, cb.y[i * 4 + 2], u, v); this.put(x + ox + 1, y + oy + 1, cb.y[i * 4 + 3], u, v);
            }
          }
        }
      }
    }
  }
}
