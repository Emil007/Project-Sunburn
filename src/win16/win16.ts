// Win16 system hub: ties machine, VFS, GDI, USER, multimedia, platform.
import { Machine, NEModule, ExitSignal } from './machine';
import { CPUFault } from '../core/cpu';
import { VFS } from './vfs';
import { GDI, Surface, Rect, DC } from './gdi';
import { User } from './user';
import { installKernel } from './kernel';
import { installUserApi } from './userapi';
import { installGdiApi } from './gdiapi';
import { installMM } from './mmsystem';
import type { Platform, CursorImage } from './platform';
import { CS, DS, ES, SS } from '../core/cpu';

export interface Win16Options { screenW?: number; screenH?: number; cmdLine?: string; }

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function halftone(c: number, x: number, y: number) {
  const t = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  const q = (v: number) => Math.min(5, Math.floor(v / 51 + t)) * 51;
  return (0xff000000 | (q((c >> 16) & 255) << 16) | (q((c >> 8) & 255) << 8) | q(c & 255)) >>> 0;
}
export class Win16 {
  m = new Machine();
  vfs = new VFS();
  gdi: GDI;
  user: User;
  mainModule!: NEModule;
  pspSel = 0;
  hTask = 0x0e00;
  ini = new Map<string, Map<string, string>>();
  faultHandler = 0;
  exited = false; exitCode = 0;
  traceFiles = false; traceDos = false; traceMCI = false; traceFree = false;
  videoLayers: { rgba: Uint8Array; w: number; h: number; x: number; y: number; dw: number; dh: number; clip: Rect }[] = [];
  loadBitmapRes!: (hi: number, n: number) => number;
  loadCursor!: (hi: number, n: number) => number;
  loadIcon!: (hi: number, n: number) => number;
  drawIcon!: (hdc: number, x: number, y: number, h: number) => void;
  idleCount = 0;
  rgba: Uint8Array;
  composeDirty = true;
  lastIdle = 0;
  dcOwner = new Map<number, number>();
  arrowCursor = 0;
  loadableNative = new Set<string>();
  galloc!: (flags: number, size: number) => number;
  hlin!: (fp: number, add: number) => number;
  findResource!: (hInst: number, name: number, type: number) => number;
  resData!: (h: number) => Uint8Array | undefined;
  fileApi!: any;
  mmTick: () => void = () => {};
  private scratchSel = 0; private scratchTop = 0; private scratchStack: number[] = [];
  private nativeHandles = new Map<string, number>();
  private lastPresent = 0;
  screenW: number; screenH: number;

  constructor(public platform: Platform, opts: Win16Options = {}) {
    this.screenW = opts.screenW ?? 640; this.screenH = opts.screenH ?? 480;
    this.m.log = (s) => platform.log(s);
    this.gdi = new GDI(this, this.screenW, this.screenH);
    this.rgba = new Uint8Array(this.screenW * this.screenH * 4);
    this.user = new User(this);
    const sc = this.m.mem.allocBlock(0x10000); this.scratchSel = sc.sel; this.scratchTop = 0x10;
    installKernel(this);
    installUserApi(this);
    installGdiApi(this);
    installMM(this);
    this.m.faultHook = (e) => this.deliverFault(e);
  }
  log(s: string) { this.platform.log(s); }

  // scratch memory for structures passed to emulated callbacks (stack discipline)
  scratch(size: number): number {
    size = (size + 3) & ~3;
    if (this.scratchTop + size > 0xfff0) { this.log('scratch overflow, resetting'); this.scratchTop = 0x10; this.scratchStack = []; }
    const off = this.scratchTop; this.scratchStack.push(off); this.scratchTop += size;
    this.m.mem.u8.fill(0, this.m.mem.lin(this.scratchSel, off), this.m.mem.lin(this.scratchSel, off) + size);
    return ((this.scratchSel << 16) | off) >>> 0;
  }
  scratchStr(s: string): number { const p = this.scratch(s.length + 1); this.m.mem.writeCStr(this.scratchSel, p & 0xffff, s); return p; }
  scratchRelease(p: number) {
    // release p and everything allocated after it
    const off = p & 0xffff; const i = this.scratchStack.lastIndexOf(off);
    if (i >= 0) { this.scratchStack.length = i; this.scratchTop = off; }
  }

  nativeModHandle(name: string) { let h = this.nativeHandles.get(name); if (!h) { h = this.m.mem.allocBlock(16).sel; this.nativeHandles.set(name, h); } return h; }
  nativeModByHandle(h: number) { for (const [n, v] of this.nativeHandles) if (v === h) return n; return undefined; }

  sysColorBrush(i: number) { return this.gdi.alloc({ type: 'brush', style: 0, color: sysColor(i) }); }

  releaseDC(h: number) {
    const dc = this.gdi.dcs.get(h); if (!dc) return 0;
    if (dc.isMem) return 0;
    this.gdi.dcs.delete(h); this.dcOwner.delete(h); return 1;
  }
  surfaceDirty(_s: Surface, _r: Rect) { this.composeDirty = true; }
  drawTextSimple(dc: DC, x: number, y: number, s: string, color: number) { const ot = dc.text, om = dc.bkMode; dc.text = color; dc.bkMode = 1; this.user.drawString(dc, x, y, s); dc.text = ot; dc.bkMode = om; }

  // ---- cursors ----
  cursorImages = new Map<number, CursorImage>();
  cursorImage(h: number): CursorImage | null { return this.cursorImages.get(h) || null; }

  // ---- compose and present ----
  compositor: { shadows?: boolean; fadeMs?: number; dim?: number; trueColorVideo?: boolean; excludeClasses?: string[] } = {};
  overlays: ((screen: Surface) => void)[] = [];
  private lut15: Uint8Array | null = null; private lutVer = -1;
  private nearest15(rgb: number) {
    if (!this.lut15 || this.lutVer !== this.gdi.palVersion) {
      this.lutVer = this.gdi.palVersion; const lut = this.lut15 = new Uint8Array(32768);
      for (let i = 0; i < 32768; i++) { const r = (i & 31) << 3, g = ((i >> 5) & 31) << 3, b = ((i >> 10) & 31) << 3; lut[i] = this.gdi.nearest(r | (g << 8) | (b << 16)); }
    }
    return this.lut15[((rgb >> 3) & 31) | (((rgb >> 11) & 31) << 5) | (((rgb >> 19) & 31) << 10)];
  }
  // No application palette realized (e.g. intro films before the game sets its palette): Video for
  // Windows then draws with its own halftone palette (6x6x6 cube, ordered dither) - emulate that.
  private emptyPalVer = -1; private emptyPal = false;
  private paletteIsEmpty() {
    if (this.emptyPalVer !== this.gdi.palVersion) {
      this.emptyPalVer = this.gdi.palVersion; const p = this.gdi.sysPal; const seen = new Set<number>();
      for (let i = 10; i < 246; i++) seen.add(p[i * 4] | (p[i * 4 + 1] << 8) | (p[i * 4 + 2] << 16));
      this.emptyPal = seen.size < 24;
    }
    return this.emptyPal;
  }
  compose() { /* kept for API compatibility; composition happens in present() */ }
  present(force = false) {
    const now = this.platform.now();
    // while the game computes without pausing (e.g. generating an island) present at ~15 fps,
    // otherwise ~60 fps: composing the screen costs as much as a few million emulated instructions
    const busy = now - this.lastIdle > 250;
    if (!force && now - this.lastPresent < (busy ? 66 : 15)) return;
    this.lastPresent = now;
    const scr = this.gdi.screen, pal = this.gdi.sysPal, out = this.rgba;
    const W = scr.w, H = scr.h;
    const p32 = new Uint32Array(256); for (let i = 0; i < 256; i++) p32[i] = (pal[i * 4] | (pal[i * 4 + 1] << 8) | (pal[i * 4 + 2] << 16) | 0xff000000) >>> 0;
    const o32 = new Uint32Array(out.buffer, out.byteOffset, W * H);
    // desktop: whatever was drawn on the screen DC (normally black)
    const sd = scr.data; for (let i = 0; i < o32.length; i++) o32[i] = p32[sd[i]];
    const C = this.compositor; const excl = C.excludeClasses || ['THintergrund', 'THauptschirm', 'TApplication'];
    const tops = this.user.tops;
    const isPopup = (t: any) => !excl.includes(t.cls.name) && t.cls.name !== 'THintWindow';
    // dimming: darken everything below the top-most visible popup
    let dimBelow = -1;
    if (C.dim) for (let i = 0; i < tops.length; i++) { const t = tops[i]; if ((t.style & 0x10000000) && t.w > 40 && t.h_ > 40 && isPopup(t)) { dimBelow = i; break; } }
    for (let i = tops.length - 1; i >= 0; i--) {
      const t = tops[i];
      if (!(t.style & 0x10000000) || t.w <= 0 || t.h_ <= 0 || !t.surface) continue;
      const s = t.surface;
      let alpha = 1;
      if (C.fadeMs && isPopup(t) && (t as any).shownAt !== undefined) { alpha = Math.min(1, (now - (t as any).shownAt) / C.fadeMs); if (alpha < 1) this.lastPresent = 0; }
      if (dimBelow >= 0 && i === dimBelow) { const k = 1 - C.dim!; for (let j = 0; j < o32.length; j++) { const v = o32[j]; o32[j] = (0xff000000 | ((((v >> 16) & 255) * k) << 16) | ((((v >> 8) & 255) * k) << 8) | ((v & 255) * k)) >>> 0; } }
      if (C.shadows && isPopup(t) && t.w > 40 && t.h_ > 30) shadow(o32, W, H, t.x, t.y, s.w, s.h, alpha);
      const x0 = Math.max(0, t.x), y0 = Math.max(0, t.y), x1 = Math.min(W, t.x + s.w), y1 = Math.min(H, t.y + s.h);
      if (alpha >= 1) {
        for (let y = y0; y < y1; y++) { let so = (y - t.y) * s.w + (x0 - t.x); let o = y * W + x0; for (let x = x0; x < x1; x++) o32[o++] = p32[s.data[so++]]; }
      } else {
        const a = alpha, ia = 1 - alpha;
        for (let y = y0; y < y1; y++) { let so = (y - t.y) * s.w + (x0 - t.x); let o = y * W + x0; for (let x = x0; x < x1; x++, o++) { const n = p32[s.data[so++]], v = o32[o]; o32[o] = (0xff000000 | (((((n >> 16) & 255) * a + ((v >> 16) & 255) * ia) | 0) << 16) | (((((n >> 8) & 255) * a + ((v >> 8) & 255) * ia) | 0) << 8) | (((n & 255) * a + (v & 255) * ia) | 0)) >>> 0; } }
      }
    }
    for (const v of this.videoLayers) {
      const sx = v.w / v.dw, sy = v.h / v.dh; const v32 = new Uint32Array(v.rgba.buffer, v.rgba.byteOffset, v.w * v.h);
      const x0 = Math.max(0, v.x, v.clip.l), y0 = Math.max(0, v.y, v.clip.t), x1 = Math.min(W, v.x + v.dw, v.clip.r), y1 = Math.min(H, v.y + v.dh, v.clip.b);
      const tc = !!C.trueColorVideo, ht = !tc && this.paletteIsEmpty();
      for (let y = y0; y < y1; y++) {
        const vy = Math.min(v.h - 1, Math.floor((y - v.y) * sy)) * v.w;
        for (let x = x0; x < x1; x++) {
          const c = v32[vy + Math.min(v.w - 1, Math.floor((x - v.x) * sx))];
          o32[y * W + x] = tc ? (c | 0xff000000) >>> 0 : ht ? halftone(c, x, y) : p32[this.nearest15(c)];
        }
      }
    }
    this.platform.present(out, W, H, pal, this.user.cursorVisible ? this.cursorImage(this.user.cursor) : null, this.user.mouseX, this.user.mouseY);
    this.composeDirty = false;
  }

  // Run n instructions with Win16 fault delivery (TOOLHELP InterruptRegister). Returns false when the program has ended.
  faultCount = 0;
  runSlice(n: number): boolean {
    const cpu = this.m.cpu;
    for (let i = 0; i < n; i++) {
      if (cpu.halted || this.exited) return false;
      try { cpu.step(); }
      catch (e) {
        if (e instanceof ExitSignal) { this.exited = true; return false; }
        if (e instanceof CPUFault && this.deliverFault(e)) continue;
        throw e;
      }
    }
    return !cpu.halted && !this.exited;
  }
  deliverFault(e: CPUFault): boolean {
    const cpu = this.m.cpu;
    if (!this.faultHandler || ![0, 6, 12, 13].includes(e.vec)) return false;
    if (++this.faultCount > 50) return false;
    this.log(`fault ${e.vec} delivered to application handler: ${e.message}`);
    const ip = cpu.curInstIp, cs = cpu.cs;
    // ToolHelp frame: flags, CS, IP, handle, int#, AX, ret CS:IP (decline -> terminate)
    cpu.push16(cpu.flags); cpu.push16(cs); cpu.push16(ip); cpu.push16(0); cpu.push16(e.vec); cpu.push16(cpu.ax);
    const decline = this.declineThunk ??= this.m.makeNativeProc('ToolhelpDecline', [], 'reg', () => { throw e; });
    cpu.push16(decline >>> 16); cpu.push16(decline & 0xffff);
    cpu.ax = this.mainModule.autoDS;
    cpu.farJump(this.faultHandler >>> 16, this.faultHandler & 0xffff);
    return true;
  }
  private declineThunk?: number;
  requestQuit() { this.user.quit = true; this.user.quitCode = 0; }
  exit(code: number) { this.exited = true; this.exitCode = code; this.m.cpu.halted = true; }

  // ---- program start ----
  start(exePath: string, exeData: Uint8Array, cmdLine = '') { this.load(exePath, exeData); this.begin(cmdLine); }
  load(exePath: string, exeData: Uint8Array) {
    const mod = this.m.loadNE(exeData, exePath);
    // resources become independent copies so mods can rewrite them
    for (const r of mod.resources) r.data = r.data.slice();
    this.mainModule = mod;
    return mod;
  }
  begin(cmdLine = '') {
    const mod = this.mainModule;
    const mem = this.m.mem, cpu = this.m.cpu;
    const psp = mem.allocBlock(0x100); this.pspSel = psp.sel;
    mem.w16(psp.base, 0x20cd);
    mem.u8[psp.base + 0x80] = cmdLine.length; for (let i = 0; i < cmdLine.length; i++) mem.u8[psp.base + 0x81 + i] = cmdLine.charCodeAt(i); mem.u8[psp.base + 0x81 + cmdLine.length] = 0x0d;
    // stack setup
    const ds = mod.autoDS; const dsDesc = mem.getDesc(ds)!;
    cpu.loadSeg(DS, ds); cpu.loadSeg(SS, mod.ss || ds); cpu.loadSeg(ES, psp.sel);
    cpu.sp = mod.sp || ((dsDesc.limit + 1) & 0xfffe);
    cpu.ax = 0; cpu.bx = mod.stack; cpu.cx = mod.heap; cpu.di = mod.hInstance; cpu.si = 0; cpu.bp = 0;
    cpu.farJump(mod.entryCS, mod.entryIP);
  }
}

function shadow(o32: Uint32Array, W: number, H: number, x: number, y: number, w: number, h: number, alpha: number) {
  // soft drop shadow: a few expanding rectangles with decreasing opacity, offset down-right
  const layers = [[10, 0.07], [7, 0.08], [4, 0.1], [2, 0.12]];
  for (const [g, op] of layers) {
    const k = 1 - op * alpha; const x0 = Math.max(0, x + 6 - g), y0 = Math.max(0, y + 8 - g), x1 = Math.min(W, x + w + 6 + g), y1 = Math.min(H, y + h + 8 + g);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = yy * W + xx; const v = o32[i]; o32[i] = (0xff000000 | ((((v >> 16) & 255) * k) << 16) | ((((v >> 8) & 255) * k) << 8) | ((v & 255) * k)) >>> 0; }
  }
}

export function sysColor(i: number): number {
  const c = [0xc0c0c0, 0x808000, 0x800000, 0x808080, 0xc0c0c0, 0xffffff, 0x000000, 0x000000, 0x000000, 0xffffff, 0xc0c0c0, 0xc0c0c0, 0xffffff, 0x800000, 0xffffff, 0xc0c0c0, 0x808080, 0x808080, 0x000000, 0x808080, 0xffffff];
  return c[i] ?? 0xc0c0c0;
}
