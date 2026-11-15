import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Win16 } from '../win16/win16';
import { MemFS } from '../win16/vfs';
import { openISO, openMDS, openCUE, Disc, ByteSource } from '../assets/disc';
import { buildInstall, DiscFS } from '../assets/install';
import { ModRuntime } from '../mods/runtime';
import type { ActiveMod } from '../mods/types';
import type { Platform, InputEvent } from '../win16/platform';
import { CPUFault } from '../core/cpu';

function png(rgba: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); const crc = zlib.crc32(Buffer.concat([Buffer.from(t), d])); b.writeUInt32BE(crc >>> 0, 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function addDir(fsys: MemFS, dir: string, prefix: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) addDir(fsys, p, prefix + e.name + '\\'); else fsys.add(prefix + e.name, new Uint8Array(fs.readFileSync(p)));
  }
}

const args = process.argv.slice(2);
const opt = (k: string, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const langOpt = opt('lang', 'en');
const maxMs = parseInt(opt('ms', '20000'));
const outDir = opt('out', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const script: { at: number; ev: InputEvent }[] = opt('script') ? JSON.parse(fs.readFileSync(opt('script'), 'utf8')) : [];

let virtTime = 0; let waitTotal = 0; let lastReport = 0; let lastWait = 0; let lastInstr = 0; // virtual clock in ms, advanced by wait() and per-instruction
const events: InputEvent[] = [];
let lastFrame: Uint8Array | null = null; let lastW = 640, lastH = 480;
const shotEvery = parseInt(opt('shotEvery', '2000')); let nextShot = shotEvery;
const logLines: string[] = [];
const platform: Platform = {
  now: () => virtTime,
  wait: (ms) => { virtTime += Math.max(ms, 1); waitTotal += Math.max(ms, 1); if (virtTime > maxMs) { (globalThis as any).W?.exit(0); } },
  pollEvents: () => { while (script.length && script[0].at <= virtTime) events.push(script.shift()!.ev); return events.splice(0); },
  present: (rgba, w, h) => { lastFrame = rgba; lastW = w; lastH = h; if (virtTime >= nextShot) { fs.writeFileSync(path.join(outDir, `t${String(Math.floor(virtTime / 1000)).padStart(4, '0')}.png`), png(rgba, w, h)); nextShot = virtTime + shotEvery; } },
  setCursor: () => {},
  messageBox: (t, c, ty) => { console.log(`MESSAGEBOX [${c}] ${t} type=${ty}`); const k = ty & 0xf; return k === 0 ? 1 : k === 4 ? 7 : k === 2 ? 3 : 2; },
  log: (s) => { logLines.push(s); if (!opt('quiet')) console.log(s); },
  audio: { playPCM: (ch, pcm, rate, loop) => { if (args.includes('--audiolog')) console.log(`audio ch${ch} ${pcm.length} @${rate} loop=${loop}`); }, stopChannel: () => {}, isPlaying: () => false, setMasterVolume: () => {} },
  midi: { play: (d) => console.log(`MIDI play ${d.length} bytes`), stop: () => {}, pause: () => {}, resume: () => {}, isPlaying: () => true, positionMs: () => 0, lengthMs: () => 120000, setVolume: () => {} },
  cd: null,
};

const loadModDir = (dir: string, settings: Record<string, any> = {}): ActiveMod => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
  const files: { path: string; data: Uint8Array }[] = [];
  const walk = (d: string, pre: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + '/'); else files.push({ path: pre + e.name, data: new Uint8Array(fs.readFileSync(path.join(d, e.name))) }); } };
  walk(dir, '');
  const s: Record<string, any> = {}; for (const st of manifest.settings || []) s[st.key] = st.default; Object.assign(s, settings);
  return { manifest, files, settings: s };
};
const modList: ActiveMod[] = opt('mods') ? opt('mods').split(/,(?![^{]*})/).map(m => { const i = m.indexOf('='); const id = i < 0 ? m : m.slice(0, i), js = i < 0 ? '' : m.slice(i + 1); return loadModDir(path.join('web/mods', id), js ? JSON.parse(js) : {}); }) : [];
const res = opt('res', '640x480').split('x').map(Number);
let rt: ModRuntime | null = null;
let C: MemFS; let Dfs: any; let lang = 'en';
if (opt('disc')) {
  const dp = opt('disc');
  const fileSrc = (p: string): ByteSource => { const fd = fs.openSync(p, 'r'); const size = fs.fstatSync(fd).size; return { size, read: (o, l) => { const b = Buffer.alloc(Math.max(0, Math.min(l, size - o))); fs.readSync(fd, b, 0, b.length, o); return new Uint8Array(b.buffer, b.byteOffset, b.length); } }; };
  let disc: Disc;
  if (dp.toLowerCase().endsWith('.mds')) disc = openMDS(new Uint8Array(fs.readFileSync(dp)), fileSrc(dp.replace(/\.mds$/i, '.mdf')));
  else if (dp.toLowerCase().endsWith('.cue')) disc = openCUE(fs.readFileSync(dp, 'utf8'), (n) => { const f = path.join(path.dirname(dp), n.replace(/^.*[\\/]/, '')); return fs.existsSync(f) ? fileSrc(f) : null; });
  else disc = openISO(fileSrc(dp));
  const t0 = Date.now();
  const inst = buildInstall(disc);
  console.log(`install built in ${Date.now() - t0}ms lang=${inst.lang} files=${inst.C.files.size} tracks=${disc.tracks.map(t => `${t.num}${t.audio ? 'A' : 'D'}:${t.sectors}`).join(',')}`);
  C = inst.C; lang = inst.lang; Dfs = new DiscFS(disc);
} else {
  console.error('usage: harness --disc <image.iso|image.mds|image.cue> [--ms N] [--script input.json] [--mods id[=json],...] [--out dir]');
  process.exit(2);
}
rt = new ModRuntime(modList, lang, (s) => console.log(s), opt('host') ? { w: +opt('host').split('x')[0], h: +opt('host').split('x')[1] } : undefined);
for (const [p, d] of rt.overlayHD) C.add('HOLIDAY\\' + p, d);
const scr = rt.screen || { w: res[0], h: res[1] };
const w = new Win16(platform, { screenW: scr.w, screenH: scr.h }); (globalThis as any).W = w;
w.vfs.mount('D', rt.wrapFS('D', Dfs));
w.vfs.mount('C', C);
w.vfs.curDrive = 'C'; w.vfs.curDir.set('C', 'HOLIDAY');
w.traceFiles = args.includes('--files'); w.traceDos = args.includes('--dos'); w.m.apiTrace = args.includes('--api'); w.traceMCI = args.includes('--mci'); w.traceFree = args.includes('--free');
const exe = C.read('HOLIDAY\\HOLIDAY.EXE')!;
rt.attach(w);
w.load('C:\\HOLIDAY\\HOLIDAY.EXE', exe);
rt.applyLoad();
w.begin();
const cpu = w.m.cpu;
const t0 = Date.now();
if (opt('bp')) {
  const bps = opt('bp').split(',').map(x => { const [sg, off, name] = x.split(':'); return { sel: w.mainModule.segSels[+sg - 1], off: parseInt(off, 16), name: name || x }; });
  cpu.trace = (c) => { for (const b of bps) if (c.cs === b.sel && c.ip === b.off) { const retIp = c.stk16(0), retCs = c.stk16(2); const seg = w.mainModule.segSels.indexOf(retCs) + 1; console.log(`BP ${b.name} t=${virtTime | 0} from ${seg}:${retIp.toString(16)} args=${[4, 6, 8, 10].map(o => c.stk16(o).toString(16)).join(',')}`); } };
}
if (opt('watch')) {
  const wa = w.m.mem.lin(w.mainModule.autoDS, parseInt(opt('watch'), 16)); let last = w.m.mem.r16(wa), pcs = 0, pip = 0; const prev = cpu.trace;
  cpu.trace = (c) => { if (prev) prev(c); const v = w.m.mem.r16(wa); if (v !== last) { console.log(`WATCH ${opt('watch')} ${last.toString(16)} -> ${v.toString(16)} t=${virtTime | 0} after seg${w.mainModule.segSels.indexOf(pcs) + 1}:${pip.toString(16)} (cs=${pcs.toString(16)})`); last = v; } pcs = c.cs; pip = c.ip; };
}
let lastStepTime = 0;
try {
  while (!w.exited && virtTime < maxMs) {
    if (opt('corruptAt') && virtTime >= parseInt(opt('corruptAt')) && !(globalThis as any).corrupted) { (globalThis as any).corrupted = 1; const a = w.m.mem.lin(w.mainModule.autoDS, 0x7804); console.log('corrupting, old sel', w.m.mem.r16(a).toString(16)); w.m.mem.w16(a, 0x3ff7); }
    if (opt('fixAt') && virtTime >= parseInt(opt('fixAt')) && (globalThis as any).corrupted === 1) { (globalThis as any).corrupted = 2; }
    if (!w.runSlice(10000)) break;
    rt.tick(virtTime);
    virtTime += 0.5; // ~20M instr/s virtual speed
    if (opt('fitAt') && virtTime >= parseInt(opt('fitAt')) && !(globalThis as any).fitted) {
      for (const t of w.user.tops) if (t.cls.name === 'THauptschirm' && (t.style & 0x10000000)) { (globalThis as any).fitted = 1; w.user.setPos(t, 0, 0, 0, w.screenW, w.screenH, 0x14); const a = w.m.mem.lin(w.mainModule.autoDS, 0x12bc); if (opt('viewW')) { w.m.mem.w16(a, +opt('viewW')); w.m.mem.w16(a + 2, +opt('viewH')); } console.log('fitted main window'); }
    }
    if (args.includes('--perf') && virtTime - lastReport >= 5000) { const busy = 1 - (waitTotal - lastWait) / (virtTime - lastReport); console.log(`perf t=${(virtTime / 1000) | 0}s busy=${(busy * 100).toFixed(0)}% instr/s(virtual)=${((cpu.icount - lastInstr) / ((virtTime - lastReport) / 1000) / 1e6).toFixed(1)}M`); lastReport = virtTime; lastWait = waitTotal; lastInstr = cpu.icount; }
    if (cpu.halted) break;
  }
} catch (e: any) {
  console.log('FAULT:', e.message);
  console.log('at', cpu.cs.toString(16), cpu.curInstIp.toString(16), 'ax', cpu.ax.toString(16), 'bx', cpu.bx.toString(16), 'cx', cpu.cx.toString(16), 'dx', cpu.dx.toString(16), 'si', cpu.si.toString(16), 'di', cpu.di.toString(16), 'ds', cpu.ds.toString(16), 'es', cpu.es.toString(16), 'ss:sp', cpu.ss.toString(16), cpu.sp.toString(16), 'bp', cpu.bp.toString(16));
  const segIdx = w.mainModule.segSels.indexOf(cpu.cs); console.log('segment#', segIdx + 1);
  const dump = (sel: number, off: number, n = 64) => { try { const a = w.m.mem.lin(sel, off); const d = w.m.mem.getDesc(sel); console.log(`dump ${sel.toString(16)}:${off.toString(16)} base=${d?.base.toString(16)} lim=${d?.limit.toString(16)}`, Buffer.from(w.m.mem.u8.subarray(a, a + n)).toString('hex'), JSON.stringify(Buffer.from(w.m.mem.u8.subarray(a, a + n)).toString('latin1'))); } catch (e) { console.log('dump fail', sel.toString(16)); } };
  dump(cpu.es, cpu.di); dump(cpu.ds, 0x4840, 32); for (const [i, s] of w.mainModule.segSels.entries()) if (s === cpu.es) console.log('es is segment', i + 1);
  (globalThis as any).dump = dump;
  console.log('recent API:', w.m.callHistory.slice(-30).join(' '));
  if (!(e instanceof CPUFault)) console.log(e.stack);
}
if (opt('dumpds')) { const [o, n] = opt('dumpds').split(',').map(x => parseInt(x, 16)); const a = w.m.mem.lin(w.mainModule.autoDS, o); const r: string[] = []; for (let i = 0; i < n; i++) { const e = a + i * 10; r.push(`${i}: flag=${w.m.mem.r16(e)} L=${(w.m.mem.r16(e + 2) << 16) >> 16} T=${(w.m.mem.r16(e + 4) << 16) >> 16} W=${w.m.mem.r16(e + 6)} H=${w.m.mem.r16(e + 8)}`); } console.log(r.join('\n')); }
if (args.includes('--bitmaps')) { for (const [h, o] of w.gdi.objs) if (o.type === 'bitmap' && o.surf && o.surf.w >= 400) console.log('bitmap', h.toString(16), o.surf.w, 'x', o.surf.h); }
console.log(`done: virt ${virtTime | 0}ms real ${Date.now() - t0}ms instr ${cpu.icount} exited=${w.exited}`);
const dumpWnd = (wd: any, ind: string) => { console.log(`${ind}${wd.h.toString(16)} ${wd.cls.name} "${wd.text}" ${wd.x},${wd.y} ${wd.w}x${wd.h_} style=${(wd.style>>>0).toString(16)} ex=${wd.ex.toString(16)} vis=${(wd.style & 0x10000000)?1:0}`); for (const c of wd.children) dumpWnd(c, ind + '  '); };
if (args.includes('--wnds')) for (const t of w.user.tops) dumpWnd(t, '');
if (lastFrame) fs.writeFileSync(path.join(outDir, 'last.png'), png(lastFrame, lastW, lastH));
