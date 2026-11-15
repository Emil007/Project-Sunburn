// Minimal AVI demuxer
import { parseFmt, decodeAudio, WaveFmt } from './wav';
import { Cinepak } from './cinepak';

export interface AVIFile {
  w: number; h: number; usPerFrame: number; frames: Uint8Array[]; audio: Float32Array | null; audioRate: number; audioChannels: number; codec: string;
}

export function parseAVI(d: Uint8Array): AVIFile | null {
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  const fourcc = (o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'AVI ') return null;
  let w = 0, h = 0, us = 66666; const frames: Uint8Array[] = []; const audioChunks: Uint8Array[] = [];
  let curType = ''; const streamTypes: string[] = []; let afmt: WaveFmt | null = null; let codec = '';
  let vidStream = -1, audStream = -1;
  const walk = (p: number, end: number, inMovi: boolean) => {
    while (p + 8 <= end) {
      const id = fourcc(p); const len = dv.getUint32(p + 4, true);
      if (id === 'LIST') { const lt = fourcc(p + 8); walk(p + 12, Math.min(end, p + 8 + len), inMovi || lt === 'movi'); }
      else if (id === 'avih') { us = dv.getUint32(p + 8, true) || us; w = dv.getUint32(p + 8 + 32, true); h = dv.getUint32(p + 8 + 36, true); }
      else if (id === 'strh') { curType = fourcc(p + 8); streamTypes.push(curType); if (curType === 'vids') { codec = fourcc(p + 12); vidStream = streamTypes.length - 1; } if (curType === 'auds') audStream = streamTypes.length - 1; }
      else if (id === 'strf') { if (curType === 'auds') afmt = parseFmt(d, p + 8, len); else if (curType === 'vids') { w = dv.getInt32(p + 8 + 4, true) || w; h = Math.abs(dv.getInt32(p + 8 + 8, true)) || h; } }
      else if (inMovi) {
        const sn = parseInt(id.slice(0, 2), 10); const t = id.slice(2);
        if ((t === 'dc' || t === 'db') && (sn === vidStream || vidStream < 0)) frames.push(d.subarray(p + 8, p + 8 + len));
        else if (t === 'wb' && (sn === audStream || audStream < 0)) audioChunks.push(d.subarray(p + 8, p + 8 + len));
      }
      p += 8 + len + (len & 1);
    }
  };
  walk(12, d.length, false);
  let audio: Float32Array | null = null; let rate = 22050, ch = 1;
  const f = afmt as WaveFmt | null;
  if (f && audioChunks.length) {
    rate = f.rate; ch = f.channels;
    if (f.tag === 2 || f.tag === 0x11) {
      const parts = audioChunks.map(c => decodeAudio(f, c)); let n = 0; for (const x of parts) n += x.length;
      audio = new Float32Array(n); let o = 0; for (const x of parts) { audio.set(x, o); o += x.length; }
    } else {
      let n = 0; for (const c of audioChunks) n += c.length; const all = new Uint8Array(n); let o = 0; for (const c of audioChunks) { all.set(c, o); o += c.length; }
      audio = decodeAudio(f, all);
    }
  }
  return { w, h, usPerFrame: us, frames, audio, audioRate: rate, audioChannels: ch, codec };
}

export class AVIPlayer {
  dec: Cinepak; frame = -1;
  constructor(public avi: AVIFile) { this.dec = new Cinepak(avi.w, avi.h); }
  get lengthMs() { return this.avi.frames.length * this.avi.usPerFrame / 1000; }
  // decode up to frame index n (sequential)
  seekTo(n: number) {
    n = Math.min(n, this.avi.frames.length - 1);
    if (n < this.frame) { this.frame = -1; this.dec = new Cinepak(this.avi.w, this.avi.h); }
    while (this.frame < n) { this.frame++; const fr = this.avi.frames[this.frame]; if (fr.length) this.dec.decode(fr); }
  }
}
