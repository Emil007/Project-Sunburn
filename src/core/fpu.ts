// x87 FPU emulation using JS doubles (80-bit values approximated).
import type { CPU } from './cpu';

const f64 = new Float64Array(1); const f64u8 = new Uint8Array(f64.buffer);
const f32 = new Float32Array(1); const f32u8 = new Uint8Array(f32.buffer);

export class FPU {
  st = new Float64Array(8);
  tag = new Uint8Array(8).fill(1); // 1 = empty
  top = 0;
  sw = 0; cw = 0x037f;
  constructor(private cpu: CPU) {}

  private idx(i: number) { return (this.top + i) & 7; }
  get(i: number) { return this.st[this.idx(i)]; }
  set(i: number, v: number) { const k = this.idx(i); this.st[k] = v; this.tag[k] = 0; }
  push(v: number) { this.top = (this.top - 1) & 7; this.st[this.top] = v; this.tag[this.top] = 0; }
  pop() { const v = this.st[this.top]; this.tag[this.top] = 1; this.top = (this.top + 1) & 7; return v; }
  swFull() { return (this.sw & ~0x3800) | (this.top << 11); }
  reset() { this.top = 0; this.tag.fill(1); this.sw = 0; this.cw = 0x037f; }

  round(v: number): number {
    switch ((this.cw >> 10) & 3) {
      case 0: { // nearest even
        const f = Math.floor(v); const d = v - f;
        if (d > 0.5) return f + 1; if (d < 0.5) return f; return (f % 2 === 0) ? f : f + 1;
      }
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      default: return Math.trunc(v);
    }
  }

  // memory helpers
  private m = () => this.cpu.mem;
  rdF32(a: number) { for (let i = 0; i < 4; i++) f32u8[i] = this.cpu.u8[a + i]; return f32[0]; }
  wrF32(a: number, v: number) { f32[0] = v; for (let i = 0; i < 4; i++) this.cpu.u8[a + i] = f32u8[i]; }
  rdF64(a: number) { for (let i = 0; i < 8; i++) f64u8[i] = this.cpu.u8[a + i]; return f64[0]; }
  wrF64(a: number, v: number) { f64[0] = v; for (let i = 0; i < 8; i++) this.cpu.u8[a + i] = f64u8[i]; }
  rdF80(a: number) {
    const u8 = this.cpu.u8;
    let mant = 0n; for (let i = 7; i >= 0; i--) mant = (mant << 8n) | BigInt(u8[a + i]);
    const se = u8[a + 8] | (u8[a + 9] << 8); const sign = se & 0x8000 ? -1 : 1; const e = se & 0x7fff;
    if (e === 0 && mant === 0n) return sign * 0;
    if (e === 0x7fff) return (mant << 1n) & 0xffffffffffffffffn ? NaN : sign * Infinity;
    // value = mant * 2^(e-16383-63)
    const hi = Number(mant >> 11n); // 53 bits
    return sign * hi * Math.pow(2, e - 16383 - 52);
  }
  wrF80(a: number, v: number) {
    const u8 = this.cpu.u8;
    let sign = 0; if (v < 0 || Object.is(v, -0)) { sign = 0x8000; v = -v; }
    let e: number, mant: bigint;
    if (v === 0) { e = 0; mant = 0n; }
    else if (!isFinite(v)) { e = 0x7fff; mant = isNaN(v) ? 0xc000000000000000n : 0x8000000000000000n; }
    else {
      f64[0] = v; const dv = new DataView(f64.buffer);
      const bits = dv.getBigUint64(0, true); let ex = Number((bits >> 52n) & 0x7ffn); let fr = bits & 0xfffffffffffffn;
      if (ex === 0) { // denormal double
        let ee = -1022; while (!(fr & 0x10000000000000n)) { fr <<= 1n; ee--; } fr &= 0xfffffffffffffn; ex = ee + 1023;
      }
      e = ex - 1023 + 16383; mant = ((fr | 0x10000000000000n) << 11n);
    }
    for (let i = 0; i < 8; i++) { u8[a + i] = Number(mant & 0xffn); mant >>= 8n; }
    const se = sign | e; u8[a + 8] = se & 0xff; u8[a + 9] = se >> 8;
  }
  rdI16(a: number) { return (this.m().r16(a) << 16) >> 16; }
  rdI32(a: number) { return this.m().r32(a) | 0; }
  rdI64(a: number) { const lo = this.m().r32(a); const hi = this.m().r32(a + 4) | 0; return hi * 4294967296 + lo; }
  wrI16(a: number, v: number) { this.m().w16(a, v & 0xffff); }
  wrI32(a: number, v: number) { this.m().w32(a, v | 0); }
  wrI64(a: number, v: number) { const b = BigInt.asUintN(64, BigInt(v)); this.m().w32(a, Number(b & 0xffffffffn)); this.m().w32(a + 4, Number(b >> 32n)); }
  rdBCD(a: number) { let v = 0; for (let i = 8; i >= 0; i--) { const b = this.cpu.u8[a + i]; v = v * 100 + (b >> 4) * 10 + (b & 15); } return this.cpu.u8[a + 9] & 0x80 ? -v : v; }
  wrBCD(a: number, v: number) { const neg = v < 0; v = Math.abs(this.round(v)); for (let i = 0; i < 9; i++) { const d = v % 100; v = Math.floor(v / 100); this.cpu.u8[a + i] = ((Math.floor(d / 10)) << 4) | (d % 10); } this.cpu.u8[a + 9] = neg ? 0x80 : 0; }

  toInt(v: number, bits: number) {
    if (!isFinite(v)) return bits === 16 ? -0x8000 : bits === 32 ? -0x80000000 : -9223372036854775808;
    let r = this.round(v);
    const lim = bits === 16 ? 0x8000 : bits === 32 ? 0x80000000 : 9223372036854775808;
    if (r >= lim || r < -lim) { this.sw |= 1; return -lim; }
    return r;
  }

  compare(a: number, b: number, unordered = false) {
    this.sw &= ~0x4500;
    if (isNaN(a) || isNaN(b)) this.sw |= 0x4500;
    else if (a < b) this.sw |= 0x0100;
    else if (a === b) this.sw |= 0x4000;
  }
  private arith(op: number, a: number, b: number): number {
    switch (op) {
      case 0: return a + b;
      case 1: return a * b;
      case 4: return a - b;
      case 5: return b - a;
      case 6: return a / b;
      case 7: return b / a;
    }
    return NaN;
  }

  exec(op: number, mod: number, reg: number, rm: number) {
    const cpu = this.cpu;
    if (mod !== 3) {
      const a = cpu.fpuEA();
      switch (op) {
        case 0xd8: case 0xdc: case 0xda: case 0xde: {
          const v = op === 0xd8 ? this.rdF32(a) : op === 0xdc ? this.rdF64(a) : op === 0xda ? this.rdI32(a) : this.rdI16(a);
          if (reg === 2 || reg === 3) { this.compare(this.get(0), v); if (reg === 3) this.pop(); return; }
          this.set(0, this.arith(reg, this.get(0), v)); return;
        }
        case 0xd9:
          switch (reg) {
            case 0: this.push(this.rdF32(a)); return;
            case 2: this.wrF32(a, this.get(0)); return;
            case 3: this.wrF32(a, this.pop()); return;
            case 4: return; // fldenv (ignore)
            case 5: this.cw = cpu.mem.r16(a); return;
            case 6: { // fstenv
              const m = cpu.mem; m.w16(a, this.cw); m.w16(a + 2, this.swFull()); let tw = 0; for (let i = 0; i < 8; i++) tw |= (this.tag[i] ? 3 : 0) << (i * 2); m.w16(a + 4, tw); for (let i = 6; i < 14; i += 2) m.w16(a + i, 0); return;
            }
            case 7: cpu.mem.w16(a, this.cw); return;
          }
          break;
        case 0xdb:
          switch (reg) {
            case 0: this.push(this.rdI32(a)); return;
            case 1: this.wrI32(a, Math.trunc(this.pop())); return;
            case 2: this.wrI32(a, this.toInt(this.get(0), 32)); return;
            case 3: this.wrI32(a, this.toInt(this.pop(), 32)); return;
            case 5: this.push(this.rdF80(a)); return;
            case 7: this.wrF80(a, this.pop()); return;
          }
          break;
        case 0xdd:
          switch (reg) {
            case 0: this.push(this.rdF64(a)); return;
            case 1: this.wrI64(a, Math.trunc(this.pop())); return;
            case 2: this.wrF64(a, this.get(0)); return;
            case 3: this.wrF64(a, this.pop()); return;
            case 4: { // frstor
              this.cw = cpu.mem.r16(a); const sw = cpu.mem.r16(a + 2); this.sw = sw & ~0x3800; this.top = (sw >> 11) & 7;
              const tw = cpu.mem.r16(a + 4);
              for (let i = 0; i < 8; i++) { this.st[(this.top + i) & 7] = this.rdF80(a + 14 + i * 10); }
              for (let i = 0; i < 8; i++) this.tag[i] = ((tw >> (i * 2)) & 3) === 3 ? 1 : 0;
              return;
            }
            case 6: { // fsave
              const m = cpu.mem; m.w16(a, this.cw); m.w16(a + 2, this.swFull()); let tw = 0; for (let i = 0; i < 8; i++) tw |= (this.tag[i] ? 3 : 0) << (i * 2); m.w16(a + 4, tw);
              for (let i = 6; i < 14; i += 2) m.w16(a + i, 0);
              for (let i = 0; i < 8; i++) this.wrF80(a + 14 + i * 10, this.st[(this.top + i) & 7]);
              this.reset(); return;
            }
            case 7: cpu.mem.w16(a, this.swFull()); return;
          }
          break;
        case 0xdf:
          switch (reg) {
            case 0: this.push(this.rdI16(a)); return;
            case 1: this.wrI16(a, Math.trunc(this.pop())); return;
            case 2: this.wrI16(a, this.toInt(this.get(0), 16)); return;
            case 3: this.wrI16(a, this.toInt(this.pop(), 16)); return;
            case 4: this.push(this.rdBCD(a)); return;
            case 5: this.push(this.rdI64(a)); return;
            case 6: this.wrBCD(a, this.pop()); return;
            case 7: this.wrI64(a, this.toInt(this.pop(), 64)); return;
          }
          break;
      }
      cpu.bad(op);
    }
    // register forms
    const i = rm;
    switch (op) {
      case 0xd8:
        if (reg === 2 || reg === 3) { this.compare(this.get(0), this.get(i)); if (reg === 3) this.pop(); return; }
        this.set(0, this.arith(reg, this.get(0), this.get(i))); return;
      case 0xdc:
        if (reg === 2 || reg === 3) { this.compare(this.get(0), this.get(i)); if (reg === 3) this.pop(); return; }
        // dest = st(i): note reversal of sub/div semantics
        { const r = reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg; this.set(i, this.arith(r, this.get(i), this.get(0))); }
        return;
      case 0xde:
        if (reg === 3 && i === 1) { this.compare(this.get(0), this.get(1)); this.pop(); this.pop(); return; }
        { const r = reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg; this.set(i, this.arith(r, this.get(i), this.get(0))); this.pop(); }
        return;
      case 0xd9:
        switch (reg) {
          case 0: { const v = this.get(i); this.push(v); return; }
          case 1: { const t = this.get(0); this.set(0, this.get(i)); this.set(i, t); return; }
          case 2: return; // fnop
          case 3: this.set(i, this.get(0)); this.pop(); return; // fstp1 alias
          case 4:
            switch (i) {
              case 0: this.set(0, -this.get(0)); return;
              case 1: this.set(0, Math.abs(this.get(0))); return;
              case 4: this.compare(this.get(0), 0); return;
              case 5: { // fxam
                const v = this.get(0); this.sw &= ~0x4700;
                if (this.tag[this.idx(0)]) this.sw |= 0x4100;
                else if (isNaN(v)) this.sw |= 0x0100;
                else if (!isFinite(v)) this.sw |= 0x0500;
                else if (v === 0) this.sw |= 0x4000;
                else this.sw |= 0x0400;
                if (v < 0 || Object.is(v, -0)) this.sw |= 0x0200;
                return;
              }
            }
            break;
          case 5: {
            const c = [1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0][i];
            if (c === undefined) break; this.push(c); return;
          }
          case 6:
            switch (i) {
              case 0: this.set(0, Math.pow(2, this.get(0)) - 1); return; // f2xm1
              case 1: { const y = this.get(1) * Math.log2(this.get(0)); this.pop(); this.set(0, y); return; } // fyl2x
              case 2: this.set(0, Math.tan(this.get(0))); this.push(1); this.sw &= ~0x400; return; // fptan
              case 3: { const y = Math.atan2(this.get(1), this.get(0)); this.pop(); this.set(0, y); return; } // fpatan
              case 4: { // fxtract
                const v = this.get(0); if (v === 0) { this.set(0, -Infinity); this.push(v); return; }
                const e = Math.floor(Math.log2(Math.abs(v))); this.set(0, e); this.push(v / Math.pow(2, e)); return;
              }
              case 5: { const a = this.get(0), b = this.get(1); const q = Math.round(a / b); this.set(0, a - q * b); this.sw &= ~0x400; return; } // fprem1
              case 6: this.top = (this.top - 1) & 7; return;
              case 7: this.top = (this.top + 1) & 7; return;
            }
            break;
          case 7:
            switch (i) {
              case 0: { // fprem
                const a = this.get(0), b = this.get(1); const q = Math.trunc(a / b); this.set(0, a - q * b);
                this.sw &= ~0x4700; if (q & 1) this.sw |= 0x0200; if (q & 2) this.sw |= 0x4000; if (q & 4) this.sw |= 0x0100; return;
              }
              case 1: { const y = this.get(1) * Math.log2(this.get(0) + 1); this.pop(); this.set(0, y); return; }
              case 2: this.set(0, Math.sqrt(this.get(0))); return;
              case 3: { const v = this.get(0); this.set(0, Math.sin(v)); this.push(Math.cos(v)); this.sw &= ~0x400; return; }
              case 4: this.set(0, this.round(this.get(0))); return;
              case 5: this.set(0, this.get(0) * Math.pow(2, Math.trunc(this.get(1)))); return;
              case 6: this.set(0, Math.sin(this.get(0))); this.sw &= ~0x400; return;
              case 7: this.set(0, Math.cos(this.get(0))); this.sw &= ~0x400; return;
            }
            break;
        }
        break;
      case 0xda:
        if (reg === 5 && i === 1) { this.compare(this.get(0), this.get(1)); this.pop(); this.pop(); return; }
        break;
      case 0xdb:
        if (reg === 4) {
          if (i === 2) { this.sw &= 0x7f00; return; } // fclex
          if (i === 3) { this.reset(); return; } // finit
          if (i === 0 || i === 1 || i === 4) return; // feni/fdisi/fsetpm
        }
        break;
      case 0xdd:
        switch (reg) {
          case 0: this.tag[this.idx(i)] = 1; return; // ffree
          case 2: this.set(i, this.get(0)); return;
          case 3: this.set(i, this.get(0)); this.pop(); return;
          case 4: this.compare(this.get(0), this.get(i)); return;
          case 5: this.compare(this.get(0), this.get(i)); this.pop(); return;
        }
        break;
      case 0xdf:
        if (reg === 4 && i === 0) { cpu.ax = this.swFull(); return; } // fstsw ax
        if (reg === 0) { this.tag[this.idx(i)] = 1; this.pop(); return; }
        break;
    }
    cpu.bad(op);
  }
}
