// Win16 machine: loader, native thunks, callbacks.
import { Memory } from '../core/memory';
import { CPU, CS, DS, ES, SS, CPUFault } from '../core/cpu';

export type ArgT = 'word' | 's_word' | 'long' | 'ptr' | 'segptr' | 'str' | 'segstr';
export type RetT = 'w' | 'l' | 'v' | 'reg';
export interface NativeDef { name: string; args: ArgT[]; ret: RetT; fn: (a: number[]) => any; bytes: number; cdecl?: boolean; }

export interface NEResource { type: number | string; id: number | string; off: number; len: number; data: Uint8Array; }
export interface NEModule {
  name: string; file: string; data: Uint8Array;
  segSels: number[]; autoDS: number; hInstance: number; hModule: number;
  entries: Map<number, { seg: number; off: number }>;
  exportsByName: Map<string, number>;
  resources: NEResource[];
  isNative?: boolean;
  nativeExports?: Map<number, number>; // ordinal -> far ptr
  nativeByName?: Map<string, number>;
  entryCS: number; entryIP: number; ss: number; sp: number; heap: number; stack: number;
}

const rd16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const rd32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export class ExitSignal extends Error { constructor() { super('program exited'); } }

export class Machine {
  faultHook: (e: CPUFault) => boolean = () => false;
  mem = new Memory();
  cpu = new CPU(this.mem);
  natives: NativeDef[] = [];
  thunkSel: number;
  thunkLin: number;
  private thunkNext = 0;
  modules = new Map<string, NEModule>();   // upper-case module name
  nativeModules = new Map<string, Map<number, NativeDef>>();
  log: (s: string) => void = (s) => console.log(s);
  verbose = false;
  unimpl = new Set<string>();
  callHistory: string[] = [];
  apiTrace = false;

  constructor() {
    const t = this.mem.allocBlock(0x10000, true);
    this.thunkSel = t.sel; this.thunkLin = t.base;
    // return trap at 0xFFF0
    this.mem.u8.set([0x0f, 0xfe], t.base + 0xfff0);
    this.cpu.onNative = (id) => this.dispatchNative(id);
  }

  // ---- native function registry ----
  defNative(mod: string, ord: number, name: string, args: ArgT[], ret: RetT, fn: (a: number[]) => any) {
    let m = this.nativeModules.get(mod);
    if (!m) { m = new Map(); this.nativeModules.set(mod, m); }
    let bytes = 0; for (const a of args) bytes += (a === 'word' || a === 's_word') ? 2 : 4;
    const d: NativeDef = { name, args, ret, fn, bytes };
    m.set(ord, d);
    return d;
  }
  private thunkFor = new Map<NativeDef, number>();
  thunkAddr(d: NativeDef): number {
    let fp = this.thunkFor.get(d);
    if (fp !== undefined) return fp;
    const id = this.natives.length; this.natives.push(d);
    const off = this.thunkNext; this.thunkNext += 4;
    this.mem.u8.set([0x0f, 0xff, id & 0xff, id >> 8], this.thunkLin + off);
    fp = ((this.thunkSel << 16) | off) >>> 0;
    this.thunkFor.set(d, fp);
    return fp;
  }
  // create an ad-hoc thunk for a native callable (e.g. default wndproc)
  makeNativeProc(name: string, args: ArgT[], ret: RetT, fn: (a: number[]) => any): number {
    let bytes = 0; for (const a of args) bytes += (a === 'word' || a === 's_word') ? 2 : 4;
    return this.thunkAddr({ name, args, ret, fn, bytes });
  }
  isNativeProc(fp: number) { return (fp >>> 16) === this.thunkSel; }
  nativeFromFp(fp: number): NativeDef | undefined {
    if ((fp >>> 16) !== this.thunkSel) return;
    const off = fp & 0xffff; const id = this.mem.r16(this.thunkLin + off + 2);
    return this.natives[id];
  }

  readArgs(d: NativeDef, base: number): number[] {
    // pascal: args pushed left to right; last arg lowest at SP+base
    const cpu = this.cpu; const vals = new Array(d.args.length);
    let off = base;
    for (let i = d.args.length - 1; i >= 0; i--) {
      const t = d.args[i];
      if (t === 'word') { vals[i] = cpu.stk16(off); off += 2; }
      else if (t === 's_word') { vals[i] = (cpu.stk16(off) << 16) >> 16; off += 2; }
      else { vals[i] = cpu.stk32(off); off += 4; }
    }
    return vals;
  }

  private dispatchNative(id: number) {
    const d = this.natives[id];
    const cpu = this.cpu;
    if (d.ret === 'reg') { d.fn([]); cpu.retf(0); return; }
    const args = this.readArgs(d, 4);
    if (this.apiTrace) this.log(`API ${d.name}(${args.map(a => a.toString(16)).join(',')})`);
    this.callHistory.push(d.name); if (this.callHistory.length > 64) this.callHistory.shift();
    const r = d.fn(args);
    if (d.ret === 'w') { cpu.ax = (r ?? 0) & 0xffff; }
    else if (d.ret === 'l') { const v = (r ?? 0) >>> 0; cpu.ax = v & 0xffff; cpu.dx = v >>> 16; }
    if (this.apiTrace && d.ret !== 'v') this.log(`  -> ${(r ?? 0).toString(16)}`);
    cpu.retf(d.bytes);
  }

  // ---- callbacks into emulated code ----
  // args are pushed in order given (pascal: first arg first). Each arg: [value, size(2|4)]
  callFar(fp: number, args: [number, number][], ds?: number): number {
    if (this.isNativeProc(fp)) {
      const d = this.nativeFromFp(fp)!;
      const vals: number[] = [];
      for (let i = 0; i < args.length; i++) {
        const t = d.args[i]; let v = args[i][0];
        if (t === 's_word') v = (v << 16) >> 16;
        vals.push(v);
      }
      const r = d.fn(vals);
      return (r ?? 0) >>> 0;
    }
    const cpu = this.cpu;
    const saveR = cpu.r.slice(); const saveS = cpu.s.slice(); const saveIp = cpu.ip; const saveF = cpu.flags;
    for (const [v, sz] of args) { if (sz === 4) { cpu.push16(v >>> 16); cpu.push16(v & 0xffff); } else cpu.push16(v & 0xffff); }
    cpu.push16(this.thunkSel); cpu.push16(0xfff0);
    const sel = fp >>> 16, off = fp & 0xffff;
    if (ds !== undefined) { cpu.loadSeg(DS, ds); cpu.ax = ds; }
    cpu.farJump(sel, off);
    const d0 = ++cpu.depth;
    while (cpu.depth >= d0) {
      if (cpu.halted) throw new ExitSignal();
      try { cpu.step(); }
      catch (e) { if (e instanceof CPUFault && this.faultHook(e)) continue; throw e; }
    }
    const ret = ((cpu.dx << 16) | cpu.ax) >>> 0;
    const espAfter = cpu.sp;
    cpu.r.set(saveR); cpu.ip = saveIp; cpu.flags = saveF;
    for (let i = 0; i < 6; i++) { try { cpu.loadSeg(i, saveS[i]); } catch { cpu.s[i] = 0; cpu.sb[i] = 0; } }
    void espAfter;
    return ret;
  }

  // ---- NE loader ----
  loadNE(data: Uint8Array, file: string): NEModule {
    const o = rd32(data, 0x3c);
    if (data[o] !== 0x4e || data[o + 1] !== 0x45) throw new Error('not NE');
    const h = (x: number) => rd16(data, o + x);
    const segCnt = h(0x1c), modCnt = h(0x1e);
    const segT = o + h(0x22), rsrcT = o + h(0x24), rnT = o + h(0x26), modT = o + h(0x28), impT = o + h(0x2a);
    const entT = o + h(0x04), entLen = h(0x06);
    const nrnT = rd32(data, o + 0x2c), nrnLen = h(0x20);
    const align = h(0x32);
    const autoDSnum = h(0x0e), heap = h(0x10), stack = h(0x12);
    const ip = h(0x14), csn = h(0x16), sp = h(0x18), ssn = h(0x1a);
    // name
    const nameLen = data[rnT]; const name = String.fromCharCode(...data.subarray(rnT + 1, rnT + 1 + nameLen)).toUpperCase();
    const modNames: string[] = [];
    for (let i = 0; i < modCnt; i++) { const off = rd16(data, modT + 2 * i); const l = data[impT + off]; modNames.push(String.fromCharCode(...data.subarray(impT + off + 1, impT + off + 1 + l)).toUpperCase()); }

    const segs: { off: number; len: number; flags: number; minalloc: number }[] = [];
    for (let i = 0; i < segCnt; i++) {
      const so = rd16(data, segT + 8 * i), sl = rd16(data, segT + 8 * i + 2), fl = rd16(data, segT + 8 * i + 4), ma = rd16(data, segT + 8 * i + 6);
      segs.push({ off: so << align, len: so ? (sl || 0x10000) : 0, flags: fl, minalloc: ma || 0x10000 });
    }
    const segSels: number[] = [];
    for (let i = 0; i < segCnt; i++) {
      const s = segs[i];
      let size = Math.max(s.len, s.minalloc);
      if (i + 1 === autoDSnum) size = Math.min(0x10000, size + heap + stack);
      if (i + 1 === autoDSnum && size < 0x10000) size = Math.min(0x10000, (size + 15) & ~15);
      const isCode = (s.flags & 1) === 0;
      const b = this.mem.allocBlock(size, isCode);
      if (s.len) {
        if (s.flags & 0x0008) { // iterated (RLE) segment
          let p = s.off, o = b.base; const end = s.off + s.len;
          while (p + 4 <= end) {
            const iters = rd16(data, p), nb = rd16(data, p + 2); p += 4;
            if (!iters && !nb) break;
            for (let k = 0; k < iters; k++) { this.mem.u8.set(data.subarray(p, p + nb), o); o += nb; }
            p += nb;
          }
        } else this.mem.u8.set(data.subarray(s.off, s.off + s.len), b.base);
      }
      segSels.push(b.sel);
    }
    const mod: NEModule = {
      name, file, data, segSels, autoDS: autoDSnum ? segSels[autoDSnum - 1] : 0,
      hInstance: 0, hModule: 0, entries: new Map(), exportsByName: new Map(), resources: [],
      entryCS: csn ? segSels[csn - 1] : 0, entryIP: ip, ss: ssn ? segSels[ssn - 1] : 0, sp, heap, stack,
    };
    mod.hInstance = mod.autoDS || segSels[0];
    mod.hModule = this.mem.allocBlock(16).sel; // pseudo module handle
    // entry table
    {
      let p = entT, ord = 1; const end = entT + entLen;
      while (p < end) {
        const cnt = data[p], seg = data[p + 1]; p += 2;
        if (cnt === 0) break;
        if (seg === 0) { ord += cnt; continue; }
        for (let i = 0; i < cnt; i++) {
          if (seg === 0xff) { const sn = data[p + 3], off = rd16(data, p + 4); mod.entries.set(ord, { seg: sn, off }); p += 6; }
          else { const off = rd16(data, p + 1); mod.entries.set(ord, { seg, off }); p += 3; }
          ord++;
        }
      }
    }
    const readNames = (p: number, end?: number) => {
      let first = true;
      while (true) {
        const l = data[p]; if (!l) break;
        const nm = String.fromCharCode(...data.subarray(p + 1, p + 1 + l)).toUpperCase(); const ordn = rd16(data, p + 1 + l);
        if (!first) mod.exportsByName.set(nm, ordn); first = false; p += 3 + l;
        if (end && p >= end) break;
      }
    };
    readNames(rnT); if (nrnT) readNames(nrnT, nrnT + nrnLen);
    // resources
    if (h(0x24) !== h(0x26)) {
      const shift = rd16(data, rsrcT); let p = rsrcT + 2;
      const rname = (off: number) => { const l = data[rsrcT + off]; return String.fromCharCode(...data.subarray(rsrcT + off + 1, rsrcT + off + 1 + l)).toUpperCase(); };
      for (;;) {
        const tid = rd16(data, p); if (!tid) break;
        const cnt = rd16(data, p + 2); p += 8;
        const type = tid & 0x8000 ? tid & 0x7fff : rname(tid);
        for (let i = 0; i < cnt; i++) {
          const off = rd16(data, p) << shift, len = rd16(data, p + 2) << shift, rid = rd16(data, p + 6);
          const id = rid & 0x8000 ? rid & 0x7fff : rname(rid);
          mod.resources.push({ type, id, off, len, data: data.subarray(off, off + len) });
          p += 12;
        }
      }
    }
    this.modules.set(name, mod);
    // relocations
    for (let i = 0; i < segCnt; i++) {
      const s = segs[i];
      if (!(s.flags & 0x100) || !s.len) continue;
      let p = s.off + s.len; const n = rd16(data, p); p += 2;
      const lin = this.mem.base(segSels[i]);
      for (let k = 0; k < n; k++, p += 8) {
        const st = data[p], fl = data[p + 1], off = rd16(data, p + 2), a = rd16(data, p + 4), b = rd16(data, p + 6);
        let sel = 0, ofs = 0; let isConst = false;
        switch (fl & 3) {
          case 0: // internal
            if (a === 0xff) { const e = mod.entries.get(b)!; sel = segSels[e.seg - 1]; ofs = e.off; }
            else { sel = segSels[a - 1]; ofs = b; }
            break;
          case 1: case 2: {
            const mname = modNames[a - 1];
            let fp: number | undefined;
            if ((fl & 3) === 1) fp = this.resolveImport(mname, b);
            else { const l = data[impT + b]; const fn = String.fromCharCode(...data.subarray(impT + b + 1, impT + b + 1 + l)); fp = this.resolveImportByName(mname, fn); }
            if (fp === undefined) { fp = 0; }
            if (fp < 0) { isConst = true; ofs = -fp - 1; sel = 0; }
            else { sel = fp >>> 16; ofs = fp & 0xffff; }
            break;
          }
          case 3: continue; // OS fixup (FPU) - ignore, real FPU opcodes are in image
        }
        const additive = (fl & 4) !== 0;
        const apply = (at: number) => {
          const A = lin + at;
          switch (st & 0xf) {
            case 0: this.mem.u8[A] = additive ? (this.mem.u8[A] + ofs) & 0xff : ofs & 0xff; break;
            case 2: this.mem.w16(A, additive ? this.mem.r16(A) + sel : sel); break;
            case 3: this.mem.w16(A, additive ? this.mem.r16(A) + ofs : ofs); this.mem.w16(A + 2, sel); break;
            case 5: this.mem.w16(A, additive ? this.mem.r16(A) + ofs : ofs); break;
            default: this.log(`unsupported reloc src type ${st}`);
          }
        };
        if (isConst && (st & 0xf) === 2) { /* selector of constant: use value */ }
        if (additive) apply(off);
        else {
          let at = off; let guard = 0;
          while (guard++ < 0x10000) { const next = this.mem.r16(lin + at); apply(at); if ((st & 0xf) === 0 || next === 0xffff || next === 0 || next >= 0x10000) break; at = next; }
        }
      }
    }
    return mod;
  }

  // returns far pointer, or negative encoded constant (-(v+1))
  resolveImport(mod: string, ord: number): number | undefined {
    const nm = this.nativeModules.get(mod);
    if (nm) {
      let d = nm.get(ord);
      if (!d) {
        const key = `${mod}.${ord}`;
        d = this.defNative(mod, ord, key, [], 'w', () => { throw new Error(`unimplemented API ${key}`); });
      }
      if ((d as any).constValue !== undefined) return -((d as any).constValue) - 1;
      return this.thunkAddr(d);
    }
    const m = this.modules.get(mod);
    if (m) { const e = m.entries.get(ord); if (e) return ((m.segSels[e.seg - 1] << 16) | e.off) >>> 0; }
    this.log(`unresolved import ${mod}.${ord}`);
    return undefined;
  }
  resolveImportByName(mod: string, name: string): number | undefined {
    const m = this.modules.get(mod);
    if (m) { const o = m.exportsByName.get(name.toUpperCase()); if (o) return this.resolveImport(mod, o); }
    const nm = this.nativeModules.get(mod);
    if (nm) for (const [o, d] of nm) if (d.name.toUpperCase() === name.toUpperCase()) return this.thunkAddr(d);
    this.log(`unresolved import ${mod}.${name}`);
    return undefined;
  }
  defConst(mod: string, ord: number, name: string, v: number) {
    const d = this.defNative(mod, ord, name, [], 'w', () => v); (d as any).constValue = v;
  }

  // helpers
  str(fp: number) { return fp ? this.mem.readCStrFar(fp) : ''; }
  lin(fp: number) { return this.mem.linFar(fp); }
  r16(fp: number, o = 0) { return this.mem.r16(this.lin(fp) + o); }
  w16(fp: number, o: number, v: number) { this.mem.w16(this.lin(fp) + o, v); }
  r32(fp: number, o = 0) { return this.mem.r32(this.lin(fp) + o); }
  w32(fp: number, o: number, v: number) { this.mem.w32(this.lin(fp) + o, v); }
  allocData(size: number): number { const b = this.mem.allocBlock(size); return (b.sel << 16) >>> 0; }
}

export { CPUFault, CS, DS, ES, SS };
