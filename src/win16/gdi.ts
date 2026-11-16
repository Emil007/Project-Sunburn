// GDI: 8bpp palettized device, mono bitmaps, DCs, objects, blits.
import type { Win16 } from './win16';
import { FONT_8x16 } from './font';

export interface Surface { w: number; h: number; mono: boolean; data: Uint8Array; }
export type Rect = { l: number; t: number; r: number; b: number };

export interface GObj { type: 'pen' | 'brush' | 'font' | 'bitmap' | 'palette' | 'region'; stock?: boolean; [k: string]: any; }
export interface DC {
  h: number; surface: Surface; hbitmap: number;
  orgX: number; orgY: number;            // device offset (window client origin on surface)
  clip: Rect;                             // device-space clip (surface coords)
  clipRects?: Rect[] | null;              // extra exclusions handled by splitting
  pen: number; brush: number; font: number; palette: number;
  text: number; bk: number; bkMode: number; rop2: number; mapMode: number; stretchMode: number;
  vpOrgX: number; vpOrgY: number; winOrgX: number; winOrgY: number; vpExtX: number; vpExtY: number; winExtX: number; winExtY: number;
  curX: number; curY: number;
  hwnd: number; isMem: boolean; saved: any[]; brushOrgX: number; brushOrgY: number;
  userClip: Rect | null; excl: Rect[];
  baseClip: Rect;
}

const R = (l: number, t: number, r: number, b: number): Rect => ({ l, t, r, b });
const isect = (a: Rect, b: Rect): Rect => R(Math.max(a.l, b.l), Math.max(a.t, b.t), Math.min(a.r, b.r), Math.min(a.b, b.b));
const empty = (a: Rect) => a.r <= a.l || a.b <= a.t;

// Default Windows 3.1 system palette (20 static colors)
const STATIC20 = [
  [0, 0, 0], [0x80, 0, 0], [0, 0x80, 0], [0x80, 0x80, 0], [0, 0, 0x80], [0x80, 0, 0x80], [0, 0x80, 0x80], [0xc0, 0xc0, 0xc0], [0xc0, 0xdc, 0xc0], [0xa6, 0xca, 0xf0],
  [0xff, 0xfb, 0xf0], [0xa0, 0xa0, 0xa4], [0x80, 0x80, 0x80], [0xff, 0, 0], [0, 0xff, 0], [0xff, 0xff, 0], [0, 0, 0xff], [0xff, 0, 0xff], [0, 0xff, 0xff], [0xff, 0xff, 0xff],
];

export class GDI {
  objs = new Map<number, GObj>();
  dcs = new Map<number, DC>();
  private nextH = 0x2000;
  /** while set, RectVisible says nothing is visible, so the game skips most drawing (fast-forward) */
  skipDraw = false;
  sysPal = new Uint8Array(256 * 4);
  palVersion = 0;
  nearestCache = new Map<number, number>();
  stock: number[] = [];
  screen: Surface;
  constructor(public w: Win16, sw: number, sh: number) {
    for (let i = 0; i < 10; i++) this.setSys(i, STATIC20[i]);
    for (let i = 10; i < 20; i++) this.setSys(236 + i, STATIC20[i]);
    this.screen = this.newSurface(sw, sh, false);
    // stock objects
    const mk = (o: GObj) => { const h = this.alloc(o); o.stock = true; return h; };
    this.stock[0] = mk({ type: 'brush', style: 0, color: 0xffffff }); // WHITE_BRUSH
    this.stock[1] = mk({ type: 'brush', style: 0, color: 0xc0c0c0 });
    this.stock[2] = mk({ type: 'brush', style: 0, color: 0x808080 });
    this.stock[3] = mk({ type: 'brush', style: 0, color: 0x404040 });
    this.stock[4] = mk({ type: 'brush', style: 0, color: 0x000000 });
    this.stock[5] = mk({ type: 'brush', style: 1, color: 0 }); // NULL_BRUSH
    this.stock[6] = mk({ type: 'pen', style: 0, width: 1, color: 0xffffff });
    this.stock[7] = mk({ type: 'pen', style: 0, width: 1, color: 0 });
    this.stock[8] = mk({ type: 'pen', style: 5, width: 1, color: 0 }); // NULL_PEN
    for (let i = 10; i <= 14; i++) this.stock[i] = mk({ type: 'font', height: 16, weight: 400, face: 'System' });
    this.stock[13] = mk({ type: 'font', height: 16, weight: 700, face: 'System' });
    this.stock[15] = mk({ type: 'palette', entries: this.defaultPalEntries() });
    this.stock[16] = this.stock[13];
    this.stockMono = mk({ type: 'bitmap', surf: this.newSurface(1, 1, true) });
  }
  stockMono: number;
  private setSys(i: number, c: number[]) { this.sysPal[i * 4] = c[0]; this.sysPal[i * 4 + 1] = c[1]; this.sysPal[i * 4 + 2] = c[2]; this.sysPal[i * 4 + 3] = 255; }
  defaultPalEntries() { const e = new Uint8Array(20 * 4); for (let i = 0; i < 20; i++) { e[i * 4] = STATIC20[i][0]; e[i * 4 + 1] = STATIC20[i][1]; e[i * 4 + 2] = STATIC20[i][2]; } return e; }
  newSurface(w: number, h: number, mono: boolean): Surface { w = Math.max(1, w | 0); h = Math.max(1, h | 0); return { w, h, mono, data: new Uint8Array(w * h) }; }
  /** next free 16-bit GDI handle (0x2000..0xfffe, wraps around and skips handles in use).
   *  Handles must stay below 0x10000: the game keeps them in 16-bit variables, and a DC handle
   *  that wrapped to 0 after ~28,000 DCs made Delphi's FreeMemoryContexts loop forever. */
  private newHandle() {
    for (let n = 0; n < 0x7000; n++) {
      const h = this.nextH; this.nextH += 2; if (this.nextH > 0xfffe) this.nextH = 0x2000;
      if (!this.objs.has(h) && !this.dcs.has(h)) return h;
    }
    throw new Error('out of GDI handles');
  }
  alloc(o: GObj) { const h = this.newHandle(); this.objs.set(h, o); return h; }
  allocDC(dc: Omit<DC, 'h'>): DC { const h = this.newHandle(); const d = dc as DC; d.h = h; this.dcs.set(h, d); return d; }

  // ---- colors ----
  nearest(rgb: number): number {
    rgb &= 0xffffff;
    let v = this.nearestCache.get(rgb); if (v !== undefined) return v;
    const r = rgb & 0xff, g = (rgb >> 8) & 0xff, b = (rgb >> 16) & 0xff; let best = 0, bd = 1e9; const p = this.sysPal;
    for (let i = 0; i < 256; i++) {
      if (!p[i * 4 + 3]) continue;
      const dr = p[i * 4] - r, dg = p[i * 4 + 1] - g, db = p[i * 4 + 2] - b; const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    this.nearestCache.set(rgb, best); return best;
  }
  // COLORREF -> device index for a DC
  colorIndex(dc: DC | null, c: number): number {
    const kind = c >>> 24;
    if (kind === 1) { return this.xlatFor(dc, c & 0xffff); } // PALETTEINDEX
    if (dc && dc.surface.mono) { return ((c & 0xff) + ((c >> 8) & 0xff) + ((c >> 16) & 0xff)) >= 0x180 ? 1 : 0; }
    return this.nearest(c);
  }
  indexToRGB(i: number) { const p = this.sysPal; return p[i * 4] | (p[i * 4 + 1] << 8) | (p[i * 4 + 2] << 16); }
  // Windows 3.1 palette manager: statics fixed (0-9, 246-255), foreground realization fills 10..245
  realize(pal: GObj): number {
    const e: Uint8Array = pal.entries; const n = e.length / 4;
    const sp = this.sysPal;
    const before = sp.slice();
    // foreground: free all non-static slots
    const used = new Uint8Array(256); for (let i = 0; i < 10; i++) used[i] = 1; for (let i = 246; i < 256; i++) used[i] = 1;
    const xlat = new Uint8Array(Math.max(n, 1));
    let next = 10;
    const exact = new Map<number, number>();
    for (let i = 0; i < 256; i++) if (used[i]) exact.set(sp[i * 4] | (sp[i * 4 + 1] << 8) | (sp[i * 4 + 2] << 16), i);
    const pending: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = e[i * 4], g = e[i * 4 + 1], b = e[i * 4 + 2], fl = e[i * 4 + 3];
      if (fl & 2) { xlat[i] = (r | (g << 8)) & 0xff; continue; } // PC_EXPLICIT
      const key = r | (g << 8) | (b << 16);
      const ex = (fl & 5) ? undefined : exact.get(key); // PC_RESERVED|PC_NOCOLLAPSE force own slot
      if (ex !== undefined) { xlat[i] = ex; continue; }
      if (next <= 245) { const k = next++; sp[k * 4] = r; sp[k * 4 + 1] = g; sp[k * 4 + 2] = b; sp[k * 4 + 3] = 255; xlat[i] = k; if (!(fl & 5)) exact.set(key, k); }
      else pending.push(i);
    }
    for (let k = next; k <= 245; k++) sp[k * 4 + 3] = sp[k * 4 + 3]; // keep stale entries as-is
    this.nearestCache.clear();
    for (const i of pending) xlat[i] = this.nearest(e[i * 4] | (e[i * 4 + 1] << 8) | (e[i * 4 + 2] << 16));
    pal.xlat = xlat;
    let changed = 0; for (let i = 0; i < 1024; i++) if (before[i] !== sp[i]) { changed++; }
    if (changed) { this.nearestCache.clear(); this.palVersion++; }
    return changed ? Math.max(1, Math.ceil(changed / 4)) : 0;
  }
  xlatFor(dc: DC | null, i: number) {
    if (!dc) return i & 0xff;
    const p = this.objs.get(dc.palette); if (!p || !p.xlat) { return p && p.stock ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255][i] ?? 0 : i & 0xff; }
    return p.xlat[i] ?? 0;
  }

  // ---- DC helpers ----
  makeDC(surface: Surface, opts: Partial<DC> = {}): DC {
    const clip = R(0, 0, surface.w, surface.h);
    return this.allocDC({
      surface, hbitmap: 0, orgX: 0, orgY: 0, clip, pen: this.stock[7], brush: this.stock[0], font: this.stock[13], palette: this.stock[15],
      text: 0, bk: 0xffffff, bkMode: 2, rop2: 13, mapMode: 1, stretchMode: 1, vpOrgX: 0, vpOrgY: 0, winOrgX: 0, winOrgY: 0, vpExtX: 1, vpExtY: 1, winExtX: 1, winExtY: 1,
      curX: 0, curY: 0, hwnd: 0, isMem: false, saved: [], brushOrgX: 0, brushOrgY: 0, userClip: null, excl: [], baseClip: clip, ...opts,
    } as any);
  }
  // logical -> device
  lx(dc: DC, x: number) { if (dc.mapMode === 1) return x - dc.winOrgX + dc.vpOrgX + dc.orgX; return Math.round((x - dc.winOrgX) * dc.vpExtX / dc.winExtX) + dc.vpOrgX + dc.orgX; }
  ly(dc: DC, y: number) { if (dc.mapMode === 1) return y - dc.winOrgY + dc.vpOrgY + dc.orgY; return Math.round((y - dc.winOrgY) * dc.vpExtY / dc.winExtY) + dc.vpOrgY + dc.orgY; }
  sx(dc: DC, w: number) { return dc.mapMode === 1 ? w : Math.round(w * dc.vpExtX / dc.winExtX); }
  sy(dc: DC, h: number) { return dc.mapMode === 1 ? h : Math.round(h * dc.vpExtY / dc.winExtY); }
  updateClip(dc: DC) {
    let c = dc.baseClip;
    if (dc.userClip) c = isect(c, dc.userClip);
    dc.clip = c;
  }
  // iterate clip rects (clip minus exclusions) intersected with r
  clipRects(dc: DC, r: Rect): Rect[] {
    let rs = [isect(r, dc.clip)];
    if (empty(rs[0])) return [];
    const ex = dc.excl;
    for (const e of ex) {
      const nr: Rect[] = [];
      for (const a of rs) {
        const i = isect(a, e);
        if (empty(i)) { nr.push(a); continue; }
        if (a.t < i.t) nr.push(R(a.l, a.t, a.r, i.t));
        if (i.b < a.b) nr.push(R(a.l, i.b, a.r, a.b));
        if (a.l < i.l) nr.push(R(a.l, i.t, i.l, i.b));
        if (i.r < a.r) nr.push(R(i.r, i.t, a.r, i.b));
      }
      rs = nr;
    }
    return rs.filter(x => !empty(x));
  }
  dirty(dc: DC, r: Rect) { this.w.surfaceDirty(dc.surface, r); }

  // ---- brush fill ----
  brushPixel(dc: DC, brush: GObj | undefined): ((x: number, y: number) => number) | null {
    if (!brush || brush.style === 1) return null;
    if (brush.style === 3 && brush.pattern) {
      const pat: Surface = brush.pattern; const mono = pat.mono; const fg = this.colorIndex(dc, dc.text), bg = this.colorIndex(dc, dc.bk);
      return (x, y) => { const v = pat.data[((y - dc.brushOrgY) & 7) % pat.h * pat.w + ((x - dc.brushOrgX) & 7) % pat.w]; return mono && !dc.surface.mono ? (v ? bg : fg) : v; };
    }
    const c = this.colorIndex(dc, brush.color);
    return () => c;
  }
  fillRectDev(dc: DC, r: Rect, brushH: number, rop: number = 0xf00021) {
    const b = this.objs.get(brushH); const bp = this.brushPixel(dc, b);
    if (!bp && (rop === 0xf00021)) return;
    for (const c of this.clipRects(dc, r)) this.ropRect(dc, c, bp, rop);
    this.dirty(dc, r);
  }
  // ternary rop on dest with pattern only (PatBlt)
  ropRect(dc: DC, c: Rect, bp: ((x: number, y: number) => number) | null, rop: number) {
    const s = dc.surface, d = s.data, W = s.w; const code = (rop >>> 16) & 0xff;
    const m = s.mono ? 1 : 0xff;
    for (let y = c.t; y < c.b; y++) {
      let o = y * W + c.l;
      for (let x = c.l; x < c.r; x++, o++) {
        const P = bp ? bp(x, y) : 0;
        switch (code) {
          case 0xf0: d[o] = P; break;
          case 0x00: d[o] = s.mono ? 0 : this.nearest(0); break;
          case 0xff: d[o] = s.mono ? 1 : this.nearest(0xffffff); break;
          case 0x55: d[o] = ~d[o] & m; break;
          case 0x5a: d[o] = (d[o] ^ P) & m; break;
          default: d[o] = ternary(code, P, 0, d[o]) & m;
        }
      }
    }
  }

  // ---- lines ----
  penPixel(dc: DC): number | null {
    const p = this.objs.get(dc.pen); if (!p || p.style === 5) return null; return this.colorIndex(dc, p.color);
  }
  plot(dc: DC, x: number, y: number, c: number, rects: Rect[]) {
    for (const r of rects) if (x >= r.l && x < r.r && y >= r.t && y < r.b) {
      const s = dc.surface; const o = y * s.w + x;
      s.data[o] = rop2(dc.rop2, c, s.data[o], s.mono ? 1 : 0xff); return;
    }
  }
  line(dc: DC, x0: number, y0: number, x1: number, y1: number) {
    const c = this.penPixel(dc); if (c === null) return;
    const p = this.objs.get(dc.pen)!; const wdt = Math.max(1, p.width | 0);
    const bb = R(Math.min(x0, x1) - wdt, Math.min(y0, y1) - wdt, Math.max(x0, x1) + wdt + 1, Math.max(y0, y1) + wdt + 1);
    const rects = this.clipRects(dc, bb); if (!rects.length) return;
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, e = dx + dy;
    let x = x0, y = y0; const half = (wdt - 1) >> 1;
    for (;;) {
      if (x === x1 && y === y1) break; // endpoint excluded
      if (wdt === 1) this.plot(dc, x, y, c, rects);
      else for (let yy = -half; yy < wdt - half; yy++) for (let xx = -half; xx < wdt - half; xx++) this.plot(dc, x + xx, y + yy, c, rects);
      const e2 = 2 * e; if (e2 >= dy) { e += dy; x += sx; } if (e2 <= dx) { e += dx; y += sy; }
    }
    this.dirty(dc, bb);
  }

  // ---- blit ----
  blit(dst: DC, dx: number, dy: number, w: number, h: number, src: DC | null, sx: number, sy: number, rop: number, sw?: number, sh?: number) {
    // device coordinates already
    const code = (rop >>> 16) & 0xff;
    const usesSrc = ((code >> 2) ^ code) & 0x33;
    const usesPat = ((code >> 4) ^ code) & 0x0f;
    const bp = usesPat ? this.brushPixel(dst, this.objs.get(dst.brush)) : null;
    if (!usesSrc || !src) { this.fillRectDev(dst, R(dx, dy, dx + w, dy + h), dst.brush, rop); return; }
    const S = src.surface, D = dst.surface;
    let flipX = false, flipY = false;
    if (sw === undefined) { sw = w; sh = h; }
    if (w < 0) { dx += w; w = -w; flipX = !flipX; } if (h < 0) { dy += h; h = -h; flipY = !flipY; }
    if (sw < 0) { sx += sw; sw = -sw; flipX = !flipX; } if (sh! < 0) { sy += sh!; sh = -sh!; flipY = !flipY; }
    if (!w || !h || !sw || !sh) return;
    // color conversion table src->dst
    let conv: Uint8Array | null = null;
    if (S.mono && !D.mono) { conv = new Uint8Array(2); conv[0] = this.colorIndex(dst, dst.text); conv[1] = this.colorIndex(dst, dst.bk); }
    else if (!S.mono && D.mono) { conv = new Uint8Array(256); const bkI = this.colorIndex(src, src.bk); conv[bkI] = 1; }
    const scaleX = sw / w, scaleY = sh! / h;
    const m = D.mono ? 1 : 0xff;
    const dd = D.data, DW = D.w, SW = S.w, SH = S.h;
    let sd = S.data;
    // overlapping copy on the same surface (scrolling): read from a snapshot of the source rows
    if (S === D) { const y0 = Math.max(0, sy), y1 = Math.min(SH, sy + sh!); if (y1 > y0) { const t = new Uint8Array(sd.length); t.set(sd.subarray(y0 * SW, y1 * SW), y0 * SW); sd = t; } }
    for (const c of this.clipRects(dst, R(dx, dy, dx + w, dy + h))) {
      for (let y = c.t; y < c.b; y++) {
        let ry = y - dy; if (flipY) ry = h - 1 - ry;
        const syy = sy + Math.floor(ry * scaleY);
        if (syy < 0 || syy >= SH) continue;
        const srow = syy * SW; let o = y * DW + c.l;
        if (code === 0xcc && !conv && scaleX === 1 && !flipX) {
          const x0 = c.l - dx + sx; let a = x0, b = x0 + (c.r - c.l); let oo = o;
          if (a < 0) { oo -= a; a = 0; } if (b > SW) b = SW; if (b > a) dd.set(sd.subarray(srow + a, srow + b), oo);
          continue;
        }
        for (let x = c.l; x < c.r; x++, o++) {
          let rx = x - dx; if (flipX) rx = w - 1 - rx;
          const sxx = sx + Math.floor(rx * scaleX);
          if (sxx < 0 || sxx >= SW) continue;
          let s = sd[srow + sxx]; if (conv) s = conv[s];
          switch (code) {
            case 0xcc: dd[o] = s; break;
            case 0xee: dd[o] = (dd[o] | s) & m; break;
            case 0x88: dd[o] = dd[o] & s; break;
            case 0x66: dd[o] = (dd[o] ^ s) & m; break;
            case 0x33: dd[o] = ~s & m; break;
            case 0x44: dd[o] = s & ~dd[o] & m; break;
            case 0xbb: dd[o] = (dd[o] | ~s) & m; break;
            case 0x11: dd[o] = ~(dd[o] | s) & m; break;
            default: dd[o] = ternary(code, bp ? bp(x, y) : 0, s, dd[o]) & m;
          }
        }
      }
    }
    this.dirty(dst, R(dx, dy, dx + w, dy + h));
  }

  // ---- DIB helpers ----
  // parse BITMAPINFO at linear address; returns header + color table mapping
  parseBMI(lin: number, usage: number, dc: DC | null) {
    const u8 = this.w.m.mem.u8; const mem = this.w.m.mem;
    const size = mem.r32(lin);
    let w: number, h: number, bpp: number, comp = 0, clrUsed = 0;
    if (size === 12) { w = mem.r16(lin + 4); h = (mem.r16(lin + 6) << 16) >> 16; bpp = mem.r16(lin + 10); }
    else { w = mem.r32(lin + 4) | 0; h = mem.r32(lin + 8) | 0; bpp = mem.r16(lin + 14); comp = mem.r32(lin + 16); clrUsed = mem.r32(lin + 32); }
    const ncol = bpp <= 8 ? (clrUsed || (1 << bpp)) : 0;
    const ct = lin + size; const entSize = size === 12 ? 3 : 4;
    const map = new Uint8Array(256);
    const rgb = new Uint32Array(256);
    for (let i = 0; i < ncol; i++) {
      if (usage === 1) { // DIB_PAL_COLORS
        const idx = mem.r16(ct + i * 2); map[i] = this.xlatFor(dc, idx); rgb[i] = this.indexToRGB(map[i]);
      } else {
        const b = u8[ct + i * entSize], g = u8[ct + i * entSize + 1], r = u8[ct + i * entSize + 2];
        rgb[i] = r | (g << 8) | (b << 16);
        map[i] = dc && dc.surface.mono ? ((r + g + b) >= 0x180 ? 1 : 0) : this.nearest(rgb[i]);
      }
    }
    const tableBytes = usage === 1 ? ncol * 2 : ncol * entSize;
    return { size, w, h, bpp, comp, ncol, map, rgb, bitsOff: size + tableBytes };
  }
  // decode DIB pixels into surface (dest mono or 8bpp); rows bottom-up
  dibToSurface(info: ReturnType<GDI['parseBMI']>, bitsLin: number, dst: Surface, startScan = 0, numScans?: number, dstX = 0, dstY = 0) {
    const u8 = this.w.m.mem.u8; const { w, bpp, map } = info; const H = Math.abs(info.h); const topDown = info.h < 0;
    const stride = ((w * bpp + 31) >>> 5) << 2;
    const n = numScans ?? H;
    let bits = bitsLin;
    let rle: Uint8Array | null = null;
    if (info.comp === 1 || info.comp === 2) { rle = decodeRLE(u8, bitsLin, w, H, info.comp === 1 ? 8 : 4); }
    // only the part that lands on the destination (a broken header must not mean billions of iterations)
    const xs = Math.max(0, -dstX), xe = Math.min(w, dst.w - dstX);
    if (xe <= xs || n <= 0 || n > 65536) return;
    for (let row = 0; row < n; row++) {
      const scan = startScan + row; // scan index from bottom
      const y = topDown ? scan : H - 1 - scan;
      const dy = y + dstY; if (dy < 0 || dy >= dst.h) continue;
      const src = bits + row * stride; const drow = dy * dst.w;
      for (let x = xs; x < xe; x++) {
        const dx = x + dstX;
        let v: number;
        if (rle) v = rle[(H - 1 - scan) * w + x] ?? 0;
        else if (bpp === 8) v = u8[src + x];
        else if (bpp === 4) { const b = u8[src + (x >> 1)]; v = x & 1 ? b & 15 : b >> 4; }
        else if (bpp === 1) v = (u8[src + (x >> 3)] >> (7 - (x & 7))) & 1;
        else if (bpp === 24) { const o = src + x * 3; const rgb = u8[o + 2] | (u8[o + 1] << 8) | (u8[o] << 16); dst.data[drow + dx] = dst.mono ? (rgb === 0xffffff ? 1 : 0) : this.nearest(rgb); continue; }
        else if (bpp === 16) { const p = u8[src + x * 2] | (u8[src + x * 2 + 1] << 8); const rgb = (((p >> 10) & 31) << 3) | ((((p >> 5) & 31) << 3) << 8) | (((p & 31) << 3) << 16); dst.data[drow + dx] = this.nearest(rgb); continue; }
        else v = 0;
        dst.data[drow + dx] = map[v];
      }
    }
    if (rle) return; void bits;
  }
}

function decodeRLE(u8: Uint8Array, p: number, w: number, h: number, bpp: number): Uint8Array {
  if (w <= 0 || h <= 0 || w * h > 1 << 26) return new Uint8Array(0); // broken header
  const out = new Uint8Array(w * h); let x = 0, y = 0; // y from bottom
  for (let guard = 0; guard < w * h * 4 && y < h; guard++) {
    const a = u8[p++], b = u8[p++];
    if (a) { for (let i = 0; i < a; i++) { const v = bpp === 8 ? b : (i & 1 ? b & 15 : b >> 4); if (x < w) out[(h - 1 - y) * w + x] = v; x++; } }
    else if (b === 0) { x = 0; y++; }
    else if (b === 1) break;
    else if (b === 2) { x += u8[p++]; y += u8[p++]; }
    else {
      for (let i = 0; i < b; i++) { let v: number; if (bpp === 8) v = u8[p + i]; else { const bb = u8[p + (i >> 1)]; v = i & 1 ? bb & 15 : bb >> 4; } if (x < w) out[(h - 1 - y) * w + x] = v; x++; }
      const n = bpp === 8 ? b : (b + 1) >> 1; p += (n + 1) & ~1;
    }
  }
  return out;
}

export function ternary(code: number, P: number, S: number, D: number): number {
  let r = 0;
  for (let k = 0; k < 8; k++) {
    if (!((code >> k) & 1)) continue;
    r |= ((k & 4) ? P : ~P) & ((k & 2) ? S : ~S) & ((k & 1) ? D : ~D);
  }
  return r & 0xff;
}
export function rop2(op: number, P: number, D: number, m: number): number {
  switch (op) {
    case 13: return P;            // R2_COPYPEN
    case 1: return 0;             // BLACK
    case 16: return m;            // WHITE
    case 6: return (~D) & m;      // NOT
    case 7: return (P ^ D) & m;   // XORPEN
    case 11: return D;            // NOP
    case 9: return P & D;         // MASKPEN
    case 15: return (P | D) & m;  // MERGEPEN
    case 4: return (~P) & m;      // NOTCOPYPEN
    case 10: return (~(P ^ D)) & m;
  }
  return P;
}

export function glyphFor(ch: number) { return FONT_8x16.subarray(ch * 16, ch * 16 + 16); }
