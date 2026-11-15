// Okumura LZHUF decoder (used by the Sunflowers installer archives _SETUP.1/_FILES.1)
const N = 4096, F = 60, THRESHOLD = 2, N_CHAR = 256 - THRESHOLD + F, T = N_CHAR * 2 - 1, R = T - 1, MAX_FREQ = 0x8000;
const d_code = new Uint8Array(256), d_len = new Uint8Array(256);
(() => {
  const runs: [number, number][] = [[0x00, 32], [0x01, 16], [0x02, 16], [0x03, 16]];
  for (let v = 4; v < 12; v++) runs.push([v, 8]);
  for (let v = 12; v < 24; v++) runs.push([v, 4]);
  for (let v = 24; v < 48; v++) runs.push([v, 2]);
  for (let v = 48; v < 64; v++) runs.push([v, 1]);
  let i = 0; for (const [v, n] of runs) for (let k = 0; k < n; k++) d_code[i++] = v;
  const lens: [number, number][] = [[3, 32], [4, 48], [5, 64], [6, 48], [7, 48], [8, 16]];
  i = 0; for (const [v, n] of lens) for (let k = 0; k < n; k++) d_len[i++] = v;
})();

export function lzhufDecode(src: Uint8Array, outLen: number): Uint8Array {
  const freq = new Uint32Array(T + 1), prnt = new Int32Array(T + N_CHAR), son = new Int32Array(T);
  for (let i = 0; i < N_CHAR; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) { freq[j] = freq[i] + freq[i + 1]; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xffff; prnt[R] = 0;
  let pos = 0, buf = 0, blen = 0;
  const getbit = () => { if (blen === 0) { buf = pos < src.length ? src[pos] : 0; pos++; blen = 8; } blen--; return (buf >> blen) & 1; };
  const getbyte = () => { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | getbit(); return v; };
  const reconst = () => {
    let j = 0;
    for (let i = 0; i < T; i++) if (son[i] >= T) { freq[j] = (freq[i] + 1) >> 1; son[j] = son[i]; j++; }
    for (let i = 0, jj = N_CHAR; jj < T; i += 2, jj++) {
      let k = i + 1; const f = freq[jj] = freq[i] + freq[k];
      for (k = jj - 1; f < freq[k]; k--);
      k++;
      const l = jj - k;
      freq.copyWithin(k + 1, k, k + l); freq[k] = f;
      son.copyWithin(k + 1, k, k + l); son[k] = i;
    }
    for (let i = 0; i < T; i++) { const k = son[i]; if (k >= T) prnt[k] = i; else prnt[k] = prnt[k + 1] = i; }
  };
  const update = (c0: number) => {
    if (freq[R] === MAX_FREQ) reconst();
    let c = prnt[c0 + T];
    do {
      const k = ++freq[c];
      let l = c + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[c] = freq[l]; freq[l] = k;
        const i = son[c]; prnt[i] = l; if (i < T) prnt[i + 1] = l;
        const j = son[l]; son[l] = i;
        prnt[j] = c; if (j < T) prnt[j + 1] = c;
        son[c] = j;
        c = l;
      }
      c = prnt[c];
    } while (c !== 0);
  };
  const out = new Uint8Array(outLen);
  const text = new Uint8Array(N + F).fill(0x20);
  let r = N - F, o = 0;
  while (o < outLen) {
    let c = son[R];
    while (c < T) { c += getbit(); c = son[c]; }
    c -= T; update(c);
    if (c < 256) { out[o++] = c; text[r] = c; r = (r + 1) & (N - 1); }
    else {
      let i = getbyte(); const cc = d_code[i] << 6; let j = d_len[i] - 2;
      while (j--) i = (i << 1) + getbit();
      const p = cc | (i & 0x3f);
      const start = (r - p - 1) & (N - 1); const len = c - 255 + THRESHOLD;
      for (let k = 0; k < len && o < outLen; k++) { const ch = text[(start + k) & (N - 1)]; out[o++] = ch; text[r] = ch; r = (r + 1) & (N - 1); }
    }
  }
  return out;
}
