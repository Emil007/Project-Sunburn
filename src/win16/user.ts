// USER: window manager, messages, painting, timers, input, cursors, menus, text.
import type { Win16 } from './win16';
import type { DC, Surface, Rect } from './gdi';
import { FONTS } from './font';

export const WM = {
  CREATE: 1, DESTROY: 2, MOVE: 3, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, KILLFOCUS: 8, ENABLE: 0xa, SETREDRAW: 0xb, SETTEXT: 0xc, GETTEXT: 0xd, GETTEXTLENGTH: 0xe,
  PAINT: 0xf, CLOSE: 0x10, QUERYENDSESSION: 0x11, QUIT: 0x12, ERASEBKGND: 0x14, SYSCOLORCHANGE: 0x15, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1c, SETCURSOR: 0x20,
  MOUSEACTIVATE: 0x21, GETMINMAXINFO: 0x24, WINDOWPOSCHANGING: 0x46, WINDOWPOSCHANGED: 0x47, NCCREATE: 0x81, NCDESTROY: 0x82, NCCALCSIZE: 0x83, NCHITTEST: 0x84,
  NCPAINT: 0x85, NCACTIVATE: 0x86, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, SYSKEYDOWN: 0x104, SYSKEYUP: 0x105, SYSCHAR: 0x106, COMMAND: 0x111, SYSCOMMAND: 0x112, TIMER: 0x113,
  HSCROLL: 0x114, VSCROLL: 0x115, INITMENU: 0x116, INITMENUPOPUP: 0x117, MENUSELECT: 0x11f, ENTERIDLE: 0x121,
  MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, LBUTTONDBLCLK: 0x203, RBUTTONDOWN: 0x204, RBUTTONUP: 0x205, RBUTTONDBLCLK: 0x206, MBUTTONDOWN: 0x207, MBUTTONUP: 0x208,
  PARENTNOTIFY: 0x210, MDIACTIVATE: 0x222, QUERYNEWPALETTE: 0x30f, PALETTECHANGED: 0x311, PALETTEISCHANGING: 0x310, CANCELMODE: 0x1f, CHILDACTIVATE: 0x22, NCMOUSEMOVE: 0xa0,
};
const WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_DISABLED = 0x08000000, WS_CAPTION = 0x00c00000, WS_BORDER = 0x00800000, WS_DLGFRAME = 0x00400000, WS_THICKFRAME = 0x00040000, WS_POPUP = 0x80000000, WS_MAXIMIZE = 0x01000000, WS_MINIMIZE = 0x20000000;
const WS_EX_TOPMOST = 8;
const SWP = { NOSIZE: 1, NOMOVE: 2, NOZORDER: 4, NOREDRAW: 8, NOACTIVATE: 0x10, FRAMECHANGED: 0x20, SHOWWINDOW: 0x40, HIDEWINDOW: 0x80, NOOWNERZORDER: 0x200 };

export interface Wnd {
  h: number; cls: WClass; proc: number; style: number; ex: number; parent: Wnd | null; owner: Wnd | null; children: Wnd[];
  x: number; y: number; w: number; h_: number; text: string; id: number; hInst: number; extra: Uint8Array;
  props: Map<string | number, number>; update: Rect | null; erase: boolean; menu: number; destroyed: boolean;
  surface?: Surface; scroll: { [bar: number]: { pos: number; min: number; max: number } };
  maximized: boolean; minimized: boolean; ncPaint: boolean; restore?: Rect;
}
export interface WClass { name: string; style: number; proc: number; clsExtra: number; wndExtra: number; hInst: number; icon: number; cursor: number; brush: number; menuName: number; atom: number; }
interface Msg { hwnd: number; msg: number; wp: number; lp: number; time: number; x: number; y: number; }
interface Timer { hwnd: number; id: number; interval: number; proc: number; next: number; }

const R = (l: number, t: number, r: number, b: number): Rect => ({ l, t, r, b });
const isect = (a: Rect, b: Rect): Rect => R(Math.max(a.l, b.l), Math.max(a.t, b.t), Math.min(a.r, b.r), Math.min(a.b, b.b));
const empty = (a: Rect) => a.r <= a.l || a.b <= a.t;
const union = (a: Rect | null, b: Rect): Rect => a ? R(Math.min(a.l, b.l), Math.min(a.t, b.t), Math.max(a.r, b.r), Math.max(a.b, b.b)) : { ...b };

export class User {
  wnds = new Map<number, Wnd>();
  classes = new Map<string, WClass>();
  tops: Wnd[] = []; // z-order: index 0 = top
  queue: Msg[] = [];
  timers: Timer[] = [];
  // game speed: short timers (the game's tick) fire this many times faster; UI delays stay as they are
  timerScale = 1;
  /** only timers with exactly this interval are scaled (0 = all timers under 500 ms) */
  timerScaleOnly = 0;
  private tInt(ms: number) {
    if (this.timerScale === 1 || (this.timerScaleOnly ? ms !== this.timerScaleOnly : ms >= 500)) return ms;
    return Math.max(1, ms / this.timerScale);
  }
  // mods can take mouse/keyboard events before the game sees them (return true = consumed)
  inputFilters: ((e: { type: string; x?: number; y?: number; button?: number }) => boolean)[] = [];
  private nextH = 0x0400;
  focus = 0; active = 0; capture = 0;
  inputTrace: ((s: string) => void) | null = null;
  cursor = 0; cursorVisible = true;
  mouseX = 0; mouseY = 0;
  keyState = new Uint8Array(256);
  quit = false; quitCode = 0;
  atoms = new Map<string, number>(); atomNames = new Map<number, string>(); private nextAtom = 0xc000;
  menus = new Map<number, { items: { id: number; flags: number; text: string; sub: number }[] }>();
  cursors = new Map<number, any>();
  private appActive = false;
  lastClick = { t: 0, x: 0, y: 0, b: 0, h: 0 };
  desktop: Wnd;
  constructor(public w: Win16) {
    const cls: WClass = { name: '#32769', style: 0, proc: 0, clsExtra: 0, wndExtra: 0, hInst: 0, icon: 0, cursor: 0, brush: 0, menuName: 0, atom: 0 };
    this.desktop = { h: 0, cls, proc: 0, style: WS_VISIBLE, ex: 0, parent: null, owner: null, children: [], x: 0, y: 0, w: w.gdi.screen.w, h_: w.gdi.screen.h, text: '', id: 0, hInst: 0, extra: new Uint8Array(0), props: new Map(), update: null, erase: false, menu: 0, destroyed: false, scroll: {}, maximized: false, minimized: false, ncPaint: false };
  }

  // ---------- helpers ----------
  get(h: number) { return this.wnds.get(h & 0xffff); }
  atom(name: string) {
    const k = name.toUpperCase(); let a = this.atoms.get(k);
    if (!a) { a = this.nextAtom++; this.atoms.set(k, a); this.atomNames.set(a, name); }
    return a;
  }
  propKey(p: number): string | number { if ((p >>> 16) === 0) return p & 0xffff; const s = this.w.m.str(p).toUpperCase(); const a = this.atoms.get(s); return a ?? s; }
  isTop(wd: Wnd) { return !(wd.style & WS_CHILD) || !wd.parent; }
  topOf(wd: Wnd): Wnd { while (wd.parent && (wd.style & WS_CHILD)) wd = wd.parent; return wd; }
  ncMetrics(wd: Wnd) {
    let b = 0, cap = 0;
    if ((wd.style & WS_CAPTION) === WS_CAPTION) { cap = 19; b = wd.style & WS_THICKFRAME ? 4 : 1; }
    else if (wd.style & WS_THICKFRAME) b = 4;
    else if (wd.style & WS_DLGFRAME) b = 4;
    else if (wd.style & WS_BORDER) b = 1;
    if (wd.ex & 1) b = Math.max(b, 4); // WS_EX_DLGMODALFRAME
    return { b, cap };
  }
  clientRect(wd: Wnd): Rect { const { b, cap } = this.ncMetrics(wd); return R(0, 0, Math.max(0, wd.w - 2 * b), Math.max(0, wd.h_ - 2 * b - cap)); }
  // window origin relative to its top-level surface
  winOrgOnTop(wd: Wnd): [number, number] {
    let x = 0, y = 0; let c = wd;
    while (c.parent && (c.style & WS_CHILD)) { const p = c.parent; const { b, cap } = this.ncMetrics(p); x += c.x + b; y += c.y + b + cap; c = p; }
    return [x, y];
  }
  clientOrgOnTop(wd: Wnd): [number, number] { const [x, y] = this.winOrgOnTop(wd); const { b, cap } = this.ncMetrics(wd); return [x + b, y + b + cap]; }
  screenOrg(wd: Wnd): [number, number] { const t = this.topOf(wd); const [x, y] = this.winOrgOnTop(wd); return [x + t.x, y + t.y]; }
  clientToScreen(wd: Wnd, x: number, y: number): [number, number] { const t = this.topOf(wd); const [cx, cy] = this.clientOrgOnTop(wd); return [x + cx + t.x, y + cy + t.y]; }
  isVisible(wd: Wnd): boolean { let c: Wnd | null = wd; while (c) { if (!(c.style & WS_VISIBLE)) return false; if (!(c.style & WS_CHILD)) break; c = c.parent; } return true; }
  ensureSurface(t: Wnd) {
    const W = Math.max(1, t.w), H = Math.max(1, t.h_);
    if (!t.surface || t.surface.w !== W || t.surface.h !== H) {
      const n = this.w.gdi.newSurface(W, H, false);
      if (t.surface) { const o = t.surface; for (let y = 0; y < Math.min(H, o.h); y++) n.data.set(o.data.subarray(y * o.w, y * o.w + Math.min(W, o.w)), y * W); }
      t.surface = n;
    }
    return t.surface;
  }

  // ---------- message send/post ----------
  send(h: number, msg: number, wp: number, lp: number): number {
    const wd = this.get(h); if (!wd || wd.destroyed && msg !== WM.NCDESTROY) return 0;
    return this.callProc(wd.proc, h, msg, wp, lp);
  }
  callProc(proc: number, h: number, msg: number, wp: number, lp: number): number {
    if (!proc) return this.defProc(h, msg, wp, lp);
    return this.w.m.callFar(proc, [[h, 2], [msg, 2], [wp & 0xffff, 2], [lp >>> 0, 4]], this.w.mainModule.autoDS);
  }
  post(h: number, msg: number, wp: number, lp: number) {
    this.queue.push({ hwnd: h, msg, wp: wp & 0xffff, lp: lp >>> 0, time: this.w.platform.now() | 0, x: this.mouseX, y: this.mouseY });
    return 1;
  }

  // ---------- classes ----------
  registerClass(c: WClass) { this.classes.set(c.name.toUpperCase(), c); c.atom = this.atom(c.name); return c.atom; }
  findClass(name: string) { return this.classes.get(name.toUpperCase()); }

  // ---------- creation ----------
  create(ex: number, clsName: string, title: string, style: number, x: number, y: number, cw: number, ch: number, parentH: number, menu: number, hInst: number, param: number): number {
    const cls = this.findClass(clsName);
    if (!cls) { this.w.log(`CreateWindow: unknown class ${clsName}`); return 0; }
    let parent = parentH ? this.get(parentH) || null : null;
    let owner: Wnd | null = null;
    if (!(style & WS_CHILD) && parent) { owner = this.topOf(parent); parent = null; }
    const CW = -0x8000;
    if (x === CW) { x = 0; y = 0; } if (cw === CW) { cw = this.desktop.w; ch = this.desktop.h_; }
    const h = this.nextH; this.nextH += 2; while (this.wnds.has(this.nextH)) this.nextH += 2;
    const wd: Wnd = {
      h, cls, proc: cls.proc, style: style & ~WS_VISIBLE, ex, parent: (style & WS_CHILD) ? parent : null, owner, children: [], x, y, w: cw, h_: ch, text: '', id: (style & WS_CHILD) ? menu : 0,
      hInst, extra: new Uint8Array(cls.wndExtra), props: new Map(), update: null, erase: false, menu: (style & WS_CHILD) ? 0 : menu, destroyed: false, scroll: {}, maximized: false, minimized: false, ncPaint: true,
    };
    this.wnds.set(h, wd);
    if (wd.parent) wd.parent.children.unshift(wd);
    else this.insertTop(wd);
    const m = this.w.m;
    // CREATESTRUCT
    const cs = this.w.scratch(34);
    const titleP = this.w.scratchStr(title), clsP = this.w.scratchStr(clsName);
    const L = m.lin(cs); const mem = m.mem;
    mem.w32(L, param); mem.w16(L + 4, hInst); mem.w16(L + 6, menu); mem.w16(L + 8, parentH); mem.w16(L + 10, ch); mem.w16(L + 12, cw); mem.w16(L + 14, y); mem.w16(L + 16, x);
    mem.w32(L + 18, style); mem.w32(L + 22, titleP); mem.w32(L + 26, clsP); mem.w32(L + 30, ex);
    // WM_GETMINMAXINFO for top-level
    if (!(style & WS_CHILD)) {
      const mmi = this.w.scratch(20); const ML = m.lin(mmi);
      const vals = [0, 0, this.desktop.w, this.desktop.h_, 0, 0, 100, 30, this.desktop.w + 8, this.desktop.h_ + 8];
      for (let i = 0; i < 10; i++) mem.w16(ML + i * 2, vals[i]);
      this.send(h, WM.GETMINMAXINFO, 0, mmi);
    }
    if (!this.send(h, WM.NCCREATE, 0, cs)) { this.w.log(`WM_NCCREATE failed for ${clsName}`); this.destroy(h); this.w.scratchRelease(cs); return 0; }
    wd.text = wd.text || title;
    this.send(h, WM.NCCALCSIZE, 0, 0);
    const r = this.send(h, WM.CREATE, 0, cs);
    this.w.scratchRelease(cs);
    if ((r & 0xffff) === 0xffff) { this.destroy(h); return 0; }
    if (!this.wnds.has(h)) return 0;
    if (style & WS_MAXIMIZE) {
      wd.restore = R(wd.x, wd.y, wd.x + wd.w, wd.y + wd.h_); wd.maximized = true; wd.style |= WS_MAXIMIZE;
      const pr = wd.parent ? this.clientRect(wd.parent) : R(0, 0, this.desktop.w, this.desktop.h_);
      wd.x = 0; wd.y = 0; wd.w = pr.r; wd.h_ = pr.b;
    }
    const cr = this.clientRect(wd);
    this.send(h, WM.SIZE, wd.maximized ? 2 : 0, ((cr.b << 16) | cr.r) >>> 0);
    this.send(h, WM.MOVE, 0, (((wd.y & 0xffff) << 16) | (wd.x & 0xffff)) >>> 0);
    if (wd.parent && !(ex & 4)) this.send(wd.parent.h, WM.PARENTNOTIFY, WM.CREATE, ((h << 16) | wd.id) >>> 0);
    if (style & WS_VISIBLE) this.show(h, (style & WS_MAXIMIZE) ? 3 : 1);
    return h;
  }
  insertTop(wd: Wnd, after?: number) {
    const i = this.tops.indexOf(wd); if (i >= 0) this.tops.splice(i, 1);
    if (after === 1) { this.tops.push(wd); return; } // HWND_BOTTOM
    if (after !== undefined && after > 1 && after !== 0xffff) { const a = this.tops.findIndex(t => t.h === after); if (a >= 0) { this.tops.splice(a + 1, 0, wd); return; } }
    // topmost windows stay above
    if (wd.ex & WS_EX_TOPMOST || after === 0xffff) { this.tops.unshift(wd); return; }
    let k = 0; while (k < this.tops.length && (this.tops[k].ex & WS_EX_TOPMOST)) k++;
    this.tops.splice(k, 0, wd);
  }
  bringToTop(wd: Wnd) {
    if (wd.parent && (wd.style & WS_CHILD)) { const p = wd.parent; p.children.splice(p.children.indexOf(wd), 1); p.children.unshift(wd); this.invalidate(wd.h, null, true); return; }
    this.insertTop(wd);
    // owned windows above owner
    for (const o of [...this.tops].reverse()) if (o.owner === wd && o !== wd) this.insertTop(o);
    this.w.composeDirty = true;
  }

  destroy(h: number): number {
    const wd = this.get(h); if (!wd || wd.destroyed) return 0;
    if (wd.style & WS_VISIBLE) this.setPos(wd, 0, 0, 0, 0, 0, SWP.HIDEWINDOW | SWP.NOMOVE | SWP.NOSIZE | SWP.NOZORDER | SWP.NOACTIVATE);
    // destroy owned windows first
    for (const o of [...this.wnds.values()]) if (o.owner === wd) this.destroy(o.h);
    if (wd.parent && !(wd.ex & 4) && (wd.style & WS_CHILD)) this.send(wd.parent.h, WM.PARENTNOTIFY, WM.DESTROY, ((h << 16) | wd.id) >>> 0);
    this.send(h, WM.DESTROY, 0, 0);
    for (const c of [...wd.children]) this.destroy(c.h);
    this.send(h, WM.NCDESTROY, 0, 0);
    wd.destroyed = true;
    if (wd.parent) { const i = wd.parent.children.indexOf(wd); if (i >= 0) wd.parent.children.splice(i, 1); }
    const ti = this.tops.indexOf(wd); if (ti >= 0) this.tops.splice(ti, 1);
    this.wnds.delete(h);
    this.timers = this.timers.filter(t => t.hwnd !== h);
    this.queue = this.queue.filter(q => q.hwnd !== h);
    if (this.focus === h) this.focus = 0;
    if (this.capture === h) this.capture = 0;
    if (this.active === h) { this.active = 0; const n = this.tops.find(t => t.style & WS_VISIBLE && !(t.style & WS_DISABLED)); if (n) this.activate(n.h, false); }
    this.w.composeDirty = true;
    return 1;
  }

  // ---------- position / show ----------
  setPos(wd: Wnd, after: number, x: number, y: number, cx: number, cy: number, flags: number) {
    const m = this.w.m; const mem = m.mem;
    const wp = this.w.scratch(14); const L = m.lin(wp);
    mem.w16(L, wd.h); mem.w16(L + 2, after); mem.w16(L + 4, x); mem.w16(L + 6, y); mem.w16(L + 8, cx); mem.w16(L + 10, cy); mem.w16(L + 12, flags);
    if (!(flags & (SWP.NOMOVE | SWP.NOSIZE)) || !(flags & SWP.NOMOVE) || !(flags & SWP.NOSIZE) || (flags & (SWP.SHOWWINDOW | SWP.HIDEWINDOW)))
      this.send(wd.h, WM.WINDOWPOSCHANGING, 0, wp);
    x = (mem.r16(L + 4) << 16) >> 16; y = (mem.r16(L + 6) << 16) >> 16; cx = (mem.r16(L + 8) << 16) >> 16; cy = (mem.r16(L + 10) << 16) >> 16; flags = mem.r16(L + 12);
    const old = R(wd.x, wd.y, wd.x + wd.w, wd.y + wd.h_);
    const wasVis = this.isVisible(wd);
    if (!(flags & SWP.NOMOVE)) { wd.x = x; wd.y = y; }
    if (!(flags & SWP.NOSIZE)) { wd.w = Math.max(0, cx); wd.h_ = Math.max(0, cy); }
    if (flags & SWP.SHOWWINDOW) { if (!(wd.style & WS_VISIBLE)) (wd as any).shownAt = this.w.platform.now(); wd.style |= WS_VISIBLE; }
    if (flags & SWP.HIDEWINDOW) wd.style &= ~WS_VISIBLE;
    if (!(flags & SWP.NOZORDER)) {
      if (this.isTop(wd)) { if (after === 0xffff) wd.ex |= WS_EX_TOPMOST; else if (after === 0xfffe) wd.ex &= ~WS_EX_TOPMOST; this.insertTop(wd, after); }
      else if (wd.parent) { const p = wd.parent; p.children.splice(p.children.indexOf(wd), 1); if (after === 1) p.children.push(wd); else p.children.unshift(wd); }
    }
    const moved = old.l !== wd.x || old.t !== wd.y; const sized = old.r - old.l !== wd.w || old.b - old.t !== wd.h_;
    const nowVis = this.isVisible(wd);
    if (sized || (nowVis && !wasVis) || (flags & SWP.FRAMECHANGED)) { this.invalidate(wd.h, null, true); wd.ncPaint = true; }
    if (!this.isTop(wd) && wd.parent && (moved || sized || nowVis !== wasVis)) {
      // parent must repaint uncovered area
      this.invalidateChildArea(wd.parent, old);
    }
    if (this.isTop(wd)) this.w.composeDirty = true;
    mem.w16(L + 2, after); mem.w16(L + 4, wd.x); mem.w16(L + 6, wd.y); mem.w16(L + 8, wd.w); mem.w16(L + 10, wd.h_); mem.w16(L + 12, flags);
    this.send(wd.h, WM.WINDOWPOSCHANGED, 0, wp);
    this.w.scratchRelease(wp);
    if (!(flags & SWP.NOACTIVATE) && this.isTop(wd) && nowVis && !wasVis) this.activate(wd.h, false);
    if (flags & SWP.HIDEWINDOW && this.active === wd.h) {
      const n = this.tops.find(t => t !== wd && (t.style & WS_VISIBLE) && !(t.style & WS_DISABLED) && t.w > 0);
      if (n) this.activate(n.h, false); else this.active = 0;
    }
    if (flags & SWP.HIDEWINDOW && this.focus && (this.focus === wd.h || this.isChildOf(this.get(this.focus), wd))) this.setFocus(0);
    if (this.view && this.isTop(wd) && nowVis && (moved || sized || !wasVis)) this.keepInView(wd);
    return 1;
  }
  // Part of the screen the player can see. When the host window is smaller than the game's screen,
  // top-level windows are kept inside it so nothing ends up out of reach.
  view: Rect | null = null; private clamping = false;
  setVisibleArea(x: number, y: number, w: number, h: number) {
    const sw = this.desktop.w, sh = this.desktop.h_;
    this.view = (w <= 0 || h <= 0 || (x <= 0 && y <= 0 && x + w >= sw && y + h >= sh)) ? null : R(x, y, x + w, y + h);
    if (this.view) for (const t of [...this.tops]) this.keepInView(t);
  }
  keepInView(wd: Wnd) {
    const v = this.view; if (!v || this.clamping || wd.destroyed || wd === this.desktop || !this.isTop(wd) || !(wd.style & WS_VISIBLE) || wd.w <= 0) return;
    if (wd.maximized) return;
    // per axis: fits -> pull it fully inside; too big -> leave it if it already spans the view, else align
    const fit = (p: number, size: number, lo: number, hi: number) => size <= hi - lo ? Math.max(lo, Math.min(p, hi - size)) : (p <= lo && p + size >= hi ? p : lo);
    const nx = fit(wd.x, wd.w, v.l, v.r), ny = fit(wd.y, wd.h_, v.t, v.b);
    if (nx === wd.x && ny === wd.y) return;
    this.clamping = true;
    try { this.setPos(wd, 0, nx, ny, 0, 0, SWP.NOSIZE | SWP.NOZORDER | SWP.NOACTIVATE); } finally { this.clamping = false; }
  }
  invalidateChildArea(p: Wnd, r: Rect) { this.invalidate(p.h, r, true); }
  isChildOf(c: Wnd | undefined, p: Wnd): boolean { while (c) { if (c === p) return true; c = c.parent || undefined; } return false; }
  show(h: number, cmd: number): number {
    const wd = this.get(h); if (!wd) return 0;
    const was = (wd.style & WS_VISIBLE) !== 0;
    const showing = cmd !== 0;
    if (showing !== was) this.send(h, WM.SHOWWINDOW, showing ? 1 : 0, 0);
    let flags = SWP.NOZORDER | SWP.NOMOVE | SWP.NOSIZE;
    let x = 0, y = 0, cx = 0, cy = 0;
    switch (cmd) {
      case 0: flags |= SWP.HIDEWINDOW | SWP.NOACTIVATE; break;
      case 3: { // maximize
        if (!wd.maximized) { wd.restore = R(wd.x, wd.y, wd.x + wd.w, wd.y + wd.h_); }
        wd.maximized = true; wd.style |= WS_MAXIMIZE;
        const pr = wd.parent ? this.clientRect(wd.parent) : R(0, 0, this.desktop.w, this.desktop.h_);
        x = 0; y = 0; cx = pr.r; cy = pr.b; flags = SWP.SHOWWINDOW | SWP.FRAMECHANGED; break;
      }
      case 2: case 6: case 7: wd.minimized = true; flags |= SWP.SHOWWINDOW | SWP.NOACTIVATE; break;
      case 9: case 1: if (wd.maximized && cmd === 9 && wd.restore) { const r = wd.restore; x = r.l; y = r.t; cx = r.r - r.l; cy = r.b - r.t; flags = SWP.SHOWWINDOW | SWP.NOZORDER; wd.maximized = false; wd.style &= ~WS_MAXIMIZE; } else flags |= SWP.SHOWWINDOW; wd.minimized = false; break;
      case 4: case 8: flags |= SWP.SHOWWINDOW | SWP.NOACTIVATE; break;
      case 5: flags |= SWP.SHOWWINDOW; break;
      default: flags |= SWP.SHOWWINDOW;
    }
    if (this.isTop(wd) && cmd !== 0 && cmd !== 4 && cmd !== 8 && cmd !== 7) { flags &= ~SWP.NOZORDER; }
    this.setPos(wd, 0, x, y, cx, cy, flags);
    if ((cmd === 3 || cmd === 9) || (wd.maximized && cmd === 3)) {
      const cr = this.clientRect(wd); this.send(h, WM.SIZE, cmd === 3 ? 2 : 0, ((cr.b << 16) | cr.r) >>> 0);
    }
    return was ? 1 : 0;
  }

  // ---------- activation / focus ----------
  activate(h: number, mouse: boolean) {
    const wd = this.get(h); if (!wd) return;
    const t = this.topOf(wd); if (this.active === t.h) return;
    const prev = this.active;
    if (!this.appActive) { this.appActive = true; for (const tw of [...this.tops]) this.send(tw.h, WM.ACTIVATEAPP, 1, 0); }
    if (prev) { this.send(prev, WM.NCACTIVATE, 0, 0); this.send(prev, WM.ACTIVATE, 0, t.h); }
    this.active = t.h;
    this.bringToTop(t);
    this.send(t.h, WM.NCACTIVATE, 1, 0);
    this.send(t.h, WM.ACTIVATE, mouse ? 2 : 1, prev);
  }
  setFocus(h: number): number {
    const prev = this.focus;
    if (h === prev) return prev;
    if (h) { const wd = this.get(h); if (!wd) return prev; const t = this.topOf(wd); if (this.active !== t.h) this.activate(t.h, false); }
    this.focus = h;
    if (prev && this.get(prev)) this.send(prev, WM.KILLFOCUS, h, 0);
    if (h && this.focus === h) this.send(h, WM.SETFOCUS, prev, 0);
    return prev;
  }

  // ---------- painting ----------
  invalidate(h: number, r: Rect | null, erase: boolean) {
    const wd = h ? this.get(h) : null;
    if (!wd) { for (const t of this.tops) this.invalidate(t.h, null, erase); return; }
    const cr = this.clientRect(wd);
    const rr = r ? isect(r, cr) : cr;
    if (!empty(rr)) { wd.update = union(wd.update, rr); if (erase) wd.erase = true; }
    // children overlapping are also invalidated
    for (const c of wd.children) {
      if (!(c.style & WS_VISIBLE)) continue;
      const cr2 = R(c.x, c.y, c.x + c.w, c.y + c.h_);
      const i = isect(cr2, rr); if (!empty(i)) {
        const { b, cap } = this.ncMetrics(c);
        this.invalidate(c.h, R(i.l - c.x - b, i.t - c.y - b - cap, i.r - c.x - b, i.b - c.y - b - cap), erase);
      }
    }
  }
  validate(h: number, r: Rect | null) {
    const wd = this.get(h); if (!wd) return;
    if (!r || !wd.update) { wd.update = null; wd.erase = false; return; }
    const u = wd.update; if (r.l <= u.l && r.t <= u.t && r.r >= u.r && r.b >= u.b) { wd.update = null; wd.erase = false; }
  }
  findPaint(filter: number): Wnd | null {
    // paint parents before children, top windows first
    const visit = (wd: Wnd): Wnd | null => {
      if (!(wd.style & WS_VISIBLE)) return null;
      if ((wd.update || wd.ncPaint) && (!filter || filter === wd.h)) return wd;
      for (const c of wd.children) { const r = visit(c); if (r) return r; }
      return null;
    };
    for (const t of this.tops) { const r = visit(t); if (r) return r; }
    return null;
  }
  // build a DC for window (client or whole window)
  windowDC(wd: Wnd | null, whole = false, clipToUpdate: Rect | null = null): DC {
    const gdi = this.w.gdi;
    if (!wd) { const dc = gdi.makeDC(gdi.screen); dc.hwnd = 0; return dc; }
    const t = this.topOf(wd); const surf = this.ensureSurface(t);
    const [ox, oy] = whole ? this.winOrgOnTop(wd) : this.clientOrgOnTop(wd);
    const cr = whole ? R(0, 0, wd.w, wd.h_) : this.clientRect(wd);
    let clip = R(ox + cr.l, oy + cr.t, ox + cr.r, oy + cr.b);
    // clip to ancestors' client areas
    let c = wd;
    while (c.parent && (c.style & WS_CHILD)) { const p = c.parent; const [px, py] = this.clientOrgOnTop(p); const pr = this.clientRect(p); clip = isect(clip, R(px, py, px + pr.r, py + pr.b)); c = p; }
    if (clipToUpdate) clip = isect(clip, R(ox + clipToUpdate.l, oy + clipToUpdate.t, ox + clipToUpdate.r, oy + clipToUpdate.b));
    const dc = gdi.makeDC(surf, { orgX: ox, orgY: oy, hwnd: wd.h });
    dc.baseClip = clip; dc.clip = clip;
    // exclude visible children (clip children)
    const excl: Rect[] = [];
    if (!whole || true) for (const ch of wd.children) if (ch.style & WS_VISIBLE) { const [cx, cy] = this.winOrgOnTop(ch); excl.push(R(cx, cy, cx + ch.w, cy + ch.h_)); }
    // exclude siblings above (clip siblings) for child windows
    if (wd.parent && (wd.style & WS_CHILD)) {
      for (const s of wd.parent.children) { if (s === wd) break; if (s.style & WS_VISIBLE) { const [sx, sy] = this.winOrgOnTop(s); excl.push(R(sx, sy, sx + s.w, sy + s.h_)); } }
    }
    dc.excl = excl;
    const cls = wd.cls;
    void cls;
    return dc;
  }

  // ---------- defwindowproc ----------
  defProc(h: number, msg: number, wp: number, lp: number): number {
    const wd = this.get(h); if (!wd) return 0;
    const m = this.w.m;
    switch (msg) {
      case WM.NCCREATE: if (lp) { const L = m.lin(lp); const tp = m.mem.r32(L + 22); if (tp) wd.text = m.str(tp); } return 1;
      case WM.NCCALCSIZE: return 0;
      case WM.SETTEXT: wd.text = lp ? m.str(lp) : ''; if (this.isTop(wd)) this.w.platform.setTitle?.(wd.text); return 1;
      case WM.GETTEXT: { if (!lp || !wp) return 0; return m.mem.writeCStr(lp >>> 16, lp & 0xffff, wd.text, wp); }
      case WM.GETTEXTLENGTH: return wd.text.length;
      case WM.PAINT: { const ps = this.w.scratch(32); const dc = this.beginPaint(h, ps); this.endPaint(h, ps); this.w.scratchRelease(ps); void dc; return 0; }
      case WM.ERASEBKGND: {
        const br = wd.cls.brush; if (!br) return 0;
        const dc = this.w.gdi.dcs.get(wp); if (!dc) return 0;
        let hb = br; if (br <= 31) hb = this.w.sysColorBrush(br - 1);
        const cr = this.clientRect(wd);
        this.w.gdi.fillRectDev(dc, R(dc.orgX + cr.l, dc.orgY + cr.t, dc.orgX + cr.r, dc.orgY + cr.b), hb);
        return 1;
      }
      case WM.CLOSE: this.destroy(h); return 0;
      case WM.NCHITTEST: return 1; // HTCLIENT
      case WM.SETCURSOR: {
        if ((lp & 0xffff) === 1) { // HTCLIENT
          if (wd.parent && (wd.style & WS_CHILD)) { if (this.send(wd.parent.h, WM.SETCURSOR, wp, lp)) return 1; }
          if (wd.cls.cursor) { this.setCursor(wd.cls.cursor); return 1; }
          return 0;
        }
        this.setCursor(this.w.arrowCursor); return 0;
      }
      case WM.MOUSEACTIVATE: return 1;
      case WM.ACTIVATE: if ((wp & 0xffff) && !(wd.minimized)) this.setFocus(h); return 0;
      case WM.WINDOWPOSCHANGED: {
        const L = m.lin(lp); const fl = m.mem.r16(L + 12);
        if (!(fl & SWP.NOMOVE)) this.send(h, WM.MOVE, 0, (((wd.y & 0xffff) << 16) | (wd.x & 0xffff)) >>> 0);
        if (!(fl & SWP.NOSIZE)) { const cr = this.clientRect(wd); this.send(h, WM.SIZE, wd.maximized ? 2 : 0, ((cr.b << 16) | cr.r) >>> 0); }
        return 0;
      }
      case WM.SYSCOMMAND: {
        const c = wp & 0xfff0;
        if (c === 0xf060) this.send(h, WM.CLOSE, 0, 0);
        else if (c === 0xf030) this.show(h, 3);
        else if (c === 0xf020) this.show(h, 6);
        else if (c === 0xf120) this.show(h, 9);
        return 0;
      }
      case WM.QUERYENDSESSION: return 1;
      case WM.NCACTIVATE: return 1;
      case WM.GETMINMAXINFO: return 0;
      case WM.SHOWWINDOW: return 0;
      case WM.QUERYNEWPALETTE: return 0;
      case 0x0013: return 1; // WM_QUERYOPEN
      case 0x0017: return 1; // WM_QUERYDRAGICON etc
      case WM.SYSKEYDOWN: if (wp === 0x73 && (lp & 0x20000000)) this.send(h, WM.CLOSE, 0, 0); return 0; // alt+f4
    }
    return 0;
  }

  // ---------- paint API ----------
  beginPaint(h: number, ps: number): number {
    const wd = this.get(h); if (!wd) return 0;
    const m = this.w.m, mem = m.mem; const L = m.lin(ps);
    wd.ncPaint = false;
    const upd = wd.update || R(0, 0, 0, 0);
    const erase = wd.erase;
    wd.update = null; wd.erase = false;
    const dc = this.windowDC(wd, false, upd);
    this.w.dcOwner.set(dc.h, h);
    let fErase = 0;
    if (erase) fErase = this.send(h, WM.ERASEBKGND, dc.h, 0) ? 0 : 1;
    mem.w16(L, dc.h); mem.w16(L + 2, fErase); mem.w16(L + 4, upd.l); mem.w16(L + 6, upd.t); mem.w16(L + 8, upd.r); mem.w16(L + 10, upd.b);
    for (let i = 12; i < 32; i++) mem.u8[L + i] = 0;
    return dc.h;
  }
  endPaint(h: number, ps: number) {
    const m = this.w.m; const L = m.lin(ps); const hdc = m.mem.r16(L);
    this.w.releaseDC(hdc); return 1;
  }

  // ---------- timers ----------
  setTimer(hwnd: number, id: number, ms: number, proc: number): number {
    if (!hwnd) { id = 0x100 + this.timers.length + Math.floor(Math.random() * 1000); }
    this.timers = this.timers.filter(t => !(t.hwnd === hwnd && t.id === id));
    this.timers.push({ hwnd, id, interval: Math.max(ms, 1), proc, next: this.w.platform.now() + this.tInt(Math.max(ms, 1)) });
    return hwnd ? 1 : id;
  }
  killTimer(hwnd: number, id: number) { const n = this.timers.length; this.timers = this.timers.filter(t => !(t.hwnd === hwnd && t.id === id)); return n !== this.timers.length ? 1 : 0; }
  nextTimerDue() { let n = Infinity; for (const t of this.timers) n = Math.min(n, t.next); return n; }

  // ---------- input ----------
  windowAt(x: number, y: number): Wnd | null {
    for (const t of this.tops) {
      if (!(t.style & WS_VISIBLE) || t.w <= 0) continue;
      if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h_) {
        let cur = t;
        for (;;) {
          const [cx, cy] = this.clientToScreen(cur, 0, 0);
          const hit = cur.children.find(c => (c.style & WS_VISIBLE) && x >= cx + c.x && y >= cy + c.y && x < cx + c.x + c.w && y < cy + c.y + c.h_);
          if (!hit) return cur; cur = hit;
        }
      }
    }
    return null;
  }
  enabledChain(wd: Wnd) { let c: Wnd | null = wd; while (c) { if (c.style & WS_DISABLED) return false; if (!(c.style & WS_CHILD)) break; c = c.parent; } return true; }
  processInput() {
    const evs = this.w.platform.pollEvents();
    for (const e of evs) {
      if (e.type === 'quit') { this.w.requestQuit(); continue; }
      if (this.inputFilters.length) { let used = false; for (const f of this.inputFilters) { try { if (f(e as any)) { used = true; break; } } catch { /* mod error */ } } if (used) { if (e.type === 'mousemove') { this.mouseX = e.x!; this.mouseY = e.y!; } continue; } }
      if (e.type === 'mousemove' || e.type === 'mousedown' || e.type === 'mouseup') {
        this.mouseX = e.x!; this.mouseY = e.y!;
        const btn = e.button || 0;
        if (e.type !== 'mousemove') this.keyState[btn === 0 ? 1 : btn === 2 ? 2 : 4] = e.type === 'mousedown' ? 0x80 : 0;
        let target = this.capture ? this.get(this.capture) : this.windowAt(e.x!, e.y!);
        if (e.type !== 'mousemove' && this.inputTrace) {
          const desc = (w: Wnd | null | undefined) => w ? `${w.cls.name}#${w.h.toString(16)}@${w.x},${w.y} ${w.w}x${w.h_}${(w.style & WS_DISABLED) ? ' DISABLED' : ''}${(w.style & 0x10000000) ? '' : ' hidden'}` : 'none';
          const top = target ? this.topOf(target) : null;
          this.inputTrace(`${e.type} b${btn} at ${e.x},${e.y} -> ${desc(target)} top=${desc(top)} enabled=${target ? this.enabledChain(target) : '-'} capture=${this.capture ? desc(this.get(this.capture)) : 'none'} active=${desc(this.get(this.active))} focus=${desc(this.get(this.focus))}`);
        }
        if (!target) continue;
        if (!this.capture && !this.enabledChain(target)) {
          // modal: disabled window receives nothing (beep on click)
          continue;
        }
        if (!this.capture) {
          const hit = this.send(target.h, WM.NCHITTEST, 0, ((e.y! << 16) | (e.x! & 0xffff)) >>> 0);
          let msgCode = 0x200; if (e.type === 'mousedown') msgCode = btn === 0 ? 0x201 : btn === 2 ? 0x204 : 0x207; if (e.type === 'mouseup') msgCode = btn === 0 ? 0x202 : btn === 2 ? 0x205 : 0x208;
          this.send(target.h, WM.SETCURSOR, target.h, ((msgCode << 16) | (hit & 0xffff)) >>> 0);
          if (e.type === 'mousedown') {
            const t = this.topOf(target);
            if (this.active !== t.h) { const r = this.send(target.h, WM.MOUSEACTIVATE, t.h, ((msgCode << 16) | 1) >>> 0); if (r !== 3 && r !== 4) this.activate(t.h, true); }
          }
        }
        const [cx, cy] = this.clientToScreen(target, 0, 0);
        const lx = e.x! - cx, ly = e.y! - cy;
        const lp = (((ly & 0xffff) << 16) | (lx & 0xffff)) >>> 0;
        let wp = 0; if (this.keyState[1] & 0x80) wp |= 1; if (this.keyState[2] & 0x80) wp |= 2; if (this.keyState[0x10] & 0x80) wp |= 4; if (this.keyState[0x11] & 0x80) wp |= 8; if (this.keyState[4] & 0x80) wp |= 0x10;
        let msg = WM.MOUSEMOVE;
        if (e.type === 'mousedown') {
          const now = this.w.platform.now(); const lc = this.lastClick;
          const dbl = (target.cls.style & 8) && lc.b === btn && lc.h === target.h && now - lc.t < 450 && Math.abs(lc.x - e.x!) < 4 && Math.abs(lc.y - e.y!) < 4;
          msg = btn === 0 ? (dbl ? WM.LBUTTONDBLCLK : WM.LBUTTONDOWN) : btn === 2 ? (dbl ? WM.RBUTTONDBLCLK : WM.RBUTTONDOWN) : WM.MBUTTONDOWN;
          this.lastClick = dbl ? { t: 0, x: 0, y: 0, b: -1, h: 0 } : { t: now, x: e.x!, y: e.y!, b: btn, h: target.h };
        } else if (e.type === 'mouseup') msg = btn === 0 ? WM.LBUTTONUP : btn === 2 ? WM.RBUTTONUP : WM.MBUTTONUP;
        // coalesce mouse moves
        if (msg === WM.MOUSEMOVE) { const last = this.queue[this.queue.length - 1]; if (last && last.msg === WM.MOUSEMOVE && last.hwnd === target.h) { last.lp = lp; last.wp = wp; continue; } }
        this.post(target.h, msg, wp, lp);
      } else if (e.type === 'keydown' || e.type === 'keyup') {
        const vk = e.vk! & 0xff;
        if (e.type === 'keydown') this.keyState[vk] = (this.keyState[vk] & 1 ? 0 : 1) | 0x80; else this.keyState[vk] &= 1;
        const alt = (this.keyState[0x12] & 0x80) !== 0;
        const target = this.focus || this.active;
        if (e.type === 'keydown' && this.inputTrace) this.inputTrace(`keydown vk=${vk} -> ${target ? (this.get(target)?.cls.name ?? '?') + '#' + target.toString(16) : 'none'}`);
        if (!target) continue;
        const lp = (1 | ((e.type === 'keyup' ? 0xc000 : 0) << 16) | (alt ? 0x20000000 : 0)) >>> 0;
        const msg = alt || vk === 0x12 ? (e.type === 'keydown' ? WM.SYSKEYDOWN : WM.SYSKEYUP) : (e.type === 'keydown' ? WM.KEYDOWN : WM.KEYUP);
        const q = { hwnd: target, msg, wp: vk, lp, time: this.w.platform.now() | 0, x: this.mouseX, y: this.mouseY, ch: e.char } as any;
        this.queue.push(q);
      }
    }
  }

  // get next message per PeekMessage semantics; returns null if none
  nextMessage(filterH: number, min: number, max: number, remove: boolean): Msg | null {
    this.processInput();
    const inRange = (m: number) => (!min && !max) || (m >= min && m <= max);
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (filterH && q.hwnd !== filterH && !this.isChildOf(this.get(q.hwnd), this.get(filterH)!)) continue;
      if (!inRange(q.msg)) continue;
      if (remove) this.queue.splice(i, 1);
      return q;
    }
    if (this.quit) { const q = { hwnd: 0, msg: WM.QUIT, wp: this.quitCode, lp: 0, time: 0, x: 0, y: 0 }; if (remove) this.quit = false; return q; }
    if (inRange(WM.PAINT)) {
      const p = this.findPaint(filterH);
      if (p) {
        if (!p.update && p.ncPaint) { p.ncPaint = false; this.drawNC(p); if (!p.update) return this.nextMessage(filterH, min, max, remove); }
        return { hwnd: p.h, msg: WM.PAINT, wp: 0, lp: 0, time: this.w.platform.now() | 0, x: this.mouseX, y: this.mouseY };
      }
    }
    if (inRange(WM.TIMER)) {
      const now = this.w.platform.now();
      for (const t of this.timers) {
        if (t.next <= now && (!filterH || t.hwnd === filterH)) {
          if (remove) { t.next = now + this.tInt(t.interval); }
          return { hwnd: t.hwnd, msg: WM.TIMER, wp: t.id, lp: t.proc, time: now | 0, x: this.mouseX, y: this.mouseY };
        }
      }
    }
    return null;
  }
  hasWork(): boolean {
    this.processInput();
    if (this.queue.length || this.quit) return true;
    if (this.findPaint(0)) return true;
    return this.nextTimerDue() <= this.w.platform.now();
  }
  waitForWork() {
    while (!this.hasWork() && !this.w.exited) {
      this.w.present();
      const due = this.nextTimerDue();
      const ms = Math.max(0, Math.min(isFinite(due) ? due - this.w.platform.now() : 50, 50));
      this.w.platform.wait(ms); this.w.lastIdle = this.w.platform.now();
      this.w.mmTick();
    }
  }
  writeMsg(p: number, q: Msg) {
    const m = this.w.m; const L = m.lin(p); const mem = m.mem;
    mem.w16(L, q.hwnd); mem.w16(L + 2, q.msg); mem.w16(L + 4, q.wp); mem.w32(L + 6, q.lp); mem.w32(L + 10, q.time); mem.w16(L + 14, q.x); mem.w16(L + 16, q.y);
    (this as any).lastChar = (q as any).ch;
    if ((q as any).ch !== undefined) this.pendingChar.set(L, (q as any).ch);
  }
  pendingChar = new Map<number, number>();

  dispatch(p: number): number {
    const m = this.w.m; const L = m.lin(p); const mem = m.mem;
    const hwnd = mem.r16(L), msg = mem.r16(L + 2), wp = mem.r16(L + 4), lp = mem.r32(L + 6);
    if (msg === WM.TIMER && lp) { return m.callFar(lp, [[hwnd, 2], [msg, 2], [wp, 2], [mem.r32(L + 10), 4]], this.w.mainModule.autoDS); }
    const wd = this.get(hwnd); if (!wd) return 0;
    if (msg === WM.PAINT) { const r = this.send(hwnd, msg, wp, lp); if (wd.update && this.wnds.has(hwnd)) { wd.update = null; wd.erase = false; } return r; }
    return this.send(hwnd, msg, wp, lp);
  }

  // ---------- non-client drawing (simple Win3.1 look) ----------
  drawNC(wd: Wnd) {
    const { b, cap } = this.ncMetrics(wd); if (!b && !cap) return;
    const gdi = this.w.gdi; const dc = this.windowDC(wd, true);
    dc.excl = [];
    const [ox, oy] = this.winOrgOnTop(wd);
    const fill = (l: number, t: number, r: number, bb: number, c: number) => { const br = gdi.alloc({ type: 'brush', style: 0, color: c }); gdi.fillRectDev(dc, R(ox + l, oy + t, ox + r, oy + bb), br); gdi.objs.delete(br); };
    if (b) { fill(0, 0, wd.w, b, 0xc0c0c0); fill(0, wd.h_ - b, wd.w, wd.h_, 0xc0c0c0); fill(0, 0, b, wd.h_, 0xc0c0c0); fill(wd.w - b, 0, wd.w, wd.h_, 0xc0c0c0); }
    if (b === 1) { fill(0, 0, wd.w, 1, 0); fill(0, wd.h_ - 1, wd.w, wd.h_, 0); fill(0, 0, 1, wd.h_, 0); fill(wd.w - 1, 0, wd.w, wd.h_, 0); }
    if (cap) { fill(b, b, wd.w - b, b + cap, this.active === wd.h ? 0x800000 : 0xffffff); this.w.drawTextSimple(dc, ox + b + 22, oy + b + 3, wd.text, this.active === wd.h ? 0xffffff : 0); }
    this.w.releaseDC(dc.h);
  }

  // ---------- cursors ----------
  setCursor(h: number): number { const p = this.cursor; this.cursor = h; this.w.platform.setCursor(this.w.cursorImage(h)); return p; }

  // ---------- text ----------
  fontFor(dc: DC) {
    const f: any = this.w.gdi.objs.get(dc.font) || { height: 16, weight: 400 };
    let key = f._key as string | undefined;
    if (!key) {
      const face = String(f.face || 'System').toUpperCase();
      const isSystem = face === 'SYSTEM' || face === '';
      const bold = isSystem || (f.weight ?? 400) >= 600; let hgt = isSystem ? 16 : (f.height ?? 16);
      if (hgt < 0) hgt = Math.round(-hgt * 1.2); if (hgt === 0) hgt = 16;
      const sizes = [8, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
      let best = sizes[0]; for (const s of sizes) if (Math.abs(s - hgt) < Math.abs(best - hgt)) best = s;
      key = (bold ? 'b' : 'r') + best; f._key = key;
    }
    const F = FONTS[key];
    if (!(F as any)._bits) (F as any)._bits = Uint8Array.from(atob(F.d), c => c.charCodeAt(0));
    return F as typeof F & { _bits: Uint8Array };
  }
  textWidth(dc: DC, s: string) { const F = this.fontFor(dc); let w = 0; for (let i = 0; i < s.length; i++) w += F.w[s.charCodeAt(i) & 0xff]; return w; }
  drawString(dc: DC, x: number, y: number, s: string) {
    // x,y device coords (top-left of cell)
    const F = this.fontFor(dc); const gdi = this.w.gdi; const surf = dc.surface;
    const fg = gdi.colorIndex(dc, dc.text), bg = gdi.colorIndex(dc, dc.bk);
    const tw = this.textWidth(dc, s);
    const box = R(x, y, x + tw, y + F.h);
    const rects = gdi.clipRects(dc, box);
    if (!rects.length) return tw;
    const opaque = dc.bkMode === 2;
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i) & 0xff; const gw = F.w[c]; const bw = (gw + 7) >> 3; const off = F.o[c];
      for (let row = 0; row < F.h; row++) {
        let bits = 0; for (let k = 0; k < bw; k++) bits |= F._bits[off + row * bw + k] << (8 * k);
        const py = y + row;
        for (let col = 0; col < gw; col++) {
          const px = cx + col; const on = (bits >> col) & 1;
          if (!on && !opaque) continue;
          for (const r of rects) if (px >= r.l && px < r.r && py >= r.t && py < r.b) { surf.data[py * surf.w + px] = on ? fg : bg; break; }
        }
      }
      cx += gw;
    }
    gdi.dirty(dc, box);
    return tw;
  }
}
