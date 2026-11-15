// x86 16-bit protected-mode (Win16) interpreter with 386 operand/address-size support.
import { Memory, SegFault } from './memory';
import { FPU } from './fpu';

export const CF = 0x1, PF = 0x4, AF = 0x10, ZF = 0x40, SF = 0x80, TF = 0x100, IF = 0x200, DF = 0x400, OF = 0x800;
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;
export const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

const parity = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let p = 0, v = i; while (v) { p ^= v & 1; v >>= 1; } parity[i] = p ? 0 : PF; }

export class CPUFault extends Error {
  constructor(public vec: number, msg: string) { super(msg); }
}

export class CPU {
  r = new Int32Array(8);
  s = new Uint16Array(6);       // selectors
  sb = new Int32Array(6);       // segment bases
  ip = 0;
  flags = 0x202;
  mem: Memory;
  u8: Uint8Array;
  fpu: FPU;
  // decode state
  private segOv = -1;
  private opsz32 = false;
  private adsz32 = false;
  private rep = 0;
  private instIp = 0;
  // hooks
  onInt: (n: number) => boolean = () => false;
  onNative: (id: number) => void = () => { throw new Error('native'); };
  halted = false;
  depth = 0;
  icount = 0;
  trace: ((cpu: CPU) => void) | null = null;

  constructor(mem: Memory) { this.mem = mem; this.u8 = mem.u8; this.fpu = new FPU(this); }

  // ---------- registers ----------
  get ax() { return this.r[0] & 0xffff; } set ax(v: number) { this.r[0] = (this.r[0] & ~0xffff) | (v & 0xffff); }
  get cx() { return this.r[1] & 0xffff; } set cx(v: number) { this.r[1] = (this.r[1] & ~0xffff) | (v & 0xffff); }
  get dx() { return this.r[2] & 0xffff; } set dx(v: number) { this.r[2] = (this.r[2] & ~0xffff) | (v & 0xffff); }
  get bx() { return this.r[3] & 0xffff; } set bx(v: number) { this.r[3] = (this.r[3] & ~0xffff) | (v & 0xffff); }
  get sp() { return this.r[4] & 0xffff; } set sp(v: number) { this.r[4] = (this.r[4] & ~0xffff) | (v & 0xffff); }
  get bp() { return this.r[5] & 0xffff; } set bp(v: number) { this.r[5] = (this.r[5] & ~0xffff) | (v & 0xffff); }
  get si() { return this.r[6] & 0xffff; } set si(v: number) { this.r[6] = (this.r[6] & ~0xffff) | (v & 0xffff); }
  get di() { return this.r[7] & 0xffff; } set di(v: number) { this.r[7] = (this.r[7] & ~0xffff) | (v & 0xffff); }
  get al() { return this.r[0] & 0xff; } set al(v: number) { this.r[0] = (this.r[0] & ~0xff) | (v & 0xff); }
  get ah() { return (this.r[0] >> 8) & 0xff; } set ah(v: number) { this.r[0] = (this.r[0] & ~0xff00) | ((v & 0xff) << 8); }
  get bl() { return this.r[3] & 0xff; } set bl(v: number) { this.setReg8(3, v); }
  get bh() { return (this.r[3] >> 8) & 0xff; } set bh(v: number) { this.setReg8(7, v); }
  get cl() { return this.r[1] & 0xff; } set cl(v: number) { this.setReg8(1, v); }
  get ch() { return (this.r[1] >> 8) & 0xff; } set ch(v: number) { this.setReg8(5, v); }
  get dl() { return this.r[2] & 0xff; } set dl(v: number) { this.setReg8(2, v); }
  get dh() { return (this.r[2] >> 8) & 0xff; } set dh(v: number) { this.setReg8(6, v); }
  get cs() { return this.s[CS]; } get ds() { return this.s[DS]; } get es() { return this.s[ES]; } get ss() { return this.s[SS]; }

  reg8(i: number) { return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8) & 0xff; }
  setReg8(i: number, v: number) {
    if (i < 4) this.r[i] = (this.r[i] & ~0xff) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & ~0xff00) | ((v & 0xff) << 8);
  }
  reg16(i: number) { return this.r[i] & 0xffff; }
  setReg16(i: number, v: number) { this.r[i] = (this.r[i] & ~0xffff) | (v & 0xffff); }
  reg32(i: number) { return this.r[i] >>> 0; }
  setReg32(i: number, v: number) { this.r[i] = v | 0; }

  loadSeg(i: number, sel: number) {
    sel &= 0xffff;
    if ((sel & 0xfffc) === 0) {
      if (i === CS || i === SS) throw new CPUFault(13, `null selector into ${i}`);
      this.s[i] = sel; this.sb[i] = 0; return;
    }
    const d = this.mem.ldt[sel >> 3];
    if (!d) throw new CPUFault(13, `bad selector ${sel.toString(16)} into seg ${i} at ${this.s[CS].toString(16)}:${this.instIp.toString(16)}`);
    this.s[i] = sel; this.sb[i] = d.base;
  }
  // refresh cached bases (after descriptor changes)
  refreshSegs() {
    for (let i = 0; i < 6; i++) {
      const sel = this.s[i];
      if ((sel & 0xfffc) === 0) { this.sb[i] = 0; continue; }
      const d = this.mem.ldt[sel >> 3];
      this.sb[i] = d ? d.base : 0;
    }
  }

  // ---------- stack ----------
  push16(v: number) { const sp = (this.r[4] - 2) & 0xffff; this.setReg16(4, sp); const a = this.sb[SS] + sp; this.u8[a] = v; this.u8[a + 1] = v >> 8; }
  pop16() { const sp = this.r[4] & 0xffff; const a = this.sb[SS] + sp; const v = this.u8[a] | (this.u8[a + 1] << 8); this.setReg16(4, sp + 2); return v; }
  push32(v: number) { const sp = (this.r[4] - 4) & 0xffff; this.setReg16(4, sp); this.mem.w32(this.sb[SS] + sp, v); }
  pop32() { const sp = this.r[4] & 0xffff; const v = this.mem.r32(this.sb[SS] + sp); this.setReg16(4, sp + 4); return v; }
  pushv(v: number) { if (this.opsz32) this.push32(v); else this.push16(v); }
  popv() { return this.opsz32 ? this.pop32() : this.pop16(); }
  // stack arg accessors (relative to SP)
  stk16(off: number) { return this.mem.r16(this.sb[SS] + ((this.sp + off) & 0xffff)); }
  stk32(off: number) { return (this.stk16(off) | (this.stk16(off + 2) << 16)) >>> 0; }

  // ---------- fetch ----------
  private f8() { const v = this.u8[this.sb[CS] + this.ip]; this.ip = (this.ip + 1) & 0xffff; return v; }
  private f16() { const a = this.sb[CS] + this.ip; const v = this.u8[a] | (this.u8[a + 1] << 8); this.ip = (this.ip + 2) & 0xffff; return v; }
  private f32() { const lo = this.f16(); const hi = this.f16(); return (lo | (hi << 16)) >>> 0; }
  private fv() { return this.opsz32 ? this.f32() : this.f16(); }
  private fs8() { return (this.f8() << 24) >> 24; }
  private fs16() { return (this.f16() << 16) >> 16; }

  // ---------- modrm ----------
  private mod = 0; private rm = 0; private regf = 0;
  private eaSeg = 0; private eaOff = 0;
  private modrm() {
    const m = this.f8();
    this.mod = m >> 6; this.regf = (m >> 3) & 7; this.rm = m & 7;
    if (this.mod !== 3) this.calcEA();
  }
  private calcEA() {
    const mod = this.mod, rm = this.rm;
    let seg = DS, off = 0;
    if (!this.adsz32) {
      switch (rm) {
        case 0: off = this.bx + this.si; break;
        case 1: off = this.bx + this.di; break;
        case 2: off = this.bp + this.si; seg = SS; break;
        case 3: off = this.bp + this.di; seg = SS; break;
        case 4: off = this.si; break;
        case 5: off = this.di; break;
        case 6: if (mod === 0) off = this.f16(); else { off = this.bp; seg = SS; } break;
        case 7: off = this.bx; break;
      }
      if (mod === 1) off += this.fs8(); else if (mod === 2) off += this.f16();
      off &= 0xffff;
    } else {
      if (rm === 4) {
        const sib = this.f8(); const sc = sib >> 6, idx = (sib >> 3) & 7, b = sib & 7;
        if (b === 5 && mod === 0) off = this.f32() | 0; else { off = this.r[b]; if (b === 4 || b === 5) seg = SS; }
        if (idx !== 4) off += this.r[idx] << sc;
      } else if (rm === 5 && mod === 0) off = this.f32() | 0;
      else { off = this.r[rm]; if (rm === 5) seg = SS; }
      if (mod === 1) off += this.fs8(); else if (mod === 2) off += this.f32() | 0;
      off = off >>> 0;
    }
    this.eaSeg = this.segOv >= 0 ? this.segOv : seg;
    this.eaOff = off;
  }
  ea() { return this.sb[this.eaSeg] + this.eaOff; }
  eaAt(add: number) { return this.sb[this.eaSeg] + (this.adsz32 ? (this.eaOff + add) >>> 0 : ((this.eaOff + add) & 0xffff)); }
  private rm8() { return this.mod === 3 ? this.reg8(this.rm) : this.u8[this.ea()]; }
  private setRm8(v: number) { if (this.mod === 3) this.setReg8(this.rm, v); else this.u8[this.ea()] = v; }
  private rm16() { if (this.mod === 3) return this.r[this.rm] & 0xffff; return this.mem.r16(this.ea()); }
  private setRm16(v: number) { if (this.mod === 3) this.setReg16(this.rm, v); else this.mem.w16(this.ea(), v); }
  private rm32() { if (this.mod === 3) return this.r[this.rm] >>> 0; return this.mem.r32(this.ea()); }
  private setRm32(v: number) { if (this.mod === 3) this.r[this.rm] = v | 0; else this.mem.w32(this.ea(), v); }
  private rmv() { return this.opsz32 ? this.rm32() : this.rm16(); }
  private setRmv(v: number) { if (this.opsz32) this.setRm32(v); else this.setRm16(v); }
  private regv() { return this.opsz32 ? this.r[this.regf] >>> 0 : this.r[this.regf] & 0xffff; }
  private setRegv(v: number) { if (this.opsz32) this.r[this.regf] = v | 0; else this.setReg16(this.regf, v); }
  // public helpers for FPU
  get modv() { return this.mod; } get rmv_() { return this.rm; } get regfv() { return this.regf; }

  // ---------- flags/ALU ----------
  private setSZP(v: number, bits: number) {
    let f = this.flags & ~(SF | ZF | PF);
    const m = bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff;
    v = bits === 32 ? v >>> 0 : v & m;
    if (v === 0) f |= ZF;
    if (bits === 32 ? (v >>> 31) : (v >> (bits - 1)) & 1) f |= SF;
    f |= parity[v & 0xff];
    this.flags = f;
  }
  private mask(bits: number) { return bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffffff; }
  alu(op: number, a: number, b: number, bits: number): number {
    const m = this.mask(bits); const sb = bits === 32 ? 0x80000000 : 1 << (bits - 1);
    let r = 0, f = this.flags & ~(CF | OF | AF);
    switch (op) {
      case 0: // add
      case 2: { // adc
        const c = op === 2 && (this.flags & CF) ? 1 : 0;
        const full = a + b + c;
        r = bits === 32 ? full >>> 0 : full & m;
        if (full > m) f |= CF;
        if (((a ^ r) & (b ^ r) & sb) !== 0) f |= OF;
        if (((a ^ b ^ r) & 0x10) !== 0) f |= AF;
        break;
      }
      case 5: // sub
      case 3: // sbb
      case 7: { // cmp
        const c = op === 3 && (this.flags & CF) ? 1 : 0;
        const full = a - b - c;
        r = bits === 32 ? full >>> 0 : full & m;
        if (full < 0) f |= CF;
        if (((a ^ b) & (a ^ r) & sb) !== 0) f |= OF;
        if (((a ^ b ^ r) & 0x10) !== 0) f |= AF;
        break;
      }
      case 1: r = (a | b); if (bits === 32) r >>>= 0; break;
      case 4: r = (a & b); if (bits === 32) r >>>= 0; break;
      case 6: r = (a ^ b); if (bits === 32) r >>>= 0; break;
    }
    this.flags = f;
    this.setSZP(r, bits);
    return r;
  }
  private inc(a: number, bits: number) {
    const cf = this.flags & CF; const r = this.alu(0, a, 1, bits); this.flags = (this.flags & ~CF) | cf; return r;
  }
  private dec(a: number, bits: number) {
    const cf = this.flags & CF; const r = this.alu(5, a, 1, bits); this.flags = (this.flags & ~CF) | cf; return r;
  }
  private shift(op: number, v: number, cnt: number, bits: number): number {
    cnt &= 0x1f;
    if (cnt === 0) return v;
    const m = this.mask(bits); const sb = bits === 32 ? 0x80000000 : 1 << (bits - 1);
    let f = this.flags; let r = v;
    const top = (x: number) => (bits === 32 ? (x >>> 31) : (x >> (bits - 1)) & 1);
    switch (op) {
      case 0: { // rol
        const c = cnt % bits;
        r = c ? (bits === 32 ? ((v << c) | (v >>> (32 - c))) >>> 0 : ((v << c) | (v >> (bits - c))) & m) : v;
        f = (f & ~CF) | (r & 1);
        f = (f & ~OF) | (((r & 1) ^ top(r)) ? OF : 0);
        this.flags = f; return r;
      }
      case 1: { // ror
        const c = cnt % bits;
        r = c ? (bits === 32 ? ((v >>> c) | (v << (32 - c))) >>> 0 : ((v >> c) | (v << (bits - c))) & m) : v;
        f = (f & ~CF) | top(r);
        f = (f & ~OF) | ((top(r) ^ ((r >> (bits - 2)) & 1)) ? OF : 0);
        this.flags = f; return r;
      }
      case 2: { // rcl
        const c = cnt % (bits + 1);
        for (let i = 0; i < c; i++) {
          const nc = top(r); r = bits === 32 ? ((r << 1) | (f & CF)) >>> 0 : ((r << 1) | (f & CF)) & m; f = (f & ~CF) | nc;
        }
        f = (f & ~OF) | ((top(r) ^ (f & CF)) ? OF : 0);
        this.flags = f; return r;
      }
      case 3: { // rcr
        const c = cnt % (bits + 1);
        f = (f & ~OF) | ((top(r) ^ (f & CF)) ? OF : 0);
        for (let i = 0; i < c; i++) {
          const nc = r & 1; r = (r >>> 1) | ((f & CF) ? sb : 0); if (bits === 32) r >>>= 0; f = (f & ~CF) | nc;
        }
        this.flags = f; return r;
      }
      case 4: case 6: { // shl/sal
        const cf = cnt <= bits ? (bits === 32 ? (cnt === 32 ? v & 1 : (v >>> (32 - cnt)) & 1) : (v >> (bits - cnt)) & 1) : 0;
        r = cnt >= 32 ? 0 : (bits === 32 ? (v << cnt) >>> 0 : (v << cnt) & m);
        this.setSZP(r, bits); f = this.flags;
        f = (f & ~(CF | OF | AF)) | (cf ? CF : 0) | ((top(r) ^ cf) ? OF : 0);
        this.flags = f; return r;
      }
      case 5: { // shr
        const cf = cnt <= 32 ? (cnt === 32 ? 0 : (v >>> (cnt - 1)) & 1) : 0;
        r = cnt >= 32 ? 0 : v >>> cnt;
        this.setSZP(r, bits); f = this.flags;
        f = (f & ~(CF | OF | AF)) | (cf ? CF : 0) | (top(v) ? OF : 0);
        this.flags = f; return r;
      }
      case 7: { // sar
        const sv = bits === 8 ? (v << 24) >> 24 : bits === 16 ? (v << 16) >> 16 : v | 0;
        const c = Math.min(cnt, 31);
        const cf = (sv >> (c - 1)) & 1;
        r = (sv >> c) & m; if (bits === 32) r >>>= 0;
        this.setSZP(r, bits); f = this.flags;
        f = (f & ~(CF | OF | AF)) | (cf ? CF : 0);
        this.flags = f; return r;
      }
    }
    return r;
  }
  cond(c: number): boolean {
    const f = this.flags;
    let r: boolean;
    switch (c >> 1) {
      case 0: r = (f & OF) !== 0; break;
      case 1: r = (f & CF) !== 0; break;
      case 2: r = (f & ZF) !== 0; break;
      case 3: r = (f & (CF | ZF)) !== 0; break;
      case 4: r = (f & SF) !== 0; break;
      case 5: r = (f & PF) !== 0; break;
      case 6: r = ((f & SF) !== 0) !== ((f & OF) !== 0); break;
      default: r = (f & ZF) !== 0 || (((f & SF) !== 0) !== ((f & OF) !== 0)); break;
    }
    return (c & 1) ? !r : r;
  }

  // ---------- far control transfer ----------
  farJump(sel: number, off: number) { this.loadSeg(CS, sel); this.ip = off & 0xffff; }
  farCall(sel: number, off: number) {
    this.push16(this.s[CS]); this.push16(this.ip); this.farJump(sel, off);
  }
  retf(n: number) {
    const ip = this.pop16(); const cs = this.pop16();
    this.sp = this.sp + n;
    this.farJump(cs, ip);
  }

  // Execute until `cond` returns false
  run(maxSteps = Infinity) {
    let n = 0;
    while (!this.halted && n < maxSteps) { this.step(); n++; }
  }

  // ---------- main step ----------
  step() {
    this.segOv = -1; this.opsz32 = false; this.adsz32 = false; this.rep = 0;
    this.instIp = this.ip;
    this.icount++;
    if (this.trace) this.trace(this);
    let op: number;
    for (;;) {
      op = this.f8();
      switch (op) {
        case 0x26: this.segOv = ES; continue;
        case 0x2e: this.segOv = CS; continue;
        case 0x36: this.segOv = SS; continue;
        case 0x3e: this.segOv = DS; continue;
        case 0x64: this.segOv = FS; continue;
        case 0x65: this.segOv = GS; continue;
        case 0x66: this.opsz32 = true; continue;
        case 0x67: this.adsz32 = true; continue;
        case 0xf0: continue;
        case 0xf2: this.rep = 2; continue;
        case 0xf3: this.rep = 3; continue;
      }
      break;
    }
    this.exec(op);
  }

  get bitsV() { return this.opsz32 ? 32 : 16; }
  get curInstIp() { return this.instIp; }

  private exec(op: number) {
    const bv = this.opsz32 ? 32 : 16;
    if (op < 0x40 && (op & 7) < 6) {
      // ALU group
      const aop = op >> 3;
      switch (op & 7) {
        case 0: { this.modrm(); const r = this.alu(aop, this.rm8(), this.reg8(this.regf), 8); if (aop !== 7) this.setRm8(r); return; }
        case 1: { this.modrm(); const r = this.alu(aop, this.rmv(), this.regv(), bv); if (aop !== 7) this.setRmv(r); return; }
        case 2: { this.modrm(); const r = this.alu(aop, this.reg8(this.regf), this.rm8(), 8); if (aop !== 7) this.setReg8(this.regf, r); return; }
        case 3: { this.modrm(); const r = this.alu(aop, this.regv(), this.rmv(), bv); if (aop !== 7) this.setRegv(r); return; }
        case 4: { const r = this.alu(aop, this.al, this.f8(), 8); if (aop !== 7) this.al = r; return; }
        case 5: {
          const a = this.opsz32 ? this.r[0] >>> 0 : this.ax;
          const r = this.alu(aop, a, this.fv(), bv);
          if (aop !== 7) { if (this.opsz32) this.r[0] = r; else this.ax = r; }
          return;
        }
      }
    }
    switch (op) {
      case 0x06: this.push16(this.s[ES]); return;
      case 0x07: this.loadSeg(ES, this.pop16()); return;
      case 0x0e: this.push16(this.s[CS]); return;
      case 0x16: this.push16(this.s[SS]); return;
      case 0x17: this.loadSeg(SS, this.pop16()); return;
      case 0x1e: this.push16(this.s[DS]); return;
      case 0x1f: this.loadSeg(DS, this.pop16()); return;
      case 0x0f: this.exec0f(); return;
      case 0x27: { // DAA
        let al = this.al; const oc = this.flags & CF; let f = this.flags & ~(CF | AF);
        if ((al & 0xf) > 9 || (this.flags & AF)) { al += 6; f |= AF | (oc || al > 0xff ? CF : 0); }
        if (this.al > 0x99 || oc) { al += 0x60; f |= CF; }
        this.al = al; this.flags = f; this.setSZP(al & 0xff, 8); this.flags = (this.flags & ~(CF | AF)) | (f & (CF | AF)); return;
      }
      case 0x2f: { // DAS
        let al = this.al; const oc = this.flags & CF; let f = this.flags & ~(CF | AF);
        if ((al & 0xf) > 9 || (this.flags & AF)) { al -= 6; f |= AF | (oc || al < 0 ? CF : 0); }
        if (this.al > 0x99 || oc) { al -= 0x60; f |= CF; }
        this.al = al; this.setSZP(al & 0xff, 8); this.flags = (this.flags & ~(CF | AF)) | (f & (CF | AF)); return;
      }
      case 0x37: { // AAA
        if ((this.al & 0xf) > 9 || (this.flags & AF)) { this.ax = this.ax + 0x106; this.flags |= AF | CF; } else this.flags &= ~(AF | CF);
        this.al = this.al & 0xf; return;
      }
      case 0x3f: { // AAS
        if ((this.al & 0xf) > 9 || (this.flags & AF)) { this.ax = this.ax - 6; this.ah = this.ah - 1; this.flags |= AF | CF; } else this.flags &= ~(AF | CF);
        this.al = this.al & 0xf; return;
      }
    }
    if (op >= 0x40 && op < 0x48) { const i = op & 7; if (this.opsz32) this.r[i] = this.inc(this.r[i] >>> 0, 32); else this.setReg16(i, this.inc(this.reg16(i), 16)); return; }
    if (op >= 0x48 && op < 0x50) { const i = op & 7; if (this.opsz32) this.r[i] = this.dec(this.r[i] >>> 0, 32); else this.setReg16(i, this.dec(this.reg16(i), 16)); return; }
    if (op >= 0x50 && op < 0x58) { const i = op & 7; if (this.opsz32) this.push32(this.r[i]); else this.push16(i === 4 ? this.sp : this.reg16(i)); return; }
    if (op >= 0x58 && op < 0x60) { const i = op & 7; if (this.opsz32) this.r[i] = this.pop32(); else this.setReg16(i, this.pop16()); return; }
    if (op >= 0x70 && op < 0x80) { const d = this.fs8(); if (this.cond(op & 0xf)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x91 && op < 0x98) { const i = op & 7; if (this.opsz32) { const t = this.r[0]; this.r[0] = this.r[i]; this.r[i] = t; } else { const t = this.ax; this.ax = this.reg16(i); this.setReg16(i, t); } return; }
    if (op >= 0xb0 && op < 0xb8) { this.setReg8(op & 7, this.f8()); return; }
    if (op >= 0xb8 && op < 0xc0) { if (this.opsz32) this.r[op & 7] = this.f32(); else this.setReg16(op & 7, this.f16()); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.modrm(); this.fpu.exec(op, this.mod, this.regf, this.rm); return; }

    switch (op) {
      case 0x60: { // pusha
        if (this.opsz32) { const sp = this.r[4]; for (let i = 0; i < 8; i++) this.push32(i === 4 ? sp : this.r[i]); }
        else { const sp = this.sp; for (let i = 0; i < 8; i++) this.push16(i === 4 ? sp : this.reg16(i)); }
        return;
      }
      case 0x61: {
        if (this.opsz32) { for (let i = 7; i >= 0; i--) { const v = this.pop32(); if (i !== 4) this.r[i] = v; } }
        else { for (let i = 7; i >= 0; i--) { const v = this.pop16(); if (i !== 4) this.setReg16(i, v); } }
        return;
      }
      case 0x62: this.modrm(); return; // bound - ignore
      case 0x63: { // arpl
        this.modrm(); const d = this.rm16(), s = this.reg16(this.regf);
        if ((d & 3) < (s & 3)) { this.setRm16((d & ~3) | (s & 3)); this.flags |= ZF; } else this.flags &= ~ZF;
        return;
      }
      case 0x68: this.pushv(this.fv()); return;
      case 0x69: case 0x6b: {
        this.modrm(); const a = this.rmv(); const b = op === 0x69 ? this.fv() : this.fs8();
        this.imulTo(a, b, bv, (v) => this.setRegv(v)); return;
      }
      case 0x6a: { const v = this.fs8(); if (this.opsz32) this.push32(v); else this.push16(v & 0xffff); return; }
      case 0x80: case 0x82: { this.modrm(); const imm = this.f8(); const r = this.alu(this.regf, this.rm8(), imm, 8); if (this.regf !== 7) this.setRm8(r); return; }
      case 0x81: { this.modrm(); const imm = this.fv(); const r = this.alu(this.regf, this.rmv(), imm, bv); if (this.regf !== 7) this.setRmv(r); return; }
      case 0x83: { this.modrm(); let imm = this.fs8(); imm = this.opsz32 ? imm >>> 0 : imm & 0xffff; const r = this.alu(this.regf, this.rmv(), imm, bv); if (this.regf !== 7) this.setRmv(r); return; }
      case 0x84: { this.modrm(); this.alu(4, this.rm8(), this.reg8(this.regf), 8); return; }
      case 0x85: { this.modrm(); this.alu(4, this.rmv(), this.regv(), bv); return; }
      case 0x86: { this.modrm(); const a = this.rm8(); this.setRm8(this.reg8(this.regf)); this.setReg8(this.regf, a); return; }
      case 0x87: { this.modrm(); const a = this.rmv(); this.setRmv(this.regv()); this.setRegv(a); return; }
      case 0x88: this.modrm(); this.setRm8(this.reg8(this.regf)); return;
      case 0x89: this.modrm(); this.setRmv(this.regv()); return;
      case 0x8a: this.modrm(); this.setReg8(this.regf, this.rm8()); return;
      case 0x8b: this.modrm(); this.setRegv(this.rmv()); return;
      case 0x8c: this.modrm(); this.setRm16(this.s[this.regf]); return;
      case 0x8d: this.modrm(); this.setRegv(this.eaOff); return;
      case 0x8e: this.modrm(); this.loadSeg(this.regf, this.rm16()); return;
      case 0x8f: this.modrm(); this.setRmv(this.popv()); return; // note: ea computed before pop (minor deviation)
      case 0x90: return;
      case 0x98: if (this.opsz32) this.r[0] = (this.r[0] << 16) >> 16; else this.ax = (this.al << 24) >> 24; return;
      case 0x99: if (this.opsz32) this.r[2] = this.r[0] >> 31; else this.dx = (this.ax & 0x8000) ? 0xffff : 0; return;
      case 0x9a: { const off = this.fv(); const sel = this.f16(); this.farCall(sel, off); return; }
      case 0x9b: return; // fwait
      case 0x9c: if (this.opsz32) this.push32(this.flags); else this.push16(this.flags); return;
      case 0x9d: this.flags = ((this.opsz32 ? this.pop32() : this.pop16()) & 0x0fd5) | 0x2; return;
      case 0x9e: this.flags = (this.flags & ~0xd5) | (this.ah & 0xd5); return;
      case 0x9f: this.ah = (this.flags & 0xd5) | 2; return;
      case 0xa0: { const a = this.moff(); this.al = this.u8[a]; return; }
      case 0xa1: { const a = this.moff(); if (this.opsz32) this.r[0] = this.mem.r32(a); else this.ax = this.mem.r16(a); return; }
      case 0xa2: { const a = this.moff(); this.u8[a] = this.al; return; }
      case 0xa3: { const a = this.moff(); if (this.opsz32) this.mem.w32(a, this.r[0]); else this.mem.w16(a, this.ax); return; }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        this.strOp(op); return;
      case 0xa8: this.alu(4, this.al, this.f8(), 8); return;
      case 0xa9: this.alu(4, this.opsz32 ? this.r[0] >>> 0 : this.ax, this.fv(), bv); return;
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        this.modrm();
        const cnt = op <= 0xc1 ? this.f8() : op <= 0xd1 ? 1 : this.r[1] & 0xff;
        if (op & 1) this.setRmv(this.shift(this.regf, this.rmv(), cnt, bv));
        else this.setRm8(this.shift(this.regf, this.rm8(), cnt, 8));
        return;
      }
      case 0xc2: { const n = this.f16(); this.ip = this.opsz32 ? this.pop32() & 0xffff : this.pop16(); this.sp = this.sp + n; return; }
      case 0xc3: this.ip = this.opsz32 ? this.pop32() & 0xffff : this.pop16(); return;
      case 0xc4: case 0xc5: {
        this.modrm(); const a = this.ea();
        const off = this.opsz32 ? this.mem.r32(a) : this.mem.r16(a); const sel = this.mem.r16(a + (this.opsz32 ? 4 : 2));
        this.loadSeg(op === 0xc4 ? ES : DS, sel); this.setRegv(off); return;
      }
      case 0xc6: this.modrm(); this.setRm8(this.f8()); return;
      case 0xc7: this.modrm(); this.setRmv(this.fv()); return;
      case 0xc8: { // enter
        const sz = this.f16(); const lvl = this.f8() & 31;
        this.push16(this.bp); const fp = this.sp;
        if (lvl > 0) {
          let bp = this.bp;
          for (let i = 1; i < lvl; i++) { bp = (bp - 2) & 0xffff; this.push16(this.mem.r16(this.sb[SS] + bp)); }
          this.push16(fp);
        }
        this.bp = fp; this.sp = this.sp - sz; return;
      }
      case 0xc9: this.sp = this.bp; this.bp = this.pop16(); return;
      case 0xca: { const n = this.f16(); this.retfv(n); return; }
      case 0xcb: this.retfv(0); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.f8()); return;
      case 0xce: if (this.flags & OF) this.interrupt(4); return;
      case 0xcf: { const ip = this.pop16(); const cs = this.pop16(); this.flags = (this.pop16() & 0x0fd5) | 2; this.farJump(cs, ip); return; }
      case 0xd4: { const b = this.f8(); if (!b) throw new CPUFault(0, 'aam 0'); const al = this.al; this.ah = (al / b) | 0; this.al = al % b; this.setSZP(this.al, 8); return; }
      case 0xd5: { const b = this.f8(); this.al = (this.al + this.ah * b) & 0xff; this.ah = 0; this.setSZP(this.al, 8); return; }
      case 0xd6: this.al = (this.flags & CF) ? 0xff : 0; return;
      case 0xd7: { const seg = this.segOv >= 0 ? this.segOv : DS; this.al = this.u8[this.sb[seg] + ((this.bx + this.al) & 0xffff)]; return; }
      case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
        const d = this.fs8();
        if (op === 0xe3) { if ((this.adsz32 ? this.r[1] : this.cx) === 0) this.ip = (this.ip + d) & 0xffff; return; }
        let c: number;
        if (this.adsz32) { this.r[1] = this.r[1] - 1; c = this.r[1]; } else { this.cx = this.cx - 1; c = this.cx; }
        const z = (this.flags & ZF) !== 0;
        if (c !== 0 && (op === 0xe2 || (op === 0xe1 && z) || (op === 0xe0 && !z))) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe4: case 0xe5: this.f8(); this.al = 0xff; return;
      case 0xe6: case 0xe7: this.f8(); return;
      case 0xec: case 0xed: this.al = 0xff; return;
      case 0xee: case 0xef: return;
      case 0xe8: { const d = this.opsz32 ? this.f32() : this.f16(); this.pushv(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.opsz32 ? this.f32() : this.f16(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const off = this.fv(); const sel = this.f16(); this.farJump(sel, off); return; }
      case 0xeb: { const d = this.fs8(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xf4: this.halted = true; return;
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: this.grp3(op); return;
      case 0xf8: this.flags &= ~CF; return;
      case 0xf9: this.flags |= CF; return;
      case 0xfa: this.flags &= ~IF; return;
      case 0xfb: this.flags |= IF; return;
      case 0xfc: this.flags &= ~DF; return;
      case 0xfd: this.flags |= DF; return;
      case 0xfe: {
        this.modrm();
        if (this.regf === 0) this.setRm8(this.inc(this.rm8(), 8));
        else if (this.regf === 1) this.setRm8(this.dec(this.rm8(), 8));
        else this.bad(op);
        return;
      }
      case 0xff: this.grp5(); return;
    }
    this.bad(op);
  }

  private retfv(n: number) {
    if (this.opsz32) { const ip = this.pop32(); const cs = this.pop32() & 0xffff; this.sp = this.sp + n; this.farJump(cs, ip); }
    else this.retf(n);
  }
  private moff() {
    const off = this.adsz32 ? this.f32() : this.f16();
    const seg = this.segOv >= 0 ? this.segOv : DS;
    return this.sb[seg] + off;
  }
  bad(op: number): never {
    throw new CPUFault(6, `invalid opcode ${op.toString(16)} at ${this.s[CS].toString(16)}:${this.instIp.toString(16)}`);
  }

  interrupt(n: number) {
    if (this.onInt(n)) return;
    throw new CPUFault(n, `unhandled int ${n.toString(16)} at ${this.s[CS].toString(16)}:${this.instIp.toString(16)} ax=${this.ax.toString(16)}`);
  }

  private imulTo(a: number, b: number, bits: number, set: (v: number) => void) {
    let sa: number, sb: number;
    if (bits === 16) { sa = (a << 16) >> 16; sb = (b << 16) >> 16; const r = sa * sb; set(r & 0xffff); const ov = r !== ((r << 16) >> 16); this.flags = ov ? this.flags | CF | OF : this.flags & ~(CF | OF); }
    else { sa = a | 0; sb = b | 0; const r = BigInt(sa) * BigInt(sb); const lo = Number(BigInt.asIntN(32, r)); set(lo >>> 0); const ov = BigInt(lo) !== r; this.flags = ov ? this.flags | CF | OF : this.flags & ~(CF | OF); }
  }

  private grp3(op: number) {
    this.modrm();
    const w = op & 1; const bits = w ? (this.opsz32 ? 32 : 16) : 8;
    const v = w ? this.rmv() : this.rm8();
    switch (this.regf) {
      case 0: case 1: { const imm = w ? this.fv() : this.f8(); this.alu(4, v, imm, bits); return; }
      case 2: { const m = this.mask(bits); const r = bits === 32 ? (~v) >>> 0 : ~v & m; if (w) this.setRmv(r); else this.setRm8(r); return; }
      case 3: { const r = this.alu(5, 0, v, bits); if (w) this.setRmv(r); else this.setRm8(r); this.flags = v ? this.flags | CF : this.flags & ~CF; return; }
      case 4: { // mul
        if (bits === 8) { const r = this.al * v; this.ax = r; this.flags = (r & 0xff00) ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        else if (bits === 16) { const r = this.ax * v; this.ax = r & 0xffff; this.dx = r >>> 16; this.flags = (r >>> 16) ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        else { const r = BigInt(this.r[0] >>> 0) * BigInt(v >>> 0); this.r[0] = Number(r & 0xffffffffn); this.r[2] = Number(r >> 32n); this.flags = (r >> 32n) ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        return;
      }
      case 5: { // imul
        if (bits === 8) { const r = ((this.al << 24) >> 24) * ((v << 24) >> 24); this.ax = r & 0xffff; const ov = r !== ((r << 24) >> 24); this.flags = ov ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        else if (bits === 16) { const r = ((this.ax << 16) >> 16) * ((v << 16) >> 16); this.ax = r & 0xffff; this.dx = (r >> 16) & 0xffff; const ov = r !== ((r << 16) >> 16); this.flags = ov ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        else { const r = BigInt(this.r[0] | 0) * BigInt(v | 0); this.r[0] = Number(BigInt.asIntN(32, r)); this.r[2] = Number(BigInt.asIntN(32, r >> 32n)); const ov = BigInt(this.r[0]) !== r; this.flags = ov ? this.flags | CF | OF : this.flags & ~(CF | OF); }
        return;
      }
      case 6: { // div
        if (v === 0) return this.divFault();
        if (bits === 8) { const n = this.ax; const q = Math.floor(n / v); if (q > 0xff) return this.divFault(); this.al = q; this.ah = n % v; }
        else if (bits === 16) { const n = ((this.dx << 16) | this.ax) >>> 0; const q = Math.floor(n / v); if (q > 0xffff) return this.divFault(); this.ax = q; this.dx = n % v; }
        else { const n = (BigInt(this.r[2] >>> 0) << 32n) | BigInt(this.r[0] >>> 0); const q = n / BigInt(v >>> 0); if (q > 0xffffffffn) return this.divFault(); this.r[0] = Number(q); this.r[2] = Number(n % BigInt(v >>> 0)); }
        return;
      }
      case 7: { // idiv
        if (v === 0) return this.divFault();
        if (bits === 8) { const n = (this.ax << 16) >> 16; const d = (v << 24) >> 24; const q = Math.trunc(n / d); if (q > 127 || q < -128) return this.divFault(); this.al = q; this.ah = n - q * d; }
        else if (bits === 16) { const n = (this.dx << 16) | this.ax; const d = (v << 16) >> 16; const q = Math.trunc(n / d); if (q > 32767 || q < -32768) return this.divFault(); this.ax = q; this.dx = n - q * d; }
        else { const n = (BigInt(this.r[2] | 0) << 32n) | BigInt(this.r[0] >>> 0); const d = BigInt(v | 0); const q = n / d; if (q > 0x7fffffffn || q < -0x80000000n) return this.divFault(); this.r[0] = Number(BigInt.asIntN(32, q)); this.r[2] = Number(BigInt.asIntN(32, n - q * d)); }
        return;
      }
    }
  }
  private divFault() { this.ip = this.instIp; throw new CPUFault(0, `divide error at ${this.s[CS].toString(16)}:${this.instIp.toString(16)}`); }

  private grp5() {
    this.modrm();
    switch (this.regf) {
      case 0: this.setRmv(this.inc(this.rmv(), this.bitsV)); return;
      case 1: this.setRmv(this.dec(this.rmv(), this.bitsV)); return;
      case 2: { const t = this.rmv(); this.pushv(this.ip); this.ip = t & 0xffff; return; }
      case 3: { const a = this.ea(); const off = this.mem.r16(a); const sel = this.mem.r16(a + (this.opsz32 ? 4 : 2)); if (this.opsz32) { this.push32(this.s[CS]); this.push32(this.ip); this.farJump(sel, off); } else this.farCall(sel, off); return; }
      case 4: this.ip = this.rmv() & 0xffff; return;
      case 5: { const a = this.ea(); const off = this.mem.r16(a); const sel = this.mem.r16(a + (this.opsz32 ? 4 : 2)); this.farJump(sel, off); return; }
      case 6: this.pushv(this.rmv()); return;
    }
    this.bad(0xff);
  }

  private strOp(op: number) {
    const w = op & 1; const sz = w ? (this.opsz32 ? 4 : 2) : 1; const bits = sz * 8;
    const srcSeg = this.segOv >= 0 ? this.segOv : DS;
    const step = (this.flags & DF) ? -sz : sz;
    const a32 = this.adsz32;
    const getSI = () => a32 ? this.r[6] >>> 0 : this.si;
    const getDI = () => a32 ? this.r[7] >>> 0 : this.di;
    const addSI = () => { if (a32) this.r[6] += step; else this.si = this.si + step; };
    const addDI = () => { if (a32) this.r[7] += step; else this.di = this.di + step; };
    const rd = (a: number) => sz === 1 ? this.u8[a] : sz === 2 ? this.mem.r16(a) : this.mem.r32(a);
    const wr = (a: number, v: number) => { if (sz === 1) this.u8[a] = v; else if (sz === 2) this.mem.w16(a, v); else this.mem.w32(a, v); };
    const getCX = () => a32 ? this.r[1] >>> 0 : this.cx;
    const decCX = () => { if (a32) this.r[1]--; else this.cx = this.cx - 1; };
    const once = () => {
      switch (op & ~1) {
        case 0xa4: wr(this.sb[ES] + getDI(), rd(this.sb[srcSeg] + getSI())); addSI(); addDI(); return;
        case 0xa6: this.alu(7, rd(this.sb[srcSeg] + getSI()), rd(this.sb[ES] + getDI()), bits); addSI(); addDI(); return;
        case 0xaa: wr(this.sb[ES] + getDI(), sz === 1 ? this.al : sz === 2 ? this.ax : this.r[0]); addDI(); return;
        case 0xac: { const v = rd(this.sb[srcSeg] + getSI()); if (sz === 1) this.al = v; else if (sz === 2) this.ax = v; else this.r[0] = v; addSI(); return; }
        case 0xae: this.alu(7, sz === 1 ? this.al : sz === 2 ? this.ax : this.r[0] >>> 0, rd(this.sb[ES] + getDI()), bits); addDI(); return;
      }
    };
    if (!this.rep) { once(); return; }
    const cmp = (op & ~1) === 0xa6 || (op & ~1) === 0xae;
    // fast path for rep movsb/movsw forward, 16-bit addressing
    if (!cmp && (op & ~1) === 0xa4 && !a32 && step > 0) {
      let n = this.cx; if (!n) return;
      const si = this.si, di = this.di; const bytes = n * sz;
      if (si + bytes <= 0x10000 && di + bytes <= 0x10000) {
        const s = this.sb[srcSeg] + si, d = this.sb[ES] + di;
        if (d >= s + bytes || d + bytes <= s || d < s) { this.u8.copyWithin(d, s, s + bytes); }
        else { for (let i = 0; i < bytes; i++) this.u8[d + i] = this.u8[s + i]; }
        this.si = si + bytes; this.di = di + bytes; this.cx = 0; return;
      }
    }
    if (!cmp && (op & ~1) === 0xaa && !a32 && step > 0) {
      const n = this.cx; if (!n) return; const di = this.di; const bytes = n * sz;
      if (di + bytes <= 0x10000) {
        const d = this.sb[ES] + di;
        if (sz === 1) this.u8.fill(this.al, d, d + bytes);
        else for (let i = 0; i < n; i++) wr(d + i * sz, sz === 2 ? this.ax : this.r[0]);
        this.di = di + bytes; this.cx = 0; return;
      }
    }
    while (getCX() !== 0) {
      once(); decCX();
      if (cmp) { const z = (this.flags & ZF) !== 0; if (this.rep === 3 && !z) break; if (this.rep === 2 && z) break; }
    }
  }

  private exec0f() {
    const op = this.f8();
    const bv = this.opsz32 ? 32 : 16;
    if (op >= 0x80 && op < 0x90) { const d = this.opsz32 ? this.f32() : this.f16(); if (this.cond(op & 0xf)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x90 && op < 0xa0) { this.modrm(); this.setRm8(this.cond(op & 0xf) ? 1 : 0); return; }
    switch (op) {
      case 0x00: { // sldt/str/lldt/ltr/verr/verw
        this.modrm();
        if (this.regf === 4 || this.regf === 5) { const sel = this.rm16(); this.flags = this.mem.ldt[sel >> 3] && (sel & 0xfffc) ? this.flags | ZF : this.flags & ~ZF; return; }
        if (this.regf === 0) { this.setRm16(0); return; }
        this.bad(0x0f00);
      }
      case 0x02: { // lar
        this.modrm(); const sel = this.rm16(); const d = this.mem.ldt[sel >> 3];
        if (d && (sel & 0xfffc)) { this.setRegv(d.code ? 0xfa00 : 0xf200); this.flags |= ZF; } else this.flags &= ~ZF; return;
      }
      case 0x03: { // lsl
        this.modrm(); const sel = this.rm16(); const d = this.mem.ldt[sel >> 3];
        if (d && (sel & 0xfffc)) { this.setRegv(d.limit); this.flags |= ZF; } else this.flags &= ~ZF; return;
      }
      case 0x06: return; // clts
      case 0xa0: this.push16(this.s[FS]); return;
      case 0xa1: this.loadSeg(FS, this.pop16()); return;
      case 0xa8: this.push16(this.s[GS]); return;
      case 0xa9: this.loadSeg(GS, this.pop16()); return;
      case 0xa2: this.r[0] = 0; this.r[3] = 0; this.r[1] = 0; this.r[2] = 0; return; // cpuid
      case 0xa3: case 0xab: case 0xb3: case 0xbb: { // bt/bts/btr/btc r
        this.modrm(); const bit = this.regv();
        this.btOp(op === 0xa3 ? 0 : op === 0xab ? 1 : op === 0xb3 ? 2 : 3, bit, true); return;
      }
      case 0xba: { this.modrm(); const bit = this.f8(); if (this.regf < 4) this.bad(0x0fba); this.btOp(this.regf - 4, bit, false); return; }
      case 0xa4: case 0xa5: case 0xac: case 0xad: { // shld/shrd
        this.modrm(); const cnt = ((op & 1) ? this.r[1] : this.f8()) & 31; if (!cnt) return;
        const dst = this.rmv(), src = this.regv(); let r: number, cf: number;
        if (bv === 16) {
          if (op < 0xa8) { const v = ((dst << 16) | src) >>> 0; r = (v << cnt) >>> 16 & 0xffff; if (cnt > 16) r = ((src << (cnt - 16)) | (dst >>> (32 - cnt))) & 0xffff; cf = (dst >> (16 - cnt)) & 1; }
          else { const v = ((src << 16) | dst) >>> 0; r = (v >>> cnt) & 0xffff; cf = (dst >> (cnt - 1)) & 1; }
        } else {
          if (op < 0xa8) { r = ((dst << cnt) | (src >>> (32 - cnt))) >>> 0; cf = (dst >>> (32 - cnt)) & 1; }
          else { r = ((dst >>> cnt) | (src << (32 - cnt))) >>> 0; cf = (dst >>> (cnt - 1)) & 1; }
        }
        this.setRmv(r); this.setSZP(r, bv); this.flags = cf ? this.flags | CF : this.flags & ~CF; return;
      }
      case 0xaf: { this.modrm(); this.imulTo(this.regv(), this.rmv(), bv, (v) => this.setRegv(v)); return; }
      case 0xb2: case 0xb4: case 0xb5: {
        this.modrm(); const a = this.ea();
        const off = this.opsz32 ? this.mem.r32(a) : this.mem.r16(a); const sel = this.mem.r16(a + (this.opsz32 ? 4 : 2));
        this.loadSeg(op === 0xb2 ? SS : op === 0xb4 ? FS : GS, sel); this.setRegv(off); return;
      }
      case 0xb6: { this.modrm(); this.setRegv(this.rm8()); return; }
      case 0xb7: { this.modrm(); this.setRegv(this.rm16()); return; }
      case 0xbe: { this.modrm(); const v = (this.rm8() << 24) >> 24; this.setRegv(this.opsz32 ? v >>> 0 : v & 0xffff); return; }
      case 0xbf: { this.modrm(); const v = (this.rm16() << 16) >> 16; this.setRegv(this.opsz32 ? v >>> 0 : v & 0xffff); return; }
      case 0xbc: case 0xbd: {
        this.modrm(); const v = this.rmv(); if (!v) { this.flags |= ZF; return; } this.flags &= ~ZF;
        let i: number; if (op === 0xbc) { i = 0; while (!((v >>> i) & 1)) i++; } else { i = bv - 1; while (!((v >>> i) & 1)) i--; }
        this.setRegv(i); return;
      }
      case 0xff: { const id = this.f16(); this.onNative(id); return; } // native thunk
      case 0xfe: { this.depth--; this.halted = this.halted; return; } // callback return trap
    }
    this.bad(0x0f00 | op);
  }
  private btOp(kind: number, bit: number, regForm: boolean) {
    const bits = this.opsz32 ? 32 : 16;
    if (this.mod === 3 || !regForm) {
      const b = bit & (bits - 1); const v = this.rmv(); const cf = (v >>> b) & 1;
      this.flags = cf ? this.flags | CF : this.flags & ~CF;
      if (kind === 0) return;
      let r = kind === 1 ? v | (1 << b) : kind === 2 ? v & ~(1 << b) : v ^ (1 << b); if (bits === 32) r >>>= 0; else r &= 0xffff;
      this.setRmv(r); return;
    }
    // memory with register bit offset (signed)
    const sbit = bits === 16 ? (bit << 16) >> 16 : bit | 0;
    const byteOff = Math.floor(sbit / 8); const b = ((sbit % 8) + 8) % 8;
    const a = this.eaAt(byteOff);
    const v = this.u8[a]; const cf = (v >> b) & 1;
    this.flags = cf ? this.flags | CF : this.flags & ~CF;
    if (kind === 1) this.u8[a] = v | (1 << b); else if (kind === 2) this.u8[a] = v & ~(1 << b); else if (kind === 3) this.u8[a] = v ^ (1 << b);
  }

  // memory operand access for FPU
  fpuEA() { return this.ea(); }
}
