// Worker-side mod runtime: file overlays, scripted hooks, code/form patching, API wrapping.
import type { ActiveMod } from './types';
import type { Win16 } from '../win16/win16';
import type { FSProvider } from '../win16/vfs';
import { parseDfm, writeDfm, findComponent, setProp, getProp, DfmComponent } from './dfm';

type FileHook = (drive: string, path: string, read: () => Uint8Array | null) => Uint8Array | null | undefined | void; // hooks chain: read() gives the previous result
type LoadHook = (ctx: LoadContext) => void;
export interface LoadContext {
  lang: string;
  segment(n: number): { sel: number; base: number; size: number };
  read(seg: number, off: number, len: number): Uint8Array;
  find(hex: string, seg?: number): { seg: number; off: number }[];
  patch(seg: number, off: number, expect: string | null, replace: string): boolean;
  editForm(name: string, fn: (form: FormEditor) => void): boolean;
  dataSegment(): number;
  allocCode(hex: string): { sel: number; off: number };          // place code in a mod-owned code segment
  allocData(size: number): { sel: number; off: number; lin: number }; // zeroed memory for mod data
  readFile(path: string): Uint8Array | null;                      // read any game file (e.g. 'D:\\DATA\\DARSTELL.DAT')
}
export interface FormEditor {
  root: DfmComponent;
  component(name: string): ComponentEditor | null;
  components(): ComponentEditor[];
}
export interface ComponentEditor { name: string; cls: string; get(k: string): any; set(k: string, v: any): void; node: DfmComponent; }

export interface CompositorOptions { shadows?: boolean; fadeMs?: number; dim?: number; trueColorVideo?: boolean; excludeClasses?: string[]; }

const hex = (s: string) => Uint8Array.from((s.replace(/[^0-9a-f?]/gi, '').match(/.{2}/g) || []).map(x => x === '??' ? -1 : parseInt(x, 16)) as any as number[]);
const patternOf = (s: string) => (s.replace(/\s+/g, '').match(/.{2}/g) || []).map(x => (x === '??' ? -1 : parseInt(x, 16)));

export class ModRuntime {
  fileHooks: FileHook[] = [];
  loadHooks: { mod: string; fn: LoadHook }[] = [];
  tickHooks: ((now: number) => void)[] = [];
  /** commands from ui.js scripts ([mod index, command, argument]), delivered in tick() */
  pendingCommands: [number, number, number][] = [];
  commandHooks = new Map<string, ((cmd: number, arg: number) => void)[]>();
  apiWraps: { name: string; fn: (args: number[], orig: (a: number[]) => any) => any }[] = [];
  startHooks: (() => void)[] = [];
  drawHooks: ((px: Uint32Array, w: number, h: number) => void)[] = [];
  inputFilters: ((e: any) => boolean)[] = [];
  speedBase = 1; speedOnly = 100; speedHolds = new Map<string, number>();
  applySpeed() {
    if (!this.w) return;
    const holds = [...this.speedHolds.values()];
    const f = holds.length ? (holds.includes(0) ? 0 : Math.max(...holds)) : this.speedBase;
    this.w.user.setTimerScale(f, this.speedOnly);
  }
  screen: { w: number; h: number } | null = null;
  host = { w: 1280, h: 800 };
  toUI: (data: any) => void = () => {};   // delivers to ui.js scripts (api.onMessage)   // size of the player's window/screen in CSS pixels (set by the platform)
  compositor: CompositorOptions = {};
  private codeBlock: { sel: number; base: number; top: number } | null = null;
  overlayHD = new Map<string, Uint8Array>();
  overlayCD = new Map<string, Uint8Array>();
  w!: Win16;
  log: (s: string) => void;

  constructor(public mods: ActiveMod[], public lang: string, log: (s: string) => void, host?: { w: number; h: number }) {
    this.log = log; if (host) this.host = host;
    for (const m of mods) {
      for (const f of m.files) {
        const p = f.path.replace(/\\/g, '/');
        const lp = p.toLowerCase();
        if (lp.startsWith('cd/')) this.overlayCD.set(p.slice(3).replace(/\//g, '\\').toUpperCase(), f.data);
        else if (lp.startsWith('hd/')) this.overlayHD.set(p.slice(3).replace(/\//g, '\\').toUpperCase(), f.data);
      }
      if (m.manifest.script) {
        const f = m.files.find(x => x.path === m.manifest.script);
        if (!f) { log(`[mod ${m.manifest.id}] script ${m.manifest.script} missing`); continue; }
        try {
          const code = new TextDecoder().decode(f.data);
          new Function('api', '"use strict";\n' + code + `\n//# sourceURL=mod-${m.manifest.id}.js`)(this.makeApi(m));
        } catch (e: any) { log(`[mod ${m.manifest.id}] script error: ${e?.message || e}`); }
      }
    }
  }

  private makeApi(m: ActiveMod) {
    const rt = this; const id = m.manifest.id;
    return {
      id, lang: this.lang, settings: { ...m.settings },
      log: (...a: any[]) => rt.log(`[${id}] ` + a.join(' ')),
      file: (path: string) => m.files.find(x => x.path.toLowerCase() === path.toLowerCase())?.data ?? null,
      text: (path: string) => { const d = m.files.find(x => x.path.toLowerCase() === path.toLowerCase())?.data; return d ? new TextDecoder('latin1').decode(d) : null; },
      get host() { return { ...rt.host }; },
      toUI: (data: any) => rt.toUI({ mod: id, data }),
      setScreenSize: (w: number, h: number) => { rt.screen = { w: Math.min(3840, Math.max(640, w | 0)), h: Math.min(2160, Math.max(480, h | 0)) }; },
      onFile: (fn: FileHook) => { rt.fileHooks.push(fn); },
      onLoad: (fn: LoadHook) => { rt.loadHooks.push({ mod: id, fn }); },
      onStart: (fn: () => void) => { rt.startHooks.push(fn); },
      onTick: (fn: (now: number) => void) => { rt.tickHooks.push(fn); },
      onCommand: (fn: (cmd: number, arg: number) => void) => { (rt.commandHooks.get(id) || rt.commandHooks.set(id, []).get(id)!).push(fn); },
      getSpeed: () => rt.speedBase,
      // fast-forward helper: the game skips most of its drawing (RectVisible reports nothing visible)
      skipDrawing: (on: boolean) => { rt.w.gdi.skipDraw = !!on; },
      wrapApi: (name: string, fn: (args: number[], orig: (a: number[]) => any) => any) => { rt.apiWraps.push({ name, fn }); },
      compositor: (o: CompositorOptions) => { Object.assign(rt.compositor, o); },
      get win16() { return rt.w; },
      get mem() { return rt.memApi(); },
      windows: () => rt.windows(),
      // game speed: the game's short timers (its tick) run this many times faster (1 = normal)
      // The player's choice (the speed buttons) is the base; a mod can hold the speed for a while
      // (fast-forward, freeze time) with holdSpeed, and when it lets go the player's choice is back.
      setSpeed: (f: number, onlyInterval = 0) => { rt.speedBase = f === 0 ? 0 : Math.max(0.25, Math.min(100, +f || 1)); rt.speedOnly = Math.max(0, onlyInterval | 0); rt.applySpeed(); },
      // hold the game speed (0 = stopped, else a factor) until holdSpeed(null); a stop wins over a fast hold
      holdSpeed: (f: number | null, onlyInterval = 100) => { if (f === null) rt.speedHolds.delete(id); else rt.speedHolds.set(id, f === 0 ? 0 : Math.max(0.25, Math.min(100, +f || 1))); if (f !== null) rt.speedOnly = Math.max(0, onlyInterval | 0) || rt.speedOnly; rt.applySpeed(); },
      // the speed the game runs at now (base or a hold); speedHeld: whether a mod holds it
      get speedNow() { return rt.w ? rt.w.user.timerScale : rt.speedBase; },
      get speedHeld() { return rt.speedHolds.size > 0; },
      // draw on top of the composed frame: fn(pixels: Uint32Array ABGR, width, height)
      onDraw: (fn: (px: Uint32Array, w: number, h: number) => void) => { rt.drawHooks.push(fn); if (rt.w) rt.w.drawHooks.push(fn); },
      // see input before the game: fn({ type: 'mousemove'|'mousedown'|'mouseup'|'keydown'|'keyup', x, y, button, vk }) -> true to consume
      onInput: (fn: (e: any) => boolean) => { rt.inputFilters.push(fn); if (rt.w) rt.w.user.inputFilters.push(fn); },
      // ask for a new frame (after changing what onDraw draws)
      redraw: () => { if (rt.w) (rt.w as any).lastPresent = 0; },
      // call game code (far pascal procedure). Only do this from a safe point, e.g. inside a wrapped
      // USER.GetMessage / USER.PeekMessage at the top-level message loop. args: [value, bytes][]
      call: (sel: number, off: number, args: [number, number][] = []) => rt.w.m.callFar((((sel & 0xffff) << 16) | (off & 0xffff)) >>> 0, args, rt.w.mainModule.autoDS),
      // the game's hard disk (C:\HOLIDAY ...): list a folder, read, delete. Changes are saved like the game's own files.
      disk: {
        list: (dir: string) => (rt.w.vfs.fs('C')?.list(dir.replace(/^C:\\/i, '')) || []).map((e: any) => ({ name: e.name, dir: !!e.dir, size: e.size })),
        read: (p: string) => rt.w.vfs.read(/^[a-z]:/i.test(p) ? p : 'C:\\' + p),
        remove: (p: string) => { const f: any = rt.w.vfs.fs('C'); return !!f?.remove?.(p.replace(/^C:\\/i, '')); },
      },
      postKey: (vk: number, ch = 0) => { rt.w.user.queue.push({ hwnd: rt.w.user.focus || rt.w.user.active, msg: 0x100, wp: vk, lp: 1, time: 0, x: 0, y: 0, ch } as any); rt.w.user.queue.push({ hwnd: rt.w.user.focus || rt.w.user.active, msg: 0x101, wp: vk, lp: 0xc0000001, time: 0, x: 0, y: 0 } as any); },
    };
  }
  memApi() {
    const mem = this.w.m.mem;
    return {
      lin: (sel: number, off: number) => mem.lin(sel, off), u8: mem.u8,
      r8: (sel: number, off: number) => mem.u8[mem.lin(sel, off)], r16: (sel: number, off: number) => mem.r16(mem.lin(sel, off)),
      w8: (sel: number, off: number, v: number) => { mem.u8[mem.lin(sel, off)] = v; }, w16: (sel: number, off: number, v: number) => mem.w16(mem.lin(sel, off), v),
      ds: () => this.w.mainModule.autoDS, seg: (n: number) => this.w.mainModule.segSels[n - 1],
    };
  }
  windows() {
    const u = this.w.user;
    const all: any[] = [];
    const visit = (wd: any) => { all.push({ h: wd.h, cls: wd.cls.name, x: wd.x, y: wd.y, w: wd.w, h_: wd.h_, visible: !!(wd.style & 0x10000000), setPos: (x: number, y: number, cw: number, ch: number) => u.setPos(wd, 0, x, y, cw, ch, 0x14) }); wd.children.forEach(visit); };
    u.tops.forEach(visit);
    return all;
  }

  // ---- integration points ----
  attach(w: Win16) {
    this.w = w;
    if (this.compositor) w.compositor = this.compositor;
    w.drawHooks.push(...this.drawHooks); w.user.inputFilters.push(...this.inputFilters);
    // API wrapping
    for (const wr of this.apiWraps) {
      const [mod, name] = wr.name.split('.');
      const tbl = w.m.nativeModules.get(mod.toUpperCase());
      const def = tbl ? [...tbl.values()].find(d => d.name.toLowerCase() === name.toLowerCase()) : undefined;
      if (!def) { this.log(`wrapApi: ${wr.name} not found`); continue; }
      const orig = def.fn; def.fn = (a: number[]) => wr.fn(a, orig);
    }
    // file hooks on the VFS
    if (this.fileHooks.length) {
      const hooks = this.fileHooks; const vfs = w.vfs; const base = vfs.read.bind(vfs);
      vfs.read = (p: string) => {
        const [d, r] = vfs.resolve(p); let cur: Uint8Array | null | undefined;
        const get = () => (cur === undefined ? (cur = base(p)) : cur);
        for (const h of hooks) { try { const x = h(d, r, get); if (x) cur = x; } catch (e: any) { this.log(`file hook error (${p}): ${e?.message || e}`); } }
        return cur === undefined ? base(p) : cur;
      };
    }
  }
  wrapFS(drive: 'C' | 'D', fs: FSProvider): FSProvider {
    const ov = drive === 'D' ? this.overlayCD : null;
    if (!ov || !ov.size) return fs;
    return {
      readonly: fs.readonly,
      read: (p) => ov.get(p) ?? fs.read(p),
      isDir: (p) => fs.isDir(p),
      list: (dir) => {
        const l = fs.list(dir); if (!l) return l;
        const pre = dir ? dir + '\\' : '';
        for (const [k, v] of ov) if (k.startsWith(pre) && !k.slice(pre.length).includes('\\') && !l.some(e => e.name === k.slice(pre.length))) l.push({ name: k.slice(pre.length), dir: false, size: v.length });
        return l;
      },
    };
  }
  applyLoad() {
    const w = this.w; const mod = w.mainModule; const mem = w.m.mem;
    const segs = mod.segSels;
    const ctx = (modId: string): LoadContext => ({
      lang: this.lang,
      segment: (n) => { const sel = segs[n - 1]; const d = mem.getDesc(sel)!; return { sel, base: d.base, size: d.limit + 1 }; },
      read: (seg, off, len) => mem.u8.slice(mem.lin(segs[seg - 1], off), mem.lin(segs[seg - 1], off) + len),
      dataSegment: () => segs.indexOf(mod.autoDS) + 1,
      allocCode: (h) => {
        if (!this.codeBlock) { const b = mem.allocBlock(0x10000, true); this.codeBlock = { sel: b.sel, base: b.base, top: 0 }; }
        const cb = this.codeBlock; const bytes = hex(h); const off = cb.top;
        mem.u8.set(bytes, cb.base + off); cb.top = (off + bytes.length + 15) & ~15; return { sel: cb.sel, off };
      },
      allocData: (size) => { const b = mem.allocBlock(Math.max(16, size)); return { sel: b.sel, off: 0, lin: b.base }; },
      readFile: (p) => w.vfs.read(p),
      find: (h, seg) => {
        const pat = patternOf(h); const out: { seg: number; off: number }[] = [];
        for (let s = 1; s <= segs.length; s++) {
          if (seg && s !== seg) continue;
          const d = mem.getDesc(segs[s - 1])!; const b = d.base, n = d.limit + 1;
          outer: for (let i = 0; i + pat.length <= n; i++) { for (let k = 0; k < pat.length; k++) if (pat[k] >= 0 && mem.u8[b + i + k] !== pat[k]) continue outer; out.push({ seg: s, off: i }); }
        }
        return out;
      },
      patch: (seg, off, expect, replace) => {
        const a = mem.lin(segs[seg - 1], off);
        if (expect) { const e = patternOf(expect); for (let k = 0; k < e.length; k++) if (e[k] >= 0 && mem.u8[a + k] !== e[k]) { this.log(`[${modId}] patch ${seg}:${off.toString(16)} mismatch, skipped`); return false; } }
        const r = hex(replace); mem.u8.set(r, a); return true;
      },
      editForm: (name, fn) => {
        for (const r of mod.resources) {
          if (r.type !== 10 || typeof r.id !== 'string') continue;
          if (String.fromCharCode(...r.data.subarray(0, 4)) !== 'TPF0') continue;
          const root = parseDfm(r.data);
          if (root.cls.toLowerCase() !== name.toLowerCase() && root.name.toLowerCase() !== name.toLowerCase() && String(r.id).toLowerCase() !== name.toLowerCase()) continue;
          const ed = (c: DfmComponent): ComponentEditor => ({ name: c.name, cls: c.cls, get: (k) => getProp(c, k), set: (k, v) => setProp(c, k, v), node: c });
          const all: ComponentEditor[] = []; const walk = (c: DfmComponent) => { all.push(ed(c)); c.children.forEach(walk); }; walk(root);
          fn({ root, component: (n) => { const c = findComponent(root, n); return c ? ed(c) : null; }, components: () => all });
          r.data = writeDfm(root);
          return true;
        }
        this.log(`[${modId}] form ${name} not found`); return false;
      },
    });
    for (const h of this.loadHooks) { try { h.fn(ctx(h.mod)); } catch (e: any) { this.log(`[${h.mod}] onLoad error: ${e?.message || e}`); } }
    for (const h of this.startHooks) { try { h(); } catch (e: any) { this.log(`onStart error: ${e?.message || e}`); } }
  }
  /** deliver commands from ui.js now; also called while the game waits for messages (a paused game never leaves GetMessage) */
  deliverCommands() {
    if (!this.pendingCommands.length) return;
    while (this.pendingCommands.length) {
      const [i, cmd, arg] = this.pendingCommands.shift()!; const id = this.mods[i]?.manifest.id;
      for (const fn of (id && this.commandHooks.get(id)) || []) { try { fn(cmd, arg); } catch (e: any) { this.log(`[${id}] command error: ${e?.message || e}`); } }
    }
    // wake the game's message loop so work the mod queued for it runs now
    // (no wake-up message: the work runs on the next GetMessage/PeekMessage)
  }
  tick(now: number) {
    this.deliverCommands();
    for (const t of this.tickHooks) { try { t(now); } catch (e: any) { this.log(`tick error: ${e?.message || e}`); } } }
}
