// WAV / ADPCM decoding to Float32 PCM (mono or interleaved stereo)
export interface PCM { rate: number; channels: number; data: Float32Array; }

const ADPCM_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const ADPCM_COEF = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];

export interface WaveFmt { tag: number; channels: number; rate: number; blockAlign: number; bits: number; extra: Uint8Array; }

export function parseFmt(d: Uint8Array, o: number, len: number): WaveFmt {
  const dv = new DataView(d.buffer, d.byteOffset);
  const tag = dv.getUint16(o, true), channels = dv.getUint16(o + 2, true), rate = dv.getUint32(o + 4, true), blockAlign = dv.getUint16(o + 12, true), bits = dv.getUint16(o + 14, true);
  const cb = len >= 18 ? dv.getUint16(o + 16, true) : 0;
  return { tag, channels, rate, blockAlign, bits, extra: d.subarray(o + 18, o + 18 + cb) };
}

export function decodeAudio(fmt: WaveFmt, data: Uint8Array): Float32Array {
  const ch = fmt.channels;
  if (fmt.tag === 1) {
    if (fmt.bits === 8) { const out = new Float32Array(data.length); for (let i = 0; i < data.length; i++) out[i] = (data[i] - 128) / 128; return out; }
    if (fmt.bits === 16) { const n = data.length >> 1; const out = new Float32Array(n); const dv = new DataView(data.buffer, data.byteOffset, data.length); for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768; return out; }
  }
  if (fmt.tag === 2) return decodeMSADPCM(fmt, data);
  if (fmt.tag === 0x11) return decodeIMA(fmt, data);
  return new Float32Array(0);
  void ch;
}

function decodeMSADPCM(fmt: WaveFmt, data: Uint8Array): Float32Array {
  const ch = fmt.channels, ba = fmt.blockAlign;
  const ex = fmt.extra; const dvx = new DataView(ex.buffer, ex.byteOffset, ex.length);
  const spb = ex.length >= 2 ? dvx.getUint16(0, true) : ((ba - 7 * ch) * 8) / (4 * ch) + 2;
  let coefs = ADPCM_COEF;
  if (ex.length >= 4) { const n = dvx.getUint16(2, true); coefs = []; for (let i = 0; i < n; i++) coefs.push([dvx.getInt16(4 + i * 4, true), dvx.getInt16(6 + i * 4, true)]); }
  const blocks = Math.floor(data.length / ba); const rem = data.length % ba;
  const out = new Float32Array((blocks + (rem ? 1 : 0)) * spb * ch); let op = 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  for (let b = 0; b * ba < data.length; b++) {
    let p = b * ba; const end = Math.min(data.length, p + ba);
    if (end - p < 7 * ch) break;
    const pred: number[] = [], delta: number[] = [], s1: number[] = [], s2: number[] = [];
    for (let c = 0; c < ch; c++) pred[c] = Math.min(data[p++], coefs.length - 1);
    for (let c = 0; c < ch; c++) { delta[c] = dv.getInt16(p, true); p += 2; }
    for (let c = 0; c < ch; c++) { s1[c] = dv.getInt16(p, true); p += 2; }
    for (let c = 0; c < ch; c++) { s2[c] = dv.getInt16(p, true); p += 2; }
    for (let c = 0; c < ch; c++) out[op++] = s2[c] / 32768;
    for (let c = 0; c < ch; c++) out[op++] = s1[c] / 32768;
    let c = 0;
    const nib = (n: number) => {
      const [c1, c2] = coefs[pred[c]];
      let predv = ((s1[c] * c1) + (s2[c] * c2)) >> 8;
      const sn = n & 8 ? n - 16 : n;
      predv += sn * delta[c];
      if (predv > 32767) predv = 32767; else if (predv < -32768) predv = -32768;
      s2[c] = s1[c]; s1[c] = predv;
      delta[c] = (ADPCM_ADAPT[n] * delta[c]) >> 8; if (delta[c] < 16) delta[c] = 16;
      out[op++] = predv / 32768;
      c = (c + 1) % ch;
    };
    let left = (spb - 2) * ch;
    while (p < end && left > 0) { const byte = data[p++]; nib(byte >> 4); left--; if (left > 0) { nib(byte & 15); left--; } }
  }
  return out.subarray(0, op);
}

const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
function decodeIMA(fmt: WaveFmt, data: Uint8Array): Float32Array {
  const ch = fmt.channels, ba = fmt.blockAlign; const out: number[] = []; const dv = new DataView(data.buffer, data.byteOffset, data.length);
  for (let p0 = 0; p0 + 4 * ch <= data.length; p0 += ba) {
    let p = p0; const pred: number[] = [], idx: number[] = [];
    for (let c = 0; c < ch; c++) { pred[c] = dv.getInt16(p, true); idx[c] = Math.min(88, data[p + 2]); p += 4; out.push(pred[c] / 32768); }
    const end = Math.min(data.length, p0 + ba);
    const bufs: number[][] = Array.from({ length: ch }, () => []);
    while (p + 4 * ch <= end) {
      for (let c = 0; c < ch; c++) {
        for (let k = 0; k < 4; k++) { const byte = data[p++]; for (const n of [byte & 15, byte >> 4]) { const st = IMA_STEP[idx[c]]; let diff = st >> 3; if (n & 1) diff += st >> 2; if (n & 2) diff += st >> 1; if (n & 4) diff += st; if (n & 8) diff = -diff; pred[c] = Math.max(-32768, Math.min(32767, pred[c] + diff)); idx[c] = Math.max(0, Math.min(88, idx[c] + IMA_IDX[n])); bufs[c].push(pred[c] / 32768); } }
      }
      for (let i = 0; i < bufs[0].length; i++) for (let c = 0; c < ch; c++) out.push(bufs[c][i]);
      for (const b of bufs) b.length = 0;
    }
  }
  return Float32Array.from(out);
}

export function parseWav(d: Uint8Array): PCM | null {
  if (d.length < 12 || String.fromCharCode(...d.subarray(0, 4)) !== 'RIFF') return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  let p = 12; let fmt: WaveFmt | null = null; let data: Uint8Array | null = null;
  while (p + 8 <= d.length) {
    const id = String.fromCharCode(...d.subarray(p, p + 4)); const len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = parseFmt(d, p + 8, len);
    else if (id === 'data') data = d.subarray(p + 8, Math.min(d.length, p + 8 + len));
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data) return null;
  return { rate: fmt.rate, channels: fmt.channels, data: decodeAudio(fmt, data) };
}
