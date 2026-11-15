// Emulator worker: runs the Win16 machine synchronously, talks to UI via SharedArrayBuffers.
import { Win16 } from '../win16/win16';
import type { Platform, InputEvent, CursorImage } from '../win16/platform';
import { openISO, openMDS, openCUE, Disc, ByteSource } from '../assets/disc';
import { buildInstall, DiscFS, detectLanguage } from '../assets/install';
import { smfDurationMs } from '../media/smf';
import { ModRuntime } from '../mods/runtime';
import type { ActiveMod } from '../mods/types';
import { CTRL, EV_BASE, EV_SIZE, EV_CAP, EVT, StartConfig, WorkerMsg } from './proto';

declare const FileReaderSync: any;
const post = (m: WorkerMsg, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer);

function openDisc(files: { name: string; file: Blob }[]): Disc {
  const frs = new FileReaderSync();
  const src = (b: Blob): ByteSource => ({ size: b.size, read: (o: number, l: number) => new Uint8Array(frs.readAsArrayBuffer(b.slice(o, Math.min(b.size, o + l)))) });
  const by = (ext: string) => files.find(f => f.name.toLowerCase().endsWith(ext));
  const mds = by('.mds');
  if (mds) {
    const mdf = by('.mdf'); if (!mdf) throw new Error('The .mdf image file belonging to the .mds is missing.');
    return openMDS(new Uint8Array(frs.readAsArrayBuffer(mds.file)), src(mdf.file));
  }
  const cue = by('.cue');
  if (cue) {
    const text = frs.readAsText(cue.file);
    return openCUE(text, (n) => { const f = files.find(x => x.name.toLowerCase() === n.toLowerCase().replace(/^.*[\\/]/, '')); return f ? src(f.file) : null; });
  }
  const iso = files.find(f => /\.(iso|img|bin|mdf)$/i.test(f.name));
  if (!iso) throw new Error('No disc image (.iso, .bin/.cue or .mdf/.mds) was provided.');
  return openISO(src(iso.file));
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.t === 'probe') {
    try { const d = openDisc(msg.files); const lang = detectLanguage(d); post({ t: 'probe', ok: !!lang, lang: lang ?? undefined, label: d.volumeLabel, error: lang ? undefined : 'This disc is not a Holiday Island CD.' }); }
    catch (err: any) { post({ t: 'probe', ok: false, error: String(err?.message || err) }); }
    return;
  }
  if (msg.t === 'title') {
    try {
      const d = openDisc(msg.files); const bmp = d.readFile('GRAFIK\\TIT64X48.BMP') || d.readFile('GRAFIK\\BCK64X48.BMP');
      if (!bmp) { post({ t: 'title', rgba: null } as any); return; }
      const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.length);
      const off = dv.getUint32(10, true), hs = dv.getUint32(14, true), w = dv.getInt32(18, true), h = dv.getInt32(22, true), bpp = dv.getUint16(28, true);
      const rgba = new Uint8Array(w * Math.abs(h) * 4); const stride = ((w * bpp + 31) >>> 5) << 2; const pal = 14 + hs;
      for (let y = 0; y < Math.abs(h); y++) for (let x = 0; x < w; x++) {
        const row = h > 0 ? Math.abs(h) - 1 - y : y; const i = bmp[off + row * stride + x]; const o = (y * w + x) * 4;
        rgba[o] = bmp[pal + i * 4 + 2]; rgba[o + 1] = bmp[pal + i * 4 + 1]; rgba[o + 2] = bmp[pal + i * 4]; rgba[o + 3] = 255;
      }
      void bpp; (self as any).postMessage({ t: 'title', rgba, width: w, height: Math.abs(h) }, [rgba.buffer]);
    } catch { post({ t: 'title', rgba: null } as any); }
    return;
  }
  if (msg.t === 'start') {
    try { run(msg as StartConfig); }
    catch (err: any) { post({ t: 'crash', msg: String(err?.message || err), detail: String(err?.stack || '') }); }
  }
};

function run(cfg: StartConfig) {
  (self as any).__dbgInput = (cfg as any).debugInput;
  const ctrl = new Int32Array(cfg.ctrlSab);
  const frame = new Uint8Array(cfg.frameSab); const frame32 = new Uint32Array(cfg.frameSab);
  const cursorBuf = new Uint8Array(cfg.cursorSab);
  const disc = openDisc(cfg.files);
  const inst = buildInstall(disc, { videoHi: cfg.videoHi, soundHi: cfg.soundHi });
  const rt = new ModRuntime(((cfg as any).mods || []) as ActiveMod[], inst.lang, (s) => post({ t: 'log', s }), (cfg as any).host);
  rt.toUI = (data) => post({ t: 'modstatus', data } as any);
  for (const [p, d] of rt.overlayHD) inst.C.add('HOLIDAY\\' + p, d);
  for (const s of cfg.saves) inst.C.add(s.path, s.data);
  inst.C.onWrite = (p, d) => post({ t: 'persist', path: p, data: d ? d.slice() : null });
  const audioTracks = disc.tracks.filter(t => t.audio);
  const trackMs = audioTracks.map(t => t.sectors * 1000 / 75);
  post({ t: 'ready', lang: inst.lang, tracks: disc.tracks.map(t => ({ num: t.num, audio: t.audio, sectors: t.sectors })) });

  // ---- platform implementation ----
  let evSeen = Atomics.load(ctrl, CTRL.EVSEQ);
  const pcmIds = new WeakMap<Float32Array, number>(); let nextPcm = 1;
  const chEnd = new Map<number, number>();
  let midiEnd = 0, midiPausedLeft = 0;
  let cdEnd = 0; const sentTracks = new Set<number>();
  let lastCursorId = -1;
  const now = () => performance.now();
  const platform: Platform = {
    now,
    wait(ms: number) {
      if (Atomics.load(ctrl, CTRL.EVREAD) !== Atomics.load(ctrl, CTRL.EVWRITE)) return;
      Atomics.wait(ctrl, CTRL.EVSEQ, evSeen, Math.max(1, ms));
      evSeen = Atomics.load(ctrl, CTRL.EVSEQ);
    },
    pollEvents(): InputEvent[] {
      const out: InputEvent[] = [];
      let r = Atomics.load(ctrl, CTRL.EVREAD); const wpos = Atomics.load(ctrl, CTRL.EVWRITE);
      while (r !== wpos) {
        const o = EV_BASE + (r % EV_CAP) * EV_SIZE;
        const type = ctrl[o];
        const ev: InputEvent = { type: 'mousemove' };
        switch (type) {
          case EVT.mousemove: ev.type = 'mousemove'; break; case EVT.mousedown: ev.type = 'mousedown'; break; case EVT.mouseup: ev.type = 'mouseup'; break;
          case EVT.keydown: ev.type = 'keydown'; break; case EVT.keyup: ev.type = 'keyup'; break; case EVT.quit: ev.type = 'quit'; break;
        }
        ev.x = ctrl[o + 1]; ev.y = ctrl[o + 2]; ev.button = ctrl[o + 3]; ev.vk = ctrl[o + 4]; ev.char = ctrl[o + 5] || undefined;
        if ((self as any).__dbgInput && ev.type !== 'mousemove') post({ t: 'log', s: `input ${ev.type} ${ev.x},${ev.y} b=${ev.button} vk=${ev.vk}` });
        out.push(ev); r = (r + 1) | 0;
      }
      Atomics.store(ctrl, CTRL.EVREAD, r);
      return out;
    },
    present(rgba, w, h, _pal, cursor: CursorImage | null) {
      // only hand over frames that changed: the page re-runs the screen filter for every new frame
      const n = w * h; const src32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
      let same = ctrl[CTRL.FRAMEW] === w && ctrl[CTRL.FRAMEH] === h;
      if (same) for (let i = 0; i < n; i++) if (src32[i] !== frame32[i]) { same = false; break; }
      if (!same) { frame32.set(src32); ctrl[CTRL.FRAMEW] = w; ctrl[CTRL.FRAMEH] = h; }
      if (cursor && cursor.id !== lastCursorId) {
        lastCursorId = cursor.id;
        cursorBuf.fill(0); for (let y = 0; y < Math.min(64, cursor.h); y++) cursorBuf.set(cursor.rgba.subarray(y * cursor.w * 4, y * cursor.w * 4 + Math.min(64, cursor.w) * 4), y * 64 * 4);
        ctrl[CTRL.CURSORW] = cursor.w; ctrl[CTRL.CURSORH] = cursor.h; ctrl[CTRL.CURSORHX] = cursor.hx; ctrl[CTRL.CURSORHY] = cursor.hy;
        Atomics.add(ctrl, CTRL.CURSORSEQ, 1);
      }
      ctrl[CTRL.CURSORVIS] = cursor ? 1 : 0;
      if (!same) Atomics.add(ctrl, CTRL.FRAMESEQ, 1);
    },
    setCursor(c) { if (c && c.id !== lastCursorId) { lastCursorId = -1; } },
    messageBox(text, caption, type) {
      Atomics.store(ctrl, CTRL.MSGBOX, -1);
      post({ t: 'msgbox', text, caption, type });
      while (Atomics.load(ctrl, CTRL.MSGBOX) === -1) Atomics.wait(ctrl, CTRL.MSGBOX, -1, 200);
      return Atomics.load(ctrl, CTRL.MSGBOX);
    },
    log(s) { post({ t: 'log', s }); },
    audio: {
      playPCM(ch, pcm, rate, loop, vol) {
        let id = pcmIds.get(pcm);
        if (!id) { id = nextPcm++; pcmIds.set(pcm, id); post({ t: 'pcm', id, data: pcm.slice(), rate, channels: 1 }); }
        post({ t: 'play', ch, id, loop, vol });
        chEnd.set(ch, loop ? Infinity : now() + pcm.length / rate * 1000);
      },
      stopChannel(ch) { if (chEnd.has(ch)) { chEnd.delete(ch); post({ t: 'stop', ch }); } },
      isPlaying(ch) { return (chEnd.get(ch) ?? 0) > now(); },
      setMasterVolume(v) { post({ t: 'mastervol', v }); },
    },
    midi: {
      play(d, _loop) { midiEnd = now() + smfDurationMs(d) + 1500; post({ t: 'midi', op: 'play', data: d.slice() }); },
      stop() { midiEnd = 0; post({ t: 'midi', op: 'stop' }); },
      pause() { midiPausedLeft = Math.max(0, midiEnd - now()); midiEnd = 0; post({ t: 'midi', op: 'pause' }); },
      resume() { midiEnd = now() + midiPausedLeft; post({ t: 'midi', op: 'resume' }); },
      isPlaying() { return now() < midiEnd; },
      positionMs() { return 0; },
      lengthMs(d) { return smfDurationMs(d); },
      setVolume(v) { post({ t: 'midi', op: 'vol', v }); },
    },
    cd: audioTracks.length ? {
      playTrack(_t, from, to) {
        // timeline: [track1(data)=0, audio tracks...]
        let acc = 0, k = 0; while (k < trackMs.length - 1 && acc + trackMs[k] <= from) { acc += trackMs[k]; k++; }
        const total = trackMs.reduce((a, b) => a + b, 0); const end = Math.min(to ?? total, acc + trackMs[k]);
        if (!sentTracks.has(k)) { sentTracks.add(k); const raw = disc.readAudio(audioTracks[k]); const pcm = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~3))); (self as any).postMessage({ t: 'cdtrack', idx: k, pcm }, [pcm.buffer]); }
        cdEnd = now() + (end - from); post({ t: 'cd', op: 'play', idx: k, offset: from - acc, dur: end - from } as any);
      },
      stop() { cdEnd = 0; post({ t: 'cd', op: 'stop' }); },
      isPlaying() { return now() < cdEnd; },
      positionMs() { return 0; },
      trackLengths() { return [0, ...trackMs]; },
    } : null,
    persist: undefined,
    setTitle(s) { post({ t: 'title', s }); },
  };

  const scr = rt.screen || { w: cfg.screenW, h: cfg.screenH };
  const w = new Win16(platform, { screenW: scr.w, screenH: scr.h });
  w.vfs.mount('C', inst.C);
  w.vfs.mount('D', rt.wrapFS('D', new DiscFS(disc)));
  w.vfs.curDrive = 'C'; w.vfs.curDir.set('C', 'HOLIDAY');
  rt.attach(w);
  w.user.inputTrace = (s) => post({ t: 'log', s: 'input: ' + s, level: 'input' } as any);
  w.load(inst.exePath, inst.C.read('HOLIDAY\\HOLIDAY.EXE')!);
  rt.applyLoad();
  w.begin();
  const cpu = w.m.cpu;
  post({ t: 'log', s: `started: screen ${scr.w}x${scr.h}, language ${inst.lang}, mods: ${rt.mods.map((m) => m.manifest.id).join(', ') || 'none'}` });
  // periodic health line for the log: emulator speed, message queue, windows
  let statT = performance.now(), statInstr = 0, slices = 0, sliceMs = 0, maxSlice = 0;
  const stat = () => {
    const t = performance.now(); if (t - statT < 5000) return;
    const instr = cpu.icount;
    const tops = w.user.tops.filter((x: any) => x.style & 0x10000000).slice(0, 6).map((x: any) => `${x.cls.name}${(x.style & 0x08000000) ? '(disabled)' : ''}`).join(' > ');
    post({ t: 'log', s: `stats: ${slices} slices in ${((t - statT) / 1000).toFixed(1)}s, longest slice ${maxSlice.toFixed(0)}ms (incl. idle wait), ${((instr - statInstr) / 1e6).toFixed(1)}M instr, queue ${w.user.queue.length}, capture ${w.user.capture ? w.user.get(w.user.capture)?.cls.name : 'none'}, windows: ${tops}`, level: 'debug' } as any);
    statT = t; statInstr = instr; slices = 0; sliceMs = 0; maxSlice = 0;
  };
  try {
    while (!w.exited) {
      const s0 = performance.now();
      const ok = w.runSlice(20000);
      const d = performance.now() - s0; slices++; sliceMs += d; if (d > maxSlice) maxSlice = d;
      stat();
      if (!ok) break;
      rt.tick(performance.now());
      if (Atomics.load(ctrl, CTRL.QUIT)) { w.requestQuit(); Atomics.store(ctrl, CTRL.QUIT, 0); }
      w.present();
      w.mmTick();
    }
    post({ t: 'exit', code: w.exitCode });
  } catch (err: any) {
    const regs = `CS:IP=${cpu.cs.toString(16)}:${cpu.curInstIp.toString(16)} AX=${cpu.ax.toString(16)} BX=${cpu.bx.toString(16)} CX=${cpu.cx.toString(16)} DX=${cpu.dx.toString(16)} DS=${cpu.ds.toString(16)} ES=${cpu.es.toString(16)} SS:SP=${cpu.ss.toString(16)}:${cpu.sp.toString(16)}`;
    post({ t: 'crash', msg: String(err?.message || err), detail: regs + '\nRecent API: ' + w.m.callHistory.slice(-20).join(' ') + '\n' + String(err?.stack || '') });
  }
}
