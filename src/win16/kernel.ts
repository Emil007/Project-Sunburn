// KERNEL, DOS (INT 21h), DPMI, TOOLHELP, WIN87EM, KEYBOARD
import type { Win16 } from './win16';
import { CS, DS, ES, SS, CF, ZF } from '../core/cpu';
import { wildcardMatch } from './vfs';

interface FileHandle { path: string; data: Uint8Array; size: number; pos: number; write: boolean; dirty: boolean; }

export function installKernel(w: Win16) {
  const m = w.m, mem = m.mem, cpu = m.cpu;
  const K = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('KERNEL', o, n, a, r, f);

  // ---------- global memory ----------
  const gsize = new Map<number, number>();  // handle -> size
  const gcount = new Map<number, number>(); // handle -> selector count
  const galloc = (flags: number, size: number) => {
    size = size >>> 0;
    const b = mem.allocBlock(Math.max(size, 1), false);
    gsize.set(b.sel, size); gcount.set(b.sel, b.count);
    return b.sel;
  };
  w.galloc = galloc;
  const gfree = (h: number) => {
    const sel = h | 7; if (w.traceFree) w.log(`GlobalFree ${sel.toString(16)}`); const sz = gsize.get(sel); if (sz === undefined) return h;
    const n = gcount.get(sel) || 1; const base = mem.base(sel);
    for (let i = 0; i < n; i++) mem.freeSelector(sel + i * 8);
    mem.freeLinearBlock(base, Math.max(sz, 1));
    gsize.delete(sel); gcount.delete(sel); return 0;
  };
  const grealloc = (h: number, size: number, flags: number) => {
    const sel = h | 7; const old = gsize.get(sel); if (old === undefined) return 0;
    if (flags & 0x80) return sel; // GMEM_MODIFY
    size = size >>> 0;
    const oldCount = gcount.get(sel) || 1; const newCount = Math.max(1, Math.ceil(size / 0x10000));
    const oldBase = mem.base(sel);
    const newBase = mem.allocLinear(Math.max(size, 1));
    mem.u8.copyWithin(newBase, oldBase, oldBase + Math.min(old, size));
    if (flags & 0x40 && size > old) mem.u8.fill(0, newBase + old, newBase + size);
    mem.freeLinearBlock(oldBase, Math.max(old, 1));
    let nsel = sel;
    if (newCount > oldCount) {
      // need new consecutive selectors
      for (let i = 0; i < oldCount; i++) mem.freeSelector(sel + i * 8);
      nsel = mem.allocSelectors(newCount);
    } else for (let i = newCount; i < oldCount; i++) mem.freeSelector(sel + i * 8);
    for (let i = 0; i < newCount; i++) {
      const rem = size - i * 0x10000;
      mem.setDesc(nsel + i * 8, { base: newBase + i * 0x10000, limit: Math.max(0, Math.min(rem, 0x10000) - 1), code: false, present: true });
    }
    if (nsel !== sel) w.log(`GlobalReAlloc moved ${sel.toString(16)} -> ${nsel.toString(16)} (${old} -> ${size})`);
    gsize.delete(sel); gcount.delete(sel); gsize.set(nsel, size); gcount.set(nsel, newCount);
    cpu.refreshSegs();
    return nsel;
  };
  K(15, 'GlobalAlloc', ['word', 'long'], 'w', ([f, s]) => galloc(f, s));
  K(16, 'GlobalReAlloc', ['word', 'long', 'word'], 'w', ([h, s, f]) => grealloc(h, s, f));
  K(17, 'GlobalFree', ['word'], 'w', ([h]) => gfree(h));
  K(18, 'GlobalLock', ['word'], 'l', ([h]) => (h && mem.getDesc(h | 7)) ? ((h | 7) << 16) >>> 0 : 0);
  K(19, 'GlobalUnlock', ['word'], 'w', () => 0);
  K(20, 'GlobalSize', ['word'], 'l', ([h]) => gsize.get(h | 7) ?? (mem.getDesc(h | 7) ? mem.getDesc(h | 7)!.limit + 1 : 0));
  K(21, 'GlobalHandle', ['word'], 'l', ([s]) => mem.getDesc(s | 7) ? (((s | 7) << 16) | (s | 7)) >>> 0 : 0);
  K(25, 'GlobalCompact', ['long'], 'l', () => 0x1000000);
  K(169, 'GetFreeSpace', ['word'], 'l', () => 0x1000000);
  K(170, 'AllocCStoDSAlias', ['word'], 'w', ([s]) => { const d = mem.getDesc(s); if (!d) return 0; const n = mem.allocSelectors(1); mem.setDesc(n, { ...d, code: false }); return n; });
  K(171, 'AllocDStoCSAlias', ['word'], 'w', ([s]) => { const d = mem.getDesc(s); if (!d) return 0; const n = mem.allocSelectors(1); mem.setDesc(n, { ...d, code: true }); return n; });
  K(175, 'AllocSelector', ['word'], 'w', ([s]) => { const n = mem.allocSelectors(1); const d = mem.getDesc(s); mem.setDesc(n, d ? { ...d } : { base: 0, limit: 0, code: false, present: true }); return n; });
  K(176, 'FreeSelector', ['word'], 'w', ([s]) => { mem.freeSelector(s); return 0; });
  K(177, 'PrestoChangoSelector', ['word', 'word'], 'w', ([src, dst]) => { const d = mem.getDesc(src); if (d) mem.setDesc(dst, { ...d, code: !d.code }); cpu.refreshSegs(); return dst; });
  K(186, 'GetSelectorBase', ['word'], 'l', ([s]) => mem.getDesc(s)?.base ?? 0);
  K(187, 'SetSelectorBase', ['word', 'long'], 'w', ([s, b]) => { const d = mem.getDesc(s); if (d) d.base = b; cpu.refreshSegs(); return s; });
  K(188, 'GetSelectorLimit', ['word'], 'l', ([s]) => mem.getDesc(s)?.limit ?? 0);
  K(189, 'SetSelectorLimit', ['word', 'long'], 'w', ([s, l]) => { const d = mem.getDesc(s); if (d) d.limit = l; return 0; });
  K(348, 'hmemcpy', ['ptr', 'ptr', 'long'], 'v', ([dst, src, n]) => { hcopy(dst, src, n); });
  const hlin = (fp: number, add: number) => {
    // huge pointer arithmetic: selector advances by 8 per 64K
    const sel = fp >>> 16, off = fp & 0xffff; const t = off + add;
    return mem.lin(sel + ((t >>> 16) << 3), t & 0xffff);
  };
  w.hlin = hlin;
  const hcopy = (dst: number, src: number, n: number) => {
    // allocations are linear-contiguous, so a plain copy works
    if (n <= 0) return;
    const s = hlin(src, 0), d = hlin(dst, 0);
    mem.u8.copyWithin(d, s, s + n);
  };
  K(335, 'IsBadWritePtr', ['segptr', 'word'], 'w', ([p]) => (p >>> 16) && mem.getDesc(p >>> 16) ? 0 : 1);
  K(334, 'IsBadReadPtr', ['segptr', 'word'], 'w', ([p]) => (p >>> 16) && mem.getDesc(p >>> 16) ? 0 : 1);
  K(336, 'IsBadCodePtr', ['segptr'], 'w', ([p]) => (p >>> 16) && mem.getDesc(p >>> 16) ? 0 : 1);
  K(346, 'IsBadHugeReadPtr', ['segptr', 'long'], 'w', ([p]) => (p >>> 16) && mem.getDesc(p >>> 16) ? 0 : 1);
  K(347, 'IsBadHugeWritePtr', ['segptr', 'long'], 'w', ([p]) => (p >>> 16) && mem.getDesc(p >>> 16) ? 0 : 1);
  m.defConst('KERNEL', 113, '__AHSHIFT', 3);
  m.defConst('KERNEL', 114, '__AHINCR', 8);
  m.defConst('KERNEL', 178, '__WINFLAGS', 0x0429);

  // ---------- task / module ----------
  K(3, 'GetVersion', [], 'l', () => 0x06160a03);
  K(132, 'GetWinFlags', [], 'l', () => 0x0429);
  K(107, 'SetErrorMode', ['word'], 'w', () => 0);
  K(199, 'SetHandleCount', ['word'], 'w', ([n]) => n);
  K(30, 'WaitEvent', ['word'], 'w', () => 0);
  K(36, 'GetCurrentTask', [], 'l', () => w.hTask);
  K(47, 'GetModuleHandle', ['segstr'], 'l', ([p]) => {
    let name: string;
    if ((p >>> 16) === 0) { const h = p & 0xffff; for (const mm of m.modules.values()) if (mm.hInstance === h || mm.hModule === h) return mm.hModule; return 0; }
    name = m.str(p).toUpperCase().replace(/\.(EXE|DLL|DRV)$/, '').replace(/^.*\\/, '');
    const mm = m.modules.get(name); if (mm) return mm.hModule;
    if (m.nativeModules.has(name)) return w.nativeModHandle(name);
    return 0;
  });
  K(48, 'GetModuleUsage', ['word'], 'w', () => 1);
  K(49, 'GetModuleFileName', ['word', 'ptr', 's_word'], 'w', ([h, buf, n]) => {
    let f = 'C:\\HOLIDAY\\HOLIDAY.EXE';
    for (const mm of m.modules.values()) if (mm.hInstance === h || mm.hModule === h) f = mm.file;
    return mem.writeCStr(buf >>> 16, buf & 0xffff, f, n);
  });
  K(50, 'GetProcAddress', ['word', 'str'], 'l', ([h, p]) => {
    for (const mm of m.modules.values()) if (mm.hModule === h || mm.hInstance === h) {
      const ord = (p >>> 16) === 0 ? p & 0xffff : mm.exportsByName.get(m.str(p).toUpperCase());
      if (!ord) return 0; const e = mm.entries.get(ord); return e ? ((mm.segSels[e.seg - 1] << 16) | e.off) >>> 0 : 0;
    }
    const nm = w.nativeModByHandle(h);
    if (nm) {
      const ord = (p >>> 16) === 0 ? p & 0xffff : undefined;
      if (ord !== undefined) return m.resolveImport(nm, ord) ?? 0;
      return m.resolveImportByName(nm, m.str(p)) ?? 0;
    }
    return 0;
  });
  K(51, 'MakeProcInstance', ['segptr', 'word'], 'l', ([p]) => p);
  K(52, 'FreeProcInstance', ['segptr'], 'v', () => {});
  K(95, 'LoadLibrary', ['str'], 'w', ([p]) => {
    const n = m.str(p).toUpperCase().replace(/^.*\\/, '').replace(/\.(EXE|DLL|DRV)$/, '');
    w.log(`LoadLibrary(${m.str(p)})`);
    if (m.nativeModules.has(n) && w.loadableNative.has(n)) return w.nativeModHandle(n);
    return 2;
  });
  K(96, 'FreeLibrary', ['word'], 'v', () => {});
  K(91, 'InitTask', [], 'reg', () => {
    const mod = w.mainModule;
    cpu.ax = 1; cpu.bx = 0x81; cpu.cx = mod.stack; cpu.di = mod.hInstance; cpu.si = 0; cpu.dx = 1; // SW_SHOWNORMAL
    cpu.loadSeg(ES, w.pspSel);
    // instance data stack pointers at DS:0x0A..0x0E
    const ds = mem.base(mod.autoDS);
    const top = cpu.sp; mem.w16(ds + 0x0a, top - mod.stack + 0x100); mem.w16(ds + 0x0c, top - mod.stack + 0x100); mem.w16(ds + 0x0e, top);
  });
  K(102, 'DOS3Call', [], 'reg', () => { dos(); });

  // ---------- resources ----------
  const resHandles: any[] = [null];
  w.findResource = (hInst: number, name: number, type: number) => {
    const mod = w.mainModule;
    const key = (p: number) => (p >>> 16) === 0 ? (p & 0xffff) : (() => { const s = m.str(p).toUpperCase(); return s.startsWith('#') ? parseInt(s.slice(1)) : s; })();
    const k = key(name), t = key(type);
    const r = mod.resources.find(r => r.type === t && r.id === k);
    if (!r) return 0;
    let idx = resHandles.indexOf(r); if (idx < 0) { resHandles.push(r); idx = resHandles.length - 1; }
    return idx;
  };
  w.resData = (h: number) => resHandles[h]?.data;
  K(60, 'FindResource', ['word', 'str', 'str'], 'w', ([h, n, t]) => w.findResource(h, n, t));
  const loadedRes = new Map<number, number>();
  const loadRes = (h: number) => {
    const r = resHandles[h]; if (!r) return 0;
    let g = loadedRes.get(h); if (g) return g;
    g = galloc(0, r.data.length); mem.u8.set(r.data, mem.base(g)); loadedRes.set(h, g); return g;
  };
  K(61, 'LoadResource', ['word', 'word'], 'w', ([, h]) => loadRes(h));
  K(62, 'LockResource', ['word'], 'l', ([h]) => h ? ((h | 7) << 16) >>> 0 : 0);
  K(63, 'FreeResource', ['word'], 'w', () => 0);
  K(65, 'SizeofResource', ['word', 'word'], 'l', ([, h]) => resHandles[h]?.data.length ?? 0);
  K(64, 'AccessResource', ['word', 'word'], 'w', ([, h]) => {
    const r = resHandles[h]; if (!r) return 0xffff;
    // serve the (possibly mod-patched) resource bytes as their own file
    return openHandle(w.mainModule.file + '#res', r.data, false);
  });

  // ---------- profile (win.ini) ----------
  K(57, 'GetProfileInt', ['str', 'str', 's_word'], 'w', ([a, k, d]) => { const v = w.ini.get(m.str(a).toUpperCase())?.get(m.str(k).toUpperCase()); return v !== undefined ? (parseInt(v) || 0) : d; });
  K(58, 'GetProfileString', ['str', 'str', 'str', 'ptr', 'word'], 'w', ([a, k, d, buf, n]) => {
    const sec = w.ini.get(m.str(a).toUpperCase());
    let v: string;
    if (!k) v = sec ? [...sec.keys()].join('\0') + '\0' : '';
    else v = sec?.get(m.str(k).toUpperCase()) ?? m.str(d);
    const s = v.slice(0, n - 1); const lin = m.lin(buf); for (let i = 0; i < s.length; i++) mem.u8[lin + i] = s.charCodeAt(i); mem.u8[lin + s.length] = 0; return s.length;
  });
  K(59, 'WriteProfileString', ['str', 'str', 'str'], 'w', ([a, k, v]) => { const s = m.str(a).toUpperCase(); if (!w.ini.has(s)) w.ini.set(s, new Map()); w.ini.get(s)!.set(m.str(k).toUpperCase(), m.str(v)); return 1; });

  // ---------- files ----------
  const files: (FileHandle | null)[] = [null, null, null, null, null];
  const openHandle = (path: string, data: Uint8Array, write: boolean) => {
    let i = 5; while (files[i]) i++;
    files[i] = { path, data, size: data.length, pos: 0, write, dirty: false };
    return i;
  };
  const doOpen = (name: string, mode: number): number => {
    const data = w.vfs.read(name);
    if (!data) { if (w.traceFiles) w.log(`open FAIL ${name}`); return -2; }
    if (w.traceFiles) w.log(`open ${name} (${data.length})`);
    const acc = mode & 3;
    return openHandle(w.vfs.full(name), acc ? data.slice() : data, acc !== 0);
  };
  const doCreate = (name: string): number => {
    const full = w.vfs.full(name);
    if (!w.vfs.write(full, new Uint8Array(0))) { if (w.traceFiles) w.log(`create FAIL ${name}`); return -5; }
    if (w.traceFiles) w.log(`create ${full}`);
    return openHandle(full, new Uint8Array(0), true);
  };
  const ensure = (f: FileHandle, need: number) => {
    if (need <= f.data.length) return;
    const n = new Uint8Array(Math.max(need, f.data.length * 2, 256)); n.set(f.data.subarray(0, f.size)); f.data = n;
  };
  const doRead = (h: number, lin: number, n: number) => {
    const f = files[h]; if (!f) return -6;
    const c = Math.max(0, Math.min(n, f.size - f.pos));
    mem.u8.set(f.data.subarray(f.pos, f.pos + c), lin); f.pos += c; return c;
  };
  const doWrite = (h: number, lin: number, n: number) => {
    const f = files[h]; if (!f) return -6;
    if (h === 1 || h === 2) { w.log('stdout: ' + String.fromCharCode(...mem.u8.subarray(lin, lin + n))); return n; }
    if (n === 0) { f.size = f.pos; f.dirty = true; return 0; } // truncate
    ensure(f, f.pos + n); f.data.set(mem.u8.subarray(lin, lin + n), f.pos); f.pos += n; if (f.pos > f.size) f.size = f.pos; f.dirty = true; return n;
  };
  const doClose = (h: number) => {
    const f = files[h]; if (!f) return -6;
    if (f.dirty) w.vfs.write(f.path, f.data.slice(0, f.size));
    files[h] = null; return 0;
  };
  const doSeek = (h: number, off: number, how: number) => {
    const f = files[h]; if (!f) return -6;
    let p = how === 0 ? off : how === 1 ? f.pos + (off | 0) : f.size + (off | 0);
    if (p < 0) p = 0; f.pos = p; return p;
  };
  w.fileApi = { doOpen, doCreate, doRead, doWrite, doClose, doSeek };
  K(81, '_lclose', ['word'], 'w', ([h]) => doClose(h) < 0 ? 0xffff : 0);
  K(82, '_lread', ['word', 'segptr', 'word'], 'w', ([h, p, n]) => { const r = doRead(h, m.lin(p), n); return r < 0 ? 0xffff : r; });
  K(83, '_lcreat', ['str', 'word'], 'w', ([p]) => { const r = doCreate(m.str(p)); return r < 0 ? 0xffff : r; });
  K(84, '_llseek', ['word', 'long', 'word'], 'l', ([h, o, how]) => { const r = doSeek(h, o, how); return r < 0 ? 0xffffffff : r; });
  K(85, '_lopen', ['str', 'word'], 'w', ([p, mo]) => { const r = doOpen(m.str(p), mo); return r < 0 ? 0xffff : r; });
  K(86, '_lwrite', ['word', 'ptr', 'word'], 'w', ([h, p, n]) => { const r = doWrite(h, m.lin(p), n); return r < 0 ? 0xffff : r; });
  K(349, '_hread', ['word', 'segptr', 'long'], 'l', ([h, p, n]) => { const r = doRead(h, hlin(p, 0), n); return r < 0 ? 0xffffffff : r; });
  K(350, '_hwrite', ['word', 'ptr', 'long'], 'l', ([h, p, n]) => { const r = doWrite(h, hlin(p, 0), n); return r < 0 ? 0xffffffff : r; });
  K(92, 'GetTempDrive', ['word'], 'w', () => 0x43);
  K(134, 'GetWindowsDirectory', ['ptr', 'word'], 'w', ([p, n]) => mem.writeCStr(p >>> 16, p & 0xffff, 'C:\\WINDOWS', n));
  K(135, 'GetSystemDirectory', ['ptr', 'word'], 'w', ([p, n]) => mem.writeCStr(p >>> 16, p & 0xffff, 'C:\\WINDOWS\\SYSTEM', n));
  K(136, 'GetDriveType', ['s_word'], 'w', ([d]) => { const l = String.fromCharCode(65 + d); if (!w.vfs.drives.has(l)) return 0; return w.vfs.fs(l)!.readonly ? 4 : 3; });

  // ---------- DOS INT 21h ----------
  let dta = 0; // far ptr
  const findState = new Map<number, { list: { name: string; dir: boolean; size: number }[]; idx: number; attr: number }>();
  let findSeq = 1;
  const setCF = (on: boolean) => { cpu.flags = on ? cpu.flags | CF : cpu.flags & ~CF; };
  const err = (code: number) => { cpu.ax = code; setCF(true); };
  const dsdx = () => mem.readCStr(cpu.ds, cpu.dx);
  const writeFind = (st: { list: { name: string; dir: boolean; size: number }[]; idx: number; attr: number }, id: number): boolean => {
    while (st.idx < st.list.length) {
      const e = st.list[st.idx++];
      if (e.dir && !(st.attr & 0x10)) continue;
      const a = m.lin(dta);
      mem.u8.fill(0, a, a + 43);
      mem.w16(a, id);
      mem.u8[a + 0x15] = e.dir ? 0x10 : 0x20;
      mem.w16(a + 0x16, 0x6000); mem.w16(a + 0x18, ((1997 - 1980) << 9) | (1 << 5) | 1);
      mem.w32(a + 0x1a, e.size);
      const nm = e.name.slice(0, 12); for (let i = 0; i < nm.length; i++) mem.u8[a + 0x1e + i] = nm.charCodeAt(i);
      return true;
    }
    return false;
  };
  const dos = () => {
    const ah = cpu.ah;
    if (w.traceDos) w.log(`INT21 ${[0x3c,0x3d,0x43,0x4e,0x41,0x39,0x3b,0x56].includes(ah) ? JSON.stringify(dsdx()) : ''} ah=${ah.toString(16)} al=${cpu.al.toString(16)} bx=${cpu.bx.toString(16)} cx=${cpu.cx.toString(16)} dx=${cpu.dx.toString(16)}`);
    setCF(false);
    switch (ah) {
      case 0x0e: { const d = String.fromCharCode(65 + cpu.dl); if (w.vfs.drives.has(d)) w.vfs.curDrive = d; cpu.al = 26; return; }
      case 0x19: cpu.al = w.vfs.curDrive.charCodeAt(0) - 65; return;
      case 0x1a: dta = ((cpu.ds << 16) | cpu.dx) >>> 0; return;
      case 0x2f: cpu.loadSeg(ES, dta >>> 16); cpu.bx = dta & 0xffff; return;
      case 0x25: return;
      case 0x35: cpu.loadSeg(ES, 0); cpu.bx = 0; return;
      case 0x2a: { const d = new Date(); cpu.cx = d.getFullYear(); cpu.dx = ((d.getMonth() + 1) << 8) | d.getDate(); cpu.al = d.getDay(); return; }
      case 0x2c: { const d = new Date(); cpu.cx = (d.getHours() << 8) | d.getMinutes(); cpu.dx = (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10); return; }
      case 0x30: cpu.ax = 0x1606; cpu.bx = 0; cpu.cx = 0; return;
      case 0x33: cpu.dx = cpu.dx & 0xff00; return;
      case 0x36: { cpu.ax = 64; cpu.bx = 0x8000; cpu.cx = 512; cpu.dx = 0xffff; return; }
      case 0x39: { const [d, r] = w.vfs.resolve(dsdx()); w.vfs.fs(d)?.mkdir?.(r); return; }
      case 0x3a: return;
      case 0x3b: { const p = dsdx(); if (!w.vfs.isDir(p)) return err(3); const [d, r] = w.vfs.resolve(p); w.vfs.curDir.set(d, r); return; }
      case 0x3c: { const r = doCreate(dsdx()); if (r < 0) return err(-r); cpu.ax = r; return; }
      case 0x3d: { const r = doOpen(dsdx(), cpu.al); if (r < 0) return err(-r); cpu.ax = r; return; }
      case 0x3e: { const r = doClose(cpu.bx); if (r < 0) return err(6); return; }
      case 0x3f: { const r = doRead(cpu.bx, mem.lin(cpu.ds, cpu.dx), cpu.cx); if (r < 0) return err(6); cpu.ax = r; return; }
      case 0x40: { const r = doWrite(cpu.bx, mem.lin(cpu.ds, cpu.dx), cpu.cx); if (r < 0) return err(6); cpu.ax = r; return; }
      case 0x41: { const [d, r] = w.vfs.resolve(dsdx()); const f = w.vfs.fs(d); if (!f?.remove || !f.remove(r)) return err(2); return; }
      case 0x42: { const r = doSeek(cpu.bx, ((cpu.cx << 16) | cpu.dx) >>> 0, cpu.al); if (r < 0) return err(6); cpu.ax = r & 0xffff; cpu.dx = r >>> 16; return; }
      case 0x43: { const p = dsdx(); if (!w.vfs.exists(p)) return err(2); cpu.cx = w.vfs.isDir(p) ? 0x10 : 0x20; return; }
      case 0x44: { // ioctl
        if (cpu.al === 0) { cpu.dx = cpu.bx < 3 ? 0x80d3 : 0x0002; return; }
        if (cpu.al === 8) { cpu.ax = 1; return; }
        if (cpu.al === 9) { cpu.dx = 0; return; }
        cpu.ax = 0; return;
      }
      case 0x45: { const f = files[cpu.bx]; if (!f) return err(6); const n = openHandle(f.path, f.data, f.write); files[n]!.pos = f.pos; files[n]!.size = f.size; cpu.ax = n; return; }
      case 0x47: { const d = cpu.dl ? String.fromCharCode(64 + cpu.dl) : w.vfs.curDrive; mem.writeCStr(cpu.ds, cpu.si, w.vfs.curDir.get(d) || ''); return; }
      case 0x4c: w.exit(cpu.al); return;
      case 0x4e: {
        const p = dsdx(); const [d, r] = w.vfs.resolve(p);
        const i = r.lastIndexOf('\\'); const dir = i < 0 ? '' : r.slice(0, i); const pat = i < 0 ? r : r.slice(i + 1);
        const fs = w.vfs.fs(d); const list = (fs?.list(dir) || []).filter(e => wildcardMatch(pat, e.name));
        const id = findSeq++; const st = { list, idx: 0, attr: cpu.cx }; findState.set(id, st);
        if (!writeFind(st, id)) return err(18);
        return;
      }
      case 0x4f: { const a = m.lin(dta); const id = mem.r16(a); const st = findState.get(id); if (!st || !writeFind(st, id)) return err(18); return; }
      case 0x56: { const a = dsdx(); const b = mem.readCStr(cpu.es, cpu.di); const data = w.vfs.read(a); if (!data) return err(2); w.vfs.write(b, data); const [d, r] = w.vfs.resolve(a); w.vfs.fs(d)?.remove?.(r); return; }
      case 0x57: if (cpu.al === 0) { cpu.cx = 0x6000; cpu.dx = ((1997 - 1980) << 9) | (1 << 5) | 1; } return;
      case 0x59: cpu.ax = 2; cpu.bx = 0x0102; cpu.cx = 0; return;
      case 0x60: { const p = mem.readCStr(cpu.ds, cpu.si); mem.writeCStr(cpu.es, cpu.di, w.vfs.full(p)); return; }
      case 0x62: cpu.bx = w.pspSel; return;
      case 0x71: return err(0x7100);
      case 0x0d: return;
      case 0x2e: return;
      case 0x58: cpu.ax = 0; return;
    }
    w.log(`unimplemented INT21 AH=${ah.toString(16)}`);
    err(1);
  };

  // ---------- DPMI INT 31h ----------
  const dpmi = () => {
    const ax = cpu.ax; setCF(false);
    switch (ax) {
      case 0x0000: { const s = mem.allocSelectors(cpu.cx || 1); for (let i = 0; i < (cpu.cx || 1); i++) mem.setDesc(s + i * 8, { base: 0, limit: 0, code: false, present: true }); cpu.ax = s; return; }
      case 0x0001: mem.freeSelector(cpu.bx); return;
      case 0x0003: cpu.ax = 8; return;
      case 0x0006: { const d = mem.getDesc(cpu.bx); if (!d) return err(0x8022); cpu.cx = d.base >>> 16; cpu.dx = d.base & 0xffff; return; }
      case 0x0007: { const d = mem.getDesc(cpu.bx); if (!d) return err(0x8022); d.base = ((cpu.cx << 16) | cpu.dx) >>> 0; cpu.refreshSegs(); return; }
      case 0x0008: { const d = mem.getDesc(cpu.bx); if (!d) return err(0x8022); d.limit = ((cpu.cx << 16) | cpu.dx) >>> 0; return; }
      case 0x0009: return;
      case 0x000a: { const d = mem.getDesc(cpu.bx); if (!d) return err(0x8022); const s = mem.allocSelectors(1); mem.setDesc(s, { ...d, code: false }); cpu.ax = s; return; }
      case 0x000b: { const d = mem.getDesc(cpu.bx); const a = mem.lin(cpu.es, cpu.di); mem.u8.fill(0, a, a + 8); if (d) { mem.w16(a, d.limit & 0xffff); mem.w16(a + 2, d.base & 0xffff); mem.u8[a + 4] = (d.base >> 16) & 0xff; mem.u8[a + 5] = d.code ? 0xfa : 0xf2; mem.u8[a + 6] = (d.limit >> 16) & 0xf; mem.u8[a + 7] = d.base >>> 24; } return; }
      case 0x000c: { const a = mem.lin(cpu.es, cpu.di); const base = mem.r16(a + 2) | (mem.u8[a + 4] << 16) | (mem.u8[a + 7] << 24); const lim = mem.r16(a) | ((mem.u8[a + 6] & 0xf) << 16); let d = mem.getDesc(cpu.bx); if (!d) { d = { base: 0, limit: 0, code: false, present: true }; mem.setDesc(cpu.bx, d); } d.base = base >>> 0; d.limit = lim; d.code = (mem.u8[a + 5] & 8) !== 0; cpu.refreshSegs(); return; }
      case 0x0100: { const b = mem.allocBlock(cpu.bx * 16); cpu.ax = b.sel; cpu.dx = b.sel; return; }
      case 0x0400: cpu.ax = 0x005a; cpu.bx = 0x0005; cpu.cl = 4; return;
    }
    w.log(`unimplemented DPMI ${ax.toString(16)}`); err(0x8001);
  };

  cpu.onInt = (n: number) => {
    switch (n) {
      case 0x21: dos(); return true;
      case 0x31: dpmi(); return true;
      case 0x2f: if (cpu.ax === 0x1600) { cpu.ax = 0x0a03; return true; } if (cpu.ax === 0x1686) { cpu.ax = 0; return true; } cpu.ax = cpu.ax; return true;
      case 0x1a: { const t = Math.floor(w.platform.now() * 18.2065 / 1000); cpu.cx = (t >>> 16) & 0xffff; cpu.dx = t & 0xffff; cpu.al = 0; return true; }
      case 0x3: w.log('INT3 breakpoint'); return true;
    }
    return false;
  };

  // ---------- TOOLHELP ----------
  const TH = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('TOOLHELP', o, n, a, r, f);
  TH(75, 'InterruptRegister', ['word', 'segptr'], 'w', ([, p]) => { w.faultHandler = p; return 1; });
  TH(76, 'InterruptUnRegister', ['word'], 'w', () => { w.faultHandler = 0; return 1; });
  TH(77, 'TerminateApp', ['word', 'word'], 'v', () => { w.exit(1); });
  TH(54, 'GlobalEntryHandle', ['ptr', 'word'], 'w', ([p, h]) => {
    const sel = h | 7; const d = mem.getDesc(sel); if (!d) return 0;
    const a = m.lin(p); mem.w32(a, 0x24); mem.w32(a + 4, d.base); mem.w32(a + 8, gsize.get(sel) ?? d.limit + 1); mem.w16(a + 12, sel);
    mem.w16(a + 14, 0); mem.w16(a + 16, w.mainModule.hModule); mem.w16(a + 18, 0); mem.w16(a + 20, 0); mem.w16(a + 22, 0); return 1;
  });
  TH(62, 'ModuleFindHandle', ['ptr', 'word'], 'w', ([p, h]) => {
    const a = m.lin(p); mem.writeCStr(p >>> 16, (p & 0xffff) + 4, 'HOLIDAY'); mem.w16(a + 14, h);
    mem.writeCStr(p >>> 16, (p & 0xffff) + 20, w.mainModule.file); return h;
  });

  // ---------- WIN87EM ----------
  m.defNative('WIN87EM', 1, '__fpMath', [], 'reg', () => {
    const bx = cpu.bx;
    if (bx === 0) { cpu.fpu.reset(); cpu.ax = 0; }
    else if (bx === 1) { cpu.ax = 0; }
    else if (bx === 2) { cpu.ax = 0; }
    else if (bx === 3) { cpu.ax = 0; }
    else if (bx === 4) { cpu.ax = cpu.fpu.cw; cpu.fpu.cw = cpu.ax; }
    else if (bx === 8) { cpu.ax = cpu.fpu.swFull(); }
    else if (bx === 10) { cpu.ax = cpu.fpu.swFull(); }
    else cpu.ax = 0;
    setCF(false);
  });

  // ---------- KEYBOARD ----------
  m.defNative('KEYBOARD', 5, 'AnsiToOem', ['str', 'ptr'], 'w', ([s, d]) => { mem.writeCStr(d >>> 16, d & 0xffff, m.str(s)); return 1; });
  m.defNative('KEYBOARD', 6, 'OemToAnsi', ['str', 'ptr'], 'w', ([s, d]) => { mem.writeCStr(d >>> 16, d & 0xffff, m.str(s)); return 1; });
}
