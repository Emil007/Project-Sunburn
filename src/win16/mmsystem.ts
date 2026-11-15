// MMSYSTEM (MCI: sequencer, avivideo, cdaudio, waveaudio) and WAVEMIX
import type { Win16 } from './win16';
import { parseWav, PCM } from '../media/wav';
import { parseAVI, AVIPlayer } from '../media/avi';
import type { Rect } from './gdi';

const MM_MCINOTIFY = 0x3b9, MM_WOM_DONE = 0x3bd;
const MODE = { NOT_READY: 524, STOP: 525, PLAY: 526, SEEK: 528, PAUSE: 529, OPEN: 530 };

interface MciDev {
  id: number; type: string; file: string; notifyWnd: number; notifyPending: boolean;
  mode: number; timeFmt: number; startedAt: number; startPos: number; endPos: number; pos: number;
  smf?: Uint8Array; lengthMs: number;
  avi?: AVIPlayer; hwnd: number; dest: Rect | null; aviCh?: number;
  cdTrack?: number;
}

export function installMM(w: Win16) {
  const m = w.m, mem = m.mem, P = w.platform;
  const MM = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('MMSYSTEM', o, n, a, r, f);
  const devs = new Map<number, MciDev>(); let nextId = 1;
  let midiVol = 0xffff, waveVol = 0xffffffff;

  const now = () => P.now();
  const curPos = (d: MciDev) => d.mode === MODE.PLAY ? Math.min(d.endPos, d.startPos + (now() - d.startedAt)) : d.pos;
  const toFmt = (d: MciDev, ms: number) => {
    if (d.timeFmt === 3 && d.avi) return Math.floor(ms * 1000 / d.avi.avi.usPerFrame);
    if (d.timeFmt === 10 && d.type === 'cdaudio') { // TMSF
      const lens = P.cd?.trackLengths() || []; let t = 0, acc = 0; while (t < lens.length - 1 && acc + lens[t] <= ms) { acc += lens[t]; t++; }
      const r = ms - acc; const mn = Math.floor(r / 60000), s = Math.floor(r / 1000) % 60, f = Math.floor((r % 1000) * 75 / 1000);
      return ((f << 24) | (s << 16) | (mn << 8) | (t + 1)) >>> 0;
    }
    if (d.timeFmt === 2) { const mn = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, f = Math.floor((ms % 1000) * 75 / 1000); return (mn | (s << 8) | (f << 16)) >>> 0; }
    return Math.floor(ms);
  };
  const fromFmt = (d: MciDev, v: number) => {
    if (d.timeFmt === 3 && d.avi) return v * d.avi.avi.usPerFrame / 1000;
    if (d.timeFmt === 10 && d.type === 'cdaudio') { const lens = P.cd?.trackLengths() || []; const t = (v & 0xff) - 1; let acc = 0; for (let i = 0; i < t && i < lens.length; i++) acc += lens[i]; return acc + ((v >> 8) & 0xff) * 60000 + ((v >> 16) & 0xff) * 1000 + ((v >>> 24) * 1000 / 75); }
    if (d.timeFmt === 2) return (v & 0xff) * 60000 + ((v >> 8) & 0xff) * 1000 + ((v >> 16) & 0xff) * 1000 / 75;
    return v;
  };
  const notify = (d: MciDev, code: number) => {
    if (d.notifyPending && d.notifyWnd) { d.notifyPending = false; w.user.post(d.notifyWnd, MM_MCINOTIFY, code, d.id); }
  };
  const setNotify = (d: MciDev, flags: number, parms: number) => {
    if (flags & 1) { if (d.notifyPending) notify(d, 2); /* superseded */ d.notifyWnd = parms ? mem.r16(m.lin(parms)) : 0; d.notifyPending = true; }
  };

  const findFile = (name: string) => { const d = w.vfs.read(name); return d; };

  const startPlay = (d: MciDev, from: number, to: number) => {
    d.startPos = from; d.endPos = to; d.startedAt = now(); d.mode = MODE.PLAY;
    if (d.type === 'sequencer' && d.smf) { P.midi.setVolume(midiVolF()); P.midi.play(d.smf, false); if (from > 0) { /* seek unsupported: restart */ } }
    if (d.type === 'avivideo' && d.avi) {
      const a = d.avi.avi;
      if (a.audio) { const ch = 900 + d.id; d.aviCh = ch; const off = Math.floor(from / 1000 * a.audioRate) * a.audioChannels; P.audio.playPCM(ch, a.audio.subarray(off), a.audioRate * (a.audioChannels > 1 ? 1 : 1), false, 1); }
    }
    if (d.type === 'cdaudio' && P.cd) P.cd.playTrack(0, from, to);
  };
  const stopPlay = (d: MciDev) => {
    if (d.mode === MODE.PLAY) d.pos = curPos(d);
    d.mode = MODE.STOP;
    if (d.type === 'sequencer') P.midi.stop();
    if (d.type === 'avivideo' && d.aviCh) P.audio.stopChannel(d.aviCh);
    if (d.type === 'cdaudio') P.cd?.stop();
  };
  const midiVolF = () => (midiVol & 0xffff) / 0xffff;

  // video overlay: draw current frames into target window area (RGBA overlay on composed screen)
  w.overlays.push(() => {});
  w.videoLayers = [];
  const videoTick = () => {
    const layers: any[] = [];
    for (const d of devs.values()) {
      if (d.type !== 'avivideo' || !d.avi || !d.hwnd) continue;
      if (d.mode !== MODE.PLAY && d.mode !== MODE.PAUSE && d.avi.frame < 0) continue;
      const wd = w.user.get(d.hwnd); if (!wd || !w.user.isVisible(wd)) continue;
      const ms = curPos(d); const fr = Math.floor(ms * 1000 / d.avi.avi.usPerFrame);
      d.avi.seekTo(Math.max(0, fr));
      const [sx, sy] = w.user.clientToScreen(wd, 0, 0); const cr = w.user.clientRect(wd);
      const dest = d.dest || { l: 0, t: 0, r: d.avi.avi.w, b: d.avi.avi.h };
      // clip to client area of display window
      layers.push({ rgba: d.avi.dec.rgba, w: d.avi.avi.w, h: d.avi.avi.h, x: sx + dest.l, y: sy + dest.t, dw: dest.r - dest.l, dh: dest.b - dest.t, clip: { l: sx, t: sy, r: sx + cr.r, b: sy + cr.b } });
    }
    w.videoLayers = layers;
  };

  w.mmTick = () => {
    for (const d of devs.values()) {
      if (d.mode !== MODE.PLAY) continue;
      let done = false;
      if (d.type === 'sequencer') done = !P.midi.isPlaying() && now() - d.startedAt > 300;
      else if (d.type === 'cdaudio') done = P.cd ? (!P.cd.isPlaying() && now() - d.startedAt > 300) : now() - d.startedAt >= d.endPos - d.startPos;
      else done = now() - d.startedAt >= d.endPos - d.startPos;
      if (done) { d.pos = d.endPos; d.mode = MODE.STOP; if (d.type === 'avivideo' && d.aviCh) P.audio.stopChannel(d.aviCh); notify(d, 1); }
    }
    videoTick();
  };

  const parmsLin = (p: number) => p ? m.lin(p) : 0;
  MM(701, 'mciSendCommand', ['word', 'word', 'long', 'long'], 'l', ([id, cmd, flags, parms]) => {
    const L = parmsLin(parms);
    if (w.traceMCI) w.log(`MCI dev=${id} cmd=${cmd.toString(16)} flags=${flags.toString(16)}`);
    if (cmd === 0x803) { // OPEN
      let type = '', file = '';
      const tp = mem.r32(L + 8), ep = mem.r32(L + 12);
      if (flags & 0x2000) type = (flags & 0x1000) ? '' : m.str(tp).toLowerCase(); // MCI_OPEN_TYPE (ID form not supported)
      if (flags & 0x200) file = m.str(ep);
      if (!type && file) { const ext = file.toLowerCase().split('.').pop(); type = ext === 'mid' || ext === 'rmi' ? 'sequencer' : ext === 'avi' ? 'avivideo' : ext === 'wav' ? 'waveaudio' : ''; }
      if (w.traceMCI) w.log(`MCI open type=${type} file=${file}`);
      const d: MciDev = { id: nextId++, type, file, notifyWnd: 0, notifyPending: false, mode: MODE.STOP, timeFmt: type === 'avivideo' ? 3 : type === 'cdaudio' ? 10 : 0, startedAt: 0, startPos: 0, endPos: 0, pos: 0, lengthMs: 0, hwnd: 0, dest: null };
      if (type === 'sequencer') {
        const data = file ? findFile(file) : null; if (!data) return 275; // MCIERR_FILE_NOT_FOUND
        d.smf = data; d.lengthMs = P.midi.lengthMs(data);
      } else if (type === 'avivideo') {
        const data = file ? findFile(file) : null; if (!data) return 275;
        const a = parseAVI(data); if (!a) return 296;
        d.avi = new AVIPlayer(a); d.lengthMs = d.avi.lengthMs;
      } else if (type === 'cdaudio') {
        if (!P.cd) return 271; // MCIERR_DEVICE_NOT_READY? use generic
        const lens = P.cd.trackLengths(); d.lengthMs = lens.reduce((a, b) => a + b, 0);
      } else if (type === 'waveaudio') {
        const data = file ? findFile(file) : null; if (!data) return 275; const pcm = parseWav(data) || { rate: 22050, channels: 1, data: new Float32Array(1) };
        (d as any).pcm = pcm; d.lengthMs = pcm.data.length / pcm.channels / pcm.rate * 1000;
      } else return 263; // MCIERR_INVALID_DEVICE_NAME
      devs.set(d.id, d);
      mem.w16(L + 4, d.id);
      setNotify(d, flags, parms); notify(d, 1);
      return 0;
    }
    if (id === 0xffff) { if (cmd === 0x804) { for (const d of devs.values()) stopPlay(d); devs.clear(); } return 0; }
    const d = devs.get(id); if (!d) return 257; // MCIERR_INVALID_DEVICE_ID
    switch (cmd) {
      case 0x804: stopPlay(d); notify(d, 4); devs.delete(id); setNotify(d, flags, parms); notify(d, 1); return 0;
      case 0x806: { // PLAY
        let from = d.mode === MODE.PAUSE || d.mode === MODE.STOP ? d.pos : curPos(d), to = d.lengthMs;
        if (flags & 4) from = fromFmt(d, mem.r32(L + 4));
        if (flags & 8) to = fromFmt(d, mem.r32(L + 8));
        if (from >= d.lengthMs - 1 && !(flags & 4)) from = 0;
        if (d.type === 'cdaudio' && d.mode === MODE.PAUSE && !(flags & 4)) { /* resume */ }
        stopPlay(d); setNotify(d, flags, parms);
        if ((d as any).pcm) { const pc: PCM = (d as any).pcm; P.audio.playPCM(800 + d.id, pc.data, pc.rate, false, 1); }
        startPlay(d, from, to); return 0;
      }
      case 0x855: // RESUME
        if (d.mode === MODE.PAUSE) startPlay(d, d.pos, d.endPos || d.lengthMs); return 0;
      case 0x808: stopPlay(d); if (d.type === 'cdaudio') {} setNotify(d, flags, parms); notify(d, 1); return 0;
      case 0x809: { // PAUSE
        if (d.mode === MODE.PLAY) { d.pos = curPos(d); stopPlay(d); d.mode = MODE.PAUSE; if (d.type === 'sequencer') { /* restart on resume */ } }
        setNotify(d, flags, parms); notify(d, 1); return 0;
      }
      case 0x807: { // SEEK
        stopPlay(d);
        if (flags & 0x100) d.pos = 0; else if (flags & 0x200) d.pos = d.lengthMs; else if (flags & 8) d.pos = fromFmt(d, mem.r32(L + 4));
        if (d.avi) d.avi.seekTo(Math.floor(d.pos * 1000 / d.avi.avi.usPerFrame));
        setNotify(d, flags, parms); notify(d, 1); return 0;
      }
      case 0x80d: { // SET
        if (flags & 0x400) d.timeFmt = mem.r32(L + 4);
        setNotify(d, flags, parms); notify(d, 1); return 0;
      }
      case 0x814: { // STATUS
        const item = mem.r32(L + 8); let r = 0;
        switch (item) {
          case 1: if ((flags & 0x10) && d.type === 'cdaudio') { const t = mem.r32(L + 12); const lens = P.cd?.trackLengths() || []; const ms = lens[t - 1] || 0; r = d.timeFmt === 10 ? ((Math.floor(ms / 60000)) | ((Math.floor(ms / 1000) % 60) << 8)) : toFmt(d, ms); } else r = d.timeFmt === 10 ? toFmt({ ...d, timeFmt: 2 }, d.lengthMs) : toFmt(d, d.lengthMs); break;
          case 2: if ((flags & 0x10) && d.type === 'cdaudio') { const t = mem.r32(L + 12); r = t & 0xff; } else r = toFmt(d, curPos(d)); break;
          case 3: r = d.type === 'cdaudio' ? (P.cd?.trackLengths().length ?? 0) : 1; break;
          case 4: r = d.mode; break;
          case 5: r = 1; break;
          case 6: r = d.timeFmt; break;
          case 7: r = 1; break;
          case 8: r = 1; break;
          case 0x4001: r = 0; break;
          default: r = 0;
        }
        mem.w32(L + 4, r >>> 0); setNotify(d, flags, parms); notify(d, 1); return 0;
      }
      case 0x80b: { // GETDEVCAPS
        const item = mem.r32(L + 8); let r = 0;
        switch (item) { case 1: r = 0; break; case 2: r = 1; break; case 3: r = d.type === 'avivideo' ? 1 : 0; break; case 4: r = d.type === 'sequencer' ? 523 : d.type === 'avivideo' ? 519 : d.type === 'cdaudio' ? 516 : 522; break; case 5: r = d.type === 'cdaudio' ? 0 : 1; break; case 6: r = d.type === 'cdaudio' ? 0 : 1; break; case 7: r = d.type === 'cdaudio' ? 1 : 0; break; case 8: r = 1; break; case 9: r = 0; break; default: r = 0; }
        mem.w32(L + 4, r); return 0;
      }
      case 0x841: { // WINDOW
        if (flags & 0x10000) { d.hwnd = mem.r16(L + 4); }
        return 0;
      }
      case 0x842: { // PUT
        if (flags & 0x40000) { const s = (o: number) => (mem.r16(L + o) << 16) >> 16; const l = s(4), t = s(6), r = s(8), b = s(10); d.dest = { l, t, r: l + r, b: t + b }; }
        return 0;
      }
      case 0x843: { // WHERE
        const a = d.avi?.avi; mem.w16(L + 4, 0); mem.w16(L + 6, 0); mem.w16(L + 8, a?.w ?? 0); mem.w16(L + 10, a?.h ?? 0); return 0;
      }
      case 0x80e: { // STEP
        let n = 1; if (flags & 0x10000) n = -1; if (flags & 0x20000) n = mem.r32(L + 4) * (flags & 0x10000 ? -1 : 1);
        if (d.avi) { d.pos = Math.max(0, d.pos + n * d.avi.avi.usPerFrame / 1000); d.avi.seekTo(Math.floor(d.pos * 1000 / d.avi.avi.usPerFrame)); }
        return 0;
      }
      case 0x80a: { // INFO
        const buf = mem.r32(L + 4), n = mem.r32(L + 8); if (buf) mem.writeCStr(buf >>> 16, buf & 0xffff, d.type, n); return 0;
      }
      case 0x844: case 0x845: return 0; // FREEZE/UNFREEZE
      case 0x840: return 0; // UPDATE
      case 0x80c: return 0; // break
    }
    w.log(`MCI unsupported cmd ${cmd.toString(16)}`);
    return 274; // MCIERR_UNSUPPORTED_FUNCTION
  });
  MM(706, 'mciGetErrorString', ['long', 'ptr', 'word'], 'w', ([e, p, n]) => { mem.writeCStr(p >>> 16, p & 0xffff, `MCI error ${e}`, n); return 1; });
  MM(212, 'midiOutSetVolume', ['word', 'long'], 'w', ([, v]) => { midiVol = v & 0xffff; P.midi.setVolume(midiVolF()); return 0; });
  MM(211, 'midiOutGetVolume', ['word', 'ptr'], 'w', ([, p]) => { m.w32(p, 0, (midiVol | (midiVol << 16)) >>> 0); return 0; });
  MM(415, 'waveOutGetVolume', ['word', 'ptr'], 'w', ([, p]) => { m.w32(p, 0, waveVol); return 0; });
  MM(416, 'waveOutSetVolume', ['word', 'long'], 'w', ([, v]) => { waveVol = v >>> 0; P.audio.setMasterVolume((v & 0xffff) / 0xffff); return 0; });
  MM(2, 'sndPlaySound', ['str', 'word'], 'w', ([p]) => { const d = w.vfs.read(m.str(p)); const pcm = d ? parseWav(d) : null; if (pcm) P.audio.playPCM(799, pcm.data, pcm.rate, false, 1); return 1; });

  // ---------------- WAVEMIX ----------------
  const WX = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('WAVEMIX', o, n, a, r, f);
  const waves = new Map<number, PCM>(); // farptr -> pcm
  const chanBusy = new Map<number, { until: number; notify: number; wave: number }>();
  let session = 0x7e01;
  WX(15, 'WaveMixConfigureInit', ['ptr'], 'w', () => session);
  WX(3, 'WaveMixInit', [], 'w', () => session);
  WX(4, 'WaveMixActivate', ['word', 'word'], 'w', () => 0);
  WX(5, 'WaveMixOpenWave', ['word', 'str', 'word', 'long'], 'l', ([, name, hi, fl]) => {
    let data: Uint8Array | null | undefined = null;
    if (fl & 2) { const r = w.findResource(hi, name, (('WAVE' as any))); data = r ? w.resData(r) : null; }
    else if (fl & 4) { /* memory: name is pointer to MMIO info - unsupported */ }
    else data = w.vfs.read(m.str(name));
    if (!data) { if (w.traceFiles) w.log(`WaveMixOpenWave FAIL ${m.str(name)}`); return 0; }
    // empty or broken sound files (shipped on the CD) play as silence instead of failing
    const pcm = parseWav(data) || { rate: 22050, channels: 1, data: new Float32Array(1) };
    const fp = w.m.allocData(16); waves.set(fp, pcm); return fp;
  });
  WX(6, 'WaveMixOpenChannel', ['word', 's_word', 'long'], 'w', () => 0);
  WX(7, 'WaveMixPlay', ['ptr'], 'w', ([p]) => {
    const L = m.lin(p); const ch = (mem.r16(L + 4) << 16) >> 16; const wave = mem.r32(L + 6); const hwnd = mem.r16(L + 10); const flags = mem.r32(L + 12); const loops = mem.r16(L + 16);
    const pcm = waves.get(wave); if (!pcm) return 1;
    const loop = loops === 0xffff;
    const chn = ch & 7;
    P.audio.playPCM(100 + chn, pcm.data, pcm.rate, loop, 1);
    const dur = pcm.data.length / pcm.channels / pcm.rate * 1000 * (loop ? 1e9 : loops + 1);
    chanBusy.set(chn, { until: now() + dur, notify: hwnd, wave });
    void flags; return 0;
  });
  WX(8, 'WaveMixFlushChannel', ['word', 's_word', 'long'], 'w', ([, ch, fl]) => { if (fl & 1) { for (let i = 0; i < 8; i++) P.audio.stopChannel(100 + i); chanBusy.clear(); } else { P.audio.stopChannel(100 + (ch & 7)); chanBusy.delete(ch & 7); } return 0; });
  WX(9, 'WaveMixCloseChannel', ['word', 's_word', 'long'], 'w', ([, ch, fl]) => { if (fl & 1) { for (let i = 0; i < 8; i++) P.audio.stopChannel(100 + i); } else P.audio.stopChannel(100 + (ch & 7)); return 0; });
  WX(10, 'WaveMixFreeWave', ['word', 'ptr'], 'w', ([, p]) => { waves.delete(p); return 0; });
  WX(11, 'WaveMixCloseSession', ['word'], 'w', () => { for (let i = 0; i < 8; i++) P.audio.stopChannel(100 + i); return 0; });
  WX(14, 'WaveMixGetInfo', ['ptr'], 'w', ([p]) => { const L = m.lin(p); mem.w16(L + 2, 0x0100); return 0; });
  WX(12, 'WaveMixPump', [], 'v', () => {});
  const oldTick = w.mmTick;
  w.mmTick = () => {
    oldTick();
    const t = now();
    for (const [ch, b] of chanBusy) if (t >= b.until) { chanBusy.delete(ch); if (b.notify) w.user.post(b.notify, MM_WOM_DONE, ch, b.wave); }
  };
  w.loadableNative.add('WAVEMIX');
}
