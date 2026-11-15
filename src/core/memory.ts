// Linear memory + Win16 style LDT selector table.
export interface Desc { base: number; limit: number; code: boolean; present: boolean; owner?: number; }

export const MEM_SIZE = 64 * 1024 * 1024;

export class Memory {
  buf = new ArrayBuffer(MEM_SIZE);
  u8 = new Uint8Array(this.buf);
  dv = new DataView(this.buf);
  ldt: (Desc | undefined)[] = new Array(8192);
  private nextIdx = 1;
  private freeLinear: { base: number; size: number }[] = [];
  private brk = 0x110000; // keep first MB+64K for real-mode style stuff (IVT etc.)

  // ---- linear allocator (simple first fit with free list) ----
  allocLinear(size: number): number {
    size = (size + 15) & ~15;
    for (let i = 0; i < this.freeLinear.length; i++) {
      const f = this.freeLinear[i];
      if (f.size >= size) {
        const b = f.base;
        f.base += size; f.size -= size;
        if (f.size === 0) this.freeLinear.splice(i, 1);
        this.u8.fill(0, b, b + size);
        return b;
      }
    }
    const b = this.brk;
    this.brk += size;
    if (this.brk > MEM_SIZE) throw new Error('out of emulated memory');
    return b;
  }
  freeLinearBlock(base: number, size: number) {
    size = (size + 15) & ~15;
    this.freeLinear.push({ base, size });
  }

  // ---- selectors ----
  allocSelectors(count: number): number {
    // find `count` consecutive free indices
    let start = this.nextIdx;
    outer: for (;;) {
      if (start + count >= 8192) { start = 1; }
      for (let i = 0; i < count; i++) {
        if (this.ldt[start + i]) { start = start + i + 1; continue outer; }
      }
      break;
    }
    this.nextIdx = start + count;
    return (start << 3) | 7;
  }
  setDesc(sel: number, d: Desc) { this.ldt[sel >> 3] = d; }
  getDesc(sel: number): Desc | undefined { return this.ldt[sel >> 3]; }
  freeSelector(sel: number) { this.ldt[sel >> 3] = undefined; }

  // allocate a block (possibly >64K -> tiled selectors, __AHINCR = 8)
  allocBlock(size: number, code = false): { sel: number; base: number; count: number } {
    const count = Math.max(1, Math.ceil(size / 0x10000));
    const base = this.allocLinear(Math.max(size, 16));
    const sel = this.allocSelectors(count);
    for (let i = 0; i < count; i++) {
      const rem = size - i * 0x10000;
      this.setDesc(sel + i * 8, { base: base + i * 0x10000, limit: Math.max(0, Math.min(rem, 0x10000) - 1), code, present: true });
    }
    return { sel, base, count };
  }

  base(sel: number): number {
    const d = this.ldt[sel >> 3];
    if (!d) throw new SegFault(sel, 0);
    return d.base;
  }
  lin(sel: number, off: number): number {
    if ((sel & 0xfffc) === 0) throw new SegFault(sel, off);
    const d = this.ldt[sel >> 3];
    if (!d) throw new SegFault(sel, off);
    return d.base + (off & 0xffff);
  }
  r8(a: number) { return this.u8[a]; }
  r16(a: number) { return this.u8[a] | (this.u8[a + 1] << 8); }
  r32(a: number) { return (this.u8[a] | (this.u8[a + 1] << 8) | (this.u8[a + 2] << 16) | (this.u8[a + 3] << 24)) >>> 0; }
  w8(a: number, v: number) { this.u8[a] = v; }
  w16(a: number, v: number) { this.u8[a] = v; this.u8[a + 1] = v >> 8; }
  w32(a: number, v: number) { this.u8[a] = v; this.u8[a + 1] = v >> 8; this.u8[a + 2] = v >> 16; this.u8[a + 3] = v >> 24; }

  // far pointer helpers
  rf16(sel: number, off: number) { return this.r16(this.lin(sel, off)); }
  readCStr(sel: number, off: number, max = 0x10000): string {
    if (sel === 0) return '';
    let a = this.lin(sel, off), s = '';
    for (let i = 0; i < max; i++) { const c = this.u8[a + i]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  readCStrFar(p: number): string { return this.readCStr(p >>> 16, p & 0xffff); }
  writeCStr(sel: number, off: number, s: string, max = 0x10000) {
    const a = this.lin(sel, off);
    const n = Math.min(s.length, max - 1);
    for (let i = 0; i < n; i++) this.u8[a + i] = s.charCodeAt(i) & 0xff;
    this.u8[a + n] = 0;
    return n;
  }
  linFar(p: number) { return this.lin(p >>> 16, p & 0xffff); }
}

export class SegFault extends Error {
  constructor(public sel: number, public off: number) { super(`segfault ${sel.toString(16)}:${off.toString(16)}`); }
}
