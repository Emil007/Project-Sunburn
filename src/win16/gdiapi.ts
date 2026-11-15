import type { Win16 } from './win16';
import { sysColor } from './win16';
import type { DC, Rect, Surface } from './gdi';

const R = (l: number, t: number, r: number, b: number): Rect => ({ l, t, r, b });

export function installGdiApi(w: Win16) {
  const m = w.m, mem = m.mem, gdi = w.gdi, u = w.user;
  const G = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('GDI', o, n, a, r, f);
  const D = (h: number) => gdi.dcs.get(h);
  (w as any).sysColorFn = sysColor;
  (w as any).idleCount = 0;

  const selectBitmap = (dc: DC, hb: number) => {
    const o = gdi.objs.get(hb); if (!o || o.type !== 'bitmap') return 0;
    const old = dc.hbitmap; dc.hbitmap = hb; dc.surface = o.surf;
    dc.baseClip = R(0, 0, o.surf.w, o.surf.h); gdi.updateClip(dc);
    return old || gdi.stockMono;
  };
  const memDC = (ref: DC | null) => {
    const mono = gdi.objs.get(gdi.stockMono)!;
    const dc = gdi.makeDC(mono.surf, { isMem: true }); dc.hbitmap = gdi.stockMono; return dc;
  };

  G(1, 'SetBkColor', ['word', 'long'], 'l', ([h, c]) => { const dc = D(h); if (!dc) return 0; const o = dc.bk; dc.bk = c; return o; });
  G(2, 'SetBkMode', ['word', 'word'], 'w', ([h, v]) => { const dc = D(h); if (!dc) return 0; const o = dc.bkMode; dc.bkMode = v; return o; });
  G(3, 'SetMapMode', ['word', 'word'], 'w', ([h, v]) => { const dc = D(h); if (!dc) return 0; const o = dc.mapMode; dc.mapMode = v; return o; });
  G(4, 'SetROP2', ['word', 'word'], 'w', ([h, v]) => { const dc = D(h); if (!dc) return 0; const o = dc.rop2; dc.rop2 = v; return o; });
  G(7, 'SetStretchBltMode', ['word', 'word'], 'w', ([h, v]) => { const dc = D(h); if (!dc) return 0; const o = dc.stretchMode; dc.stretchMode = v; return o; });
  G(9, 'SetTextColor', ['word', 'long'], 'l', ([h, c]) => { const dc = D(h); if (!dc) return 0; const o = dc.text; dc.text = c; return o; });
  G(148, 'SetBrushOrg', ['word', 's_word', 's_word'], 'l', ([h, x, y]) => { const dc = D(h); if (!dc) return 0; const o = ((dc.brushOrgY << 16) | (dc.brushOrgX & 0xffff)) >>> 0; dc.brushOrgX = x; dc.brushOrgY = y; return o; });
  G(149, 'GetBrushOrg', ['word'], 'l', ([h]) => { const dc = D(h); if (!dc) return 0; return ((dc.brushOrgY << 16) | (dc.brushOrgX & 0xffff)) >>> 0; });
  G(19, 'LineTo', ['word', 's_word', 's_word'], 'w', ([h, x, y]) => { const dc = D(h); if (!dc) return 0; gdi.line(dc, gdi.lx(dc, dc.curX), gdi.ly(dc, dc.curY), gdi.lx(dc, x), gdi.ly(dc, y)); dc.curX = x; dc.curY = y; return 1; });
  G(20, 'MoveTo', ['word', 's_word', 's_word'], 'l', ([h, x, y]) => { const dc = D(h); if (!dc) return 0; const o = ((dc.curY << 16) | (dc.curX & 0xffff)) >>> 0; dc.curX = x; dc.curY = y; return o; });
  G(483, 'MoveToEx', ['word', 's_word', 's_word', 'ptr'], 'w', ([h, x, y, p]) => { const dc = D(h); if (!dc) return 0; if (p) { m.w16(p, 0, dc.curX); m.w16(p, 2, dc.curY); } dc.curX = x; dc.curY = y; return 1; });
  G(470, 'GetCurrentPositionEx', ['word', 'ptr'], 'w', ([h, p]) => { const dc = D(h); if (!dc) return 0; m.w16(p, 0, dc.curX); m.w16(p, 2, dc.curY); return 1; });
  G(21, 'ExcludeClipRect', ['word', 's_word', 's_word', 's_word', 's_word'], 'w', ([h, l, t, r, b]) => { const dc = D(h); if (!dc) return 0; dc.excl.push(R(gdi.lx(dc, l), gdi.ly(dc, t), gdi.lx(dc, r), gdi.ly(dc, b))); return 3; });
  G(22, 'IntersectClipRect', ['word', 's_word', 's_word', 's_word', 's_word'], 'w', ([h, l, t, r, b]) => {
    const dc = D(h); if (!dc) return 0; const n = R(gdi.lx(dc, l), gdi.ly(dc, t), gdi.lx(dc, r), gdi.ly(dc, b));
    const c = dc.userClip; dc.userClip = c ? R(Math.max(c.l, n.l), Math.max(c.t, n.t), Math.min(c.r, n.r), Math.min(c.b, n.b)) : n; gdi.updateClip(dc); return 2;
  });
  G(27, 'Rectangle', ['word', 's_word', 's_word', 's_word', 's_word'], 'w', ([h, l, t, r, b]) => {
    const dc = D(h); if (!dc) return 0;
    const L = gdi.lx(dc, l), T = gdi.ly(dc, t), RR = gdi.lx(dc, r), B = gdi.ly(dc, b);
    const pen = gdi.objs.get(dc.pen); const pw = pen && pen.style !== 5 ? Math.max(1, pen.width) : 0;
    gdi.fillRectDev(dc, R(L + pw, T + pw, RR - pw, B - pw), dc.brush);
    if (pw) { const c = gdi.penPixel(dc)!; const pb = gdi.alloc({ type: 'brush', style: 0, color: gdi.indexToRGB(c) });
      gdi.fillRectDev(dc, R(L, T, RR, T + pw), pb); gdi.fillRectDev(dc, R(L, B - pw, RR, B), pb); gdi.fillRectDev(dc, R(L, T, L + pw, B), pb); gdi.fillRectDev(dc, R(RR - pw, T, RR, B), pb); gdi.objs.delete(pb); }
    return 1;
  });
  G(24, 'Ellipse', ['word', 's_word', 's_word', 's_word', 's_word'], 'w', ([h, l, t, r, b]) => {
    const dc = D(h); if (!dc) return 0; const L = gdi.lx(dc, l), T = gdi.ly(dc, t), RR = gdi.lx(dc, r), B = gdi.ly(dc, b);
    const cx = (L + RR) / 2, cy = (T + B) / 2, rx = (RR - L) / 2, ry = (B - T) / 2;
    for (let y = T; y < B; y++) { const dy = (y + 0.5 - cy) / ry; const k = 1 - dy * dy; if (k < 0) continue; const hw = rx * Math.sqrt(k); gdi.fillRectDev(dc, R(Math.round(cx - hw), y, Math.round(cx + hw), y + 1), dc.brush); }
    return 1;
  });
  G(29, 'PatBlt', ['word', 's_word', 's_word', 's_word', 's_word', 'long'], 'w', ([h, x, y, cw, ch, rop]) => {
    const dc = D(h); if (!dc) return 0; const X = gdi.lx(dc, x), Y = gdi.ly(dc, y); let W = gdi.sx(dc, cw), Hh = gdi.sy(dc, ch);
    let x0 = X, y0 = Y; if (W < 0) { x0 += W; W = -W; } if (Hh < 0) { y0 += Hh; Hh = -Hh; }
    gdi.fillRectDev(dc, R(x0, y0, x0 + W, y0 + Hh), dc.brush, rop); return 1;
  });
  G(30, 'SaveDC', ['word'], 'w', ([h]) => { const dc = D(h); if (!dc) return 0; const { saved, ...rest } = dc as any; dc.saved.push({ ...rest, excl: [...dc.excl] }); return dc.saved.length; });
  G(39, 'RestoreDC', ['word', 's_word'], 'w', ([h, n]) => {
    const dc = D(h); if (!dc) return 0; let idx = n < 0 ? dc.saved.length + n : n - 1; if (idx < 0 || idx >= dc.saved.length) return 0;
    const s = dc.saved[idx]; dc.saved.length = idx; const saved = dc.saved; Object.assign(dc, s); dc.saved = saved; dc.h = h;
    const bo = gdi.objs.get(dc.hbitmap); if (bo && dc.isMem) dc.surface = bo.surf; return 1;
  });
  G(31, 'SetPixel', ['word', 's_word', 's_word', 'long'], 'l', ([h, x, y, c]) => {
    const dc = D(h); if (!dc) return 0; const X = gdi.lx(dc, x), Y = gdi.ly(dc, y);
    const idx = gdi.colorIndex(dc, c); if (gdi.clipRects(dc, R(X, Y, X + 1, Y + 1)).length) { dc.surface.data[Y * dc.surface.w + X] = idx; gdi.dirty(dc, R(X, Y, X + 1, Y + 1)); }
    return dc.surface.mono ? (idx ? 0xffffff : 0) : gdi.indexToRGB(idx);
  });
  G(83, 'GetPixel', ['word', 's_word', 's_word'], 'l', ([h, x, y]) => {
    const dc = D(h); if (!dc) return 0xffffffff; const X = gdi.lx(dc, x), Y = gdi.ly(dc, y); const s = dc.surface;
    if (X < 0 || Y < 0 || X >= s.w || Y >= s.h) return 0xffffffff;
    const v = s.data[Y * s.w + X]; return s.mono ? (v ? 0xffffff : 0) : gdi.indexToRGB(v);
  });
  G(34, 'BitBlt', ['word', 's_word', 's_word', 's_word', 's_word', 'word', 's_word', 's_word', 'long'], 'w', ([hd, x, y, cw, ch, hs, sx, sy, rop]) => {
    const dc = D(hd); if (!dc) return 0; const src = hs ? D(hs) || null : null;
    if ((globalThis as any).__bltDbg) console.log(`  blt dst ${dc.surface.w}x${dc.surface.h} bmp ${dc.hbitmap.toString(16)} src ${src ? src.surface.w + 'x' + src.surface.h + ' bmp ' + src.hbitmap.toString(16) : '-'}`);
    gdi.blit(dc, gdi.lx(dc, x), gdi.ly(dc, y), gdi.sx(dc, cw), gdi.sy(dc, ch), src, src ? gdi.lx(src, sx) : 0, src ? gdi.ly(src, sy) : 0, rop, src ? gdi.sx(src, cw) : undefined, src ? gdi.sy(src, ch) : undefined);
    return 1;
  });
  G(35, 'StretchBlt', ['word', 's_word', 's_word', 's_word', 's_word', 'word', 's_word', 's_word', 's_word', 's_word', 'long'], 'w', ([hd, x, y, cw, ch, hs, sx, sy, sw, sh, rop]) => {
    const dc = D(hd); if (!dc) return 0; const src = hs ? D(hs) || null : null;
    gdi.blit(dc, gdi.lx(dc, x), gdi.ly(dc, y), gdi.sx(dc, cw), gdi.sy(dc, ch), src, src ? gdi.lx(src, sx) : 0, src ? gdi.ly(src, sy) : 0, rop, src ? gdi.sx(src, sw) : sw, src ? gdi.sy(src, sh) : sh);
    return 1;
  });
  G(37, 'Polyline', ['word', 'ptr', 'word'], 'w', ([h, p, n]) => {
    const dc = D(h); if (!dc) return 0; const L = m.lin(p); const pt = (i: number) => [(mem.r16(L + i * 4) << 16) >> 16, (mem.r16(L + i * 4 + 2) << 16) >> 16];
    for (let i = 1; i < n; i++) { const [a, b] = pt(i - 1), [c, d] = pt(i); gdi.line(dc, gdi.lx(dc, a), gdi.ly(dc, b), gdi.lx(dc, c), gdi.ly(dc, d)); }
    return 1;
  });
  G(36, 'Polygon', ['word', 'ptr', 'word'], 'w', ([h, p, n]) => {
    const dc = D(h); if (!dc) return 0; const L = m.lin(p); const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([gdi.lx(dc, (mem.r16(L + i * 4) << 16) >> 16), gdi.ly(dc, (mem.r16(L + i * 4 + 2) << 16) >> 16)]);
    // scanline fill
    let minY = Infinity, maxY = -Infinity; for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let y = minY; y < maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y + 0.5 - y1) * (x2 - x1) / (y2 - y1)); }
      xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) gdi.fillRectDev(dc, R(Math.round(xs[k]), y, Math.round(xs[k + 1]), y + 1), dc.brush);
    }
    for (let i = 0; i < n; i++) { const [a, b] = pts[i], [c, d] = pts[(i + 1) % n]; gdi.line(dc, a, b, c, d); }
    return 1;
  });
  G(45, 'SelectObject', ['word', 'word'], 'w', ([h, o]) => {
    const dc = D(h); const ob = gdi.objs.get(o); if (!dc || !ob) return 0;
    switch (ob.type) {
      case 'pen': { const p = dc.pen; dc.pen = o; return p; }
      case 'brush': { const p = dc.brush; dc.brush = o; return p; }
      case 'font': { const p = dc.font; dc.font = o; return p; }
      case 'bitmap': return selectBitmap(dc, o);
      case 'region': return 1;
      case 'palette': { const p = dc.palette; dc.palette = o; return p; }
    }
    return 0;
  });
  G(48, 'CreateBitmap', ['word', 'word', 'word', 'word', 'ptr'], 'w', ([cw, ch, planes, bpp, bits]) => {
    const mono = planes * bpp === 1; const s = gdi.newSurface(cw, ch, mono);
    if (bits) setBitmapBits(s, m.lin(bits), Infinity, mono ? 1 : bpp);
    return gdi.alloc({ type: 'bitmap', surf: s });
  });
  G(47, 'CreateBitmapIndirect', ['ptr'], 'w', ([p]) => { const L = m.lin(p); const cw = mem.r16(L + 2), ch = mem.r16(L + 4), planes = mem.u8[L + 8], bpp = mem.u8[L + 9]; const bits = mem.r32(L + 10); const mono = planes * bpp === 1; const s = gdi.newSurface(cw, ch, mono); if (bits) setBitmapBits(s, m.lin(bits), Infinity, mono ? 1 : bpp); return gdi.alloc({ type: 'bitmap', surf: s }); });
  const setBitmapBits = (s: Surface, lin: number, max: number, bpp: number) => {
    if (bpp === 1 || s.mono) { const stride = ((s.w + 15) >> 4) << 1; for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { if (y * stride + (x >> 3) >= max) return; s.data[y * s.w + x] = (mem.u8[lin + y * stride + (x >> 3)] >> (7 - (x & 7))) & 1; } }
    else { const stride = (s.w + 1) & ~1; for (let y = 0; y < s.h; y++) { if (y * stride >= max) return; s.data.set(mem.u8.subarray(lin + y * stride, lin + y * stride + s.w), y * s.w); } }
  };
  G(106, 'SetBitmapBits', ['word', 'long', 'ptr'], 'l', ([h, n, p]) => { const o = gdi.objs.get(h); if (!o?.surf) return 0; setBitmapBits(o.surf, w.hlin(p, 0), n, o.surf.mono ? 1 : 8); w.composeDirty = true; return n; });
  G(74, 'GetBitmapBits', ['word', 'long', 'ptr'], 'l', ([h, n, p]) => {
    const o = gdi.objs.get(h); if (!o?.surf) return 0; const s: Surface = o.surf; const L = w.hlin(p, 0); let c = 0;
    if (s.mono) { const stride = ((s.w + 15) >> 4) << 1; for (let y = 0; y < s.h; y++) for (let bx = 0; bx < stride; bx++) { if (c >= n) return c; let v = 0; for (let k = 0; k < 8; k++) { const x = bx * 8 + k; v |= (x < s.w && s.data[y * s.w + x] ? 1 : 0) << (7 - k); } mem.u8[L + c++] = v; } }
    else { const stride = (s.w + 1) & ~1; for (let y = 0; y < s.h; y++) for (let x = 0; x < stride; x++) { if (c >= n) return c; mem.u8[L + c++] = x < s.w ? s.data[y * s.w + x] : 0; } }
    return c;
  });
  G(50, 'CreateBrushIndirect', ['ptr'], 'w', ([p]) => { const L = m.lin(p); const st = mem.r16(L), c = mem.r32(L + 2), hatch = mem.r16(L + 6); return makeBrush(st, c, hatch); });
  const makeBrush = (st: number, c: number, hatch: number) => {
    if (st === 3) { const b = gdi.objs.get(hatch); return gdi.alloc({ type: 'brush', style: 3, color: 0, pattern: b?.surf }); }
    if (st === 2) return gdi.alloc({ type: 'brush', style: 0, color: c, hatch }); // hatched -> solid approx
    return gdi.alloc({ type: 'brush', style: st, color: c });
  };
  G(66, 'CreateSolidBrush', ['long'], 'w', ([c]) => gdi.alloc({ type: 'brush', style: 0, color: c }));
  G(60, 'CreatePatternBrush', ['word'], 'w', ([hb]) => makeBrush(3, 0, hb));
  G(58, 'CreateHatchBrush', ['word', 'long'], 'w', ([i, c]) => makeBrush(2, c, i));
  G(61, 'CreatePen', ['word', 'word', 'long'], 'w', ([st, wd, c]) => gdi.alloc({ type: 'pen', style: st, width: wd, color: c }));
  G(62, 'CreatePenIndirect', ['ptr'], 'w', ([p]) => { const L = m.lin(p); return gdi.alloc({ type: 'pen', style: mem.r16(L), width: (mem.r16(L + 2) << 16) >> 16, color: mem.r32(L + 6) }); });
  G(51, 'CreateCompatibleBitmap', ['word', 'word', 'word'], 'w', ([h, cw, ch]) => { const dc = D(h); const mono = dc ? dc.surface.mono && dc.isMem : false; return gdi.alloc({ type: 'bitmap', surf: gdi.newSurface(cw, ch, mono) }); });
  G(52, 'CreateCompatibleDC', ['word'], 'w', ([h]) => memDC(h ? D(h) || null : null).h);
  G(53, 'CreateDC', ['str', 'str', 'str', 'ptr'], 'w', ([d]) => { const s = m.str(d).toUpperCase(); if (s === 'DISPLAY') return gdi.makeDC(gdi.screen).h; return 0; });
  G(153, 'CreateIC', ['str', 'str', 'str', 'ptr'], 'w', ([d]) => { const s = m.str(d).toUpperCase(); if (s === 'DISPLAY') return gdi.makeDC(gdi.screen).h; return 0; });
  G(57, 'CreateFontIndirect', ['ptr'], 'w', ([p]) => {
    const L = m.lin(p); const height = (mem.r16(L) << 16) >> 16, weight = mem.r16(L + 8); const face = mem.readCStr(p >>> 16, (p & 0xffff) + 18, 32);
    return gdi.alloc({ type: 'font', height, weight, italic: mem.u8[L + 10], underline: mem.u8[L + 11], face, raw: mem.u8.slice(L, L + 50) });
  });
  G(56, 'CreateFont', ['s_word', 's_word', 's_word', 's_word', 's_word', 'word', 'word', 'word', 'word', 'word', 'word', 'word', 'word', 'str'], 'w', (a) => gdi.alloc({ type: 'font', height: a[0], weight: a[4], face: m.str(a[13]) }));
  G(68, 'DeleteDC', ['word'], 'w', ([h]) => { gdi.dcs.delete(h); return 1; });
  G(69, 'DeleteObject', ['word'], 'w', ([h]) => { const o = gdi.objs.get(h); if (!o || o.stock) return 0; gdi.objs.delete(h); return 1; });
  G(87, 'GetStockObject', ['word'], 'w', ([i]) => gdi.stock[i] ?? 0);
  G(80, 'GetDeviceCaps', ['word', 's_word'], 'w', ([h, i]) => {
    const dc = D(h); const mono = dc?.surface.mono && dc.isMem;
    const t: Record<number, number> = { 0: 0x300, 2: 1, 4: 208, 6: 156, 8: gdi.screen.w, 10: gdi.screen.h, 12: mono ? 1 : 8, 14: 1, 16: 0, 18: 0, 20: 0, 22: 0, 24: 20, 26: 0, 28: 0, 30: 0, 32: 0, 34: 0, 36: 1, 38: 0x0001 | 0x0008 | 0x0080 | 0x0100 | 0x0200 | 0x0800 | 0x2000, 40: 36, 42: 36, 44: 51, 88: 96, 90: 96, 104: 256, 106: 20, 108: 18 };
    return t[i] ?? 0;
  });
  G(82, 'GetObject', ['word', 's_word', 'ptr'], 'w', ([h, n, p]) => {
    const o = gdi.objs.get(h); if (!o) return 0; const L = m.lin(p);
    if (o.type === 'bitmap') { const s: Surface = o.surf; const vals = [0, s.w, s.h, s.mono ? ((s.w + 15) >> 4) << 1 : (s.w + 1) & ~1]; for (let i = 0; i < 4 && i * 2 < n; i++) mem.w16(L + i * 2, vals[i]); if (n >= 10) { mem.u8[L + 8] = 1; mem.u8[L + 9] = s.mono ? 1 : 8; } if (n >= 14) mem.w32(L + 10, 0); return Math.min(n, 14); }
    if (o.type === 'pen') { mem.w16(L, o.style); mem.w16(L + 2, o.width); mem.w16(L + 4, 0); if (n >= 10) mem.w32(L + 6, o.color); return Math.min(n, 10); }
    if (o.type === 'brush') { mem.w16(L, o.style); if (n >= 6) mem.w32(L + 2, o.color); if (n >= 8) mem.w16(L + 6, 0); return Math.min(n, 8); }
    if (o.type === 'font') { if (o.raw) { mem.u8.set(o.raw.subarray(0, Math.min(n, 50)), L); } else { mem.u8.fill(0, L, L + Math.min(n, 50)); mem.w16(L, o.height); mem.w16(L + 8, o.weight); mem.writeCStr(p >>> 16, (p & 0xffff) + 18, o.face || 'System'); } return Math.min(n, 50); }
    if (o.type === 'palette') { mem.w16(L, o.entries.length / 4); return 2; }
    return 0;
  });
  G(70, 'EnumFonts', ['word', 'str', 'segptr', 'long'], 'w', ([h, f, proc, lp]) => {
    const faces = f ? [m.str(f)] : ['Arial', 'Courier New', 'MS Sans Serif', 'MS Serif', 'System', 'Times New Roman'];
    let r = 1;
    for (const face of faces) {
      const lf = w.scratch(50), tm = w.scratch(32);
      const LL = m.lin(lf); mem.w16(LL, 16); mem.w16(LL + 8, 400); mem.u8[LL + 14] = 0; mem.u8[LL + 17] = 0x22; mem.writeCStr(lf >>> 16, (lf & 0xffff) + 18, face);
      const TL = m.lin(tm); mem.w16(TL, 16); mem.w16(TL + 2, 13); mem.w16(TL + 4, 3); mem.w16(TL + 10, 7); mem.w16(TL + 12, 14); mem.w16(TL + 14, 400);
      r = m.callFar(proc, [[lf, 4], [tm, 4], [4, 2], [lp, 4]], w.mainModule.autoDS) & 0xffff;
      w.scratchRelease(lf);
      if (!r) break;
    }
    return r;
  });
  G(91, 'GetTextExtent', ['word', 'str', 's_word'], 'l', ([h, s, n]) => { const dc = D(h); if (!dc) return 0; const str = m.str(s).slice(0, n); const F = u.fontFor(dc); return ((F.h << 16) | u.textWidth(dc, str)) >>> 0; });
  G(471, 'GetTextExtentPoint', ['word', 'ptr', 's_word', 'ptr'], 'w', ([h, s, n, p]) => { const dc = D(h); if (!dc) return 0; const str = m.str(s).slice(0, Math.max(0, n)); const F = u.fontFor(dc); m.w16(p, 0, u.textWidth(dc, str)); m.w16(p, 2, F.h); return 1; });
  G(93, 'GetTextMetrics', ['word', 'ptr'], 'w', ([h, p]) => {
    const dc = D(h); if (!dc) return 0; const F = u.fontFor(dc); const L = m.lin(p); mem.u8.fill(0, L, L + 31);
    const avg = Math.round(F.w[120]); mem.w16(L, F.h); mem.w16(L + 2, F.asc); mem.w16(L + 4, F.h - F.asc); mem.w16(L + 6, 0); mem.w16(L + 8, 0); mem.w16(L + 10, avg); mem.w16(L + 12, Math.max(...F.w)); mem.w16(L + 14, 400);
    mem.u8[L + 20] = 32; mem.u8[L + 21] = 255; mem.u8[L + 22] = 32; mem.u8[L + 23] = 32; mem.u8[L + 24] = 0x22; return 1;
  });
  G(92, 'GetTextFace', ['word', 's_word', 'ptr'], 'w', ([h, n, p]) => { const dc = D(h); const f = dc ? gdi.objs.get(dc.font) : null; return mem.writeCStr(p >>> 16, p & 0xffff, f?.face || 'System', n); });
  G(33, 'TextOut', ['word', 's_word', 's_word', 'str', 's_word'], 'w', ([h, x, y, s, n]) => { const dc = D(h); if (!dc) return 0; u.drawString(dc, gdi.lx(dc, x), gdi.ly(dc, y), m.str(s).slice(0, n)); return 1; });
  G(351, 'ExtTextOut', ['word', 's_word', 's_word', 'word', 'ptr', 'str', 'word', 'ptr'], 'w', ([h, x, y, fl, pr, s, n]) => {
    const dc = D(h); if (!dc) return 0;
    if (pr && (fl & 2)) { const L = m.lin(pr); const r = R(gdi.lx(dc, (mem.r16(L) << 16) >> 16), gdi.ly(dc, (mem.r16(L + 2) << 16) >> 16), gdi.lx(dc, (mem.r16(L + 4) << 16) >> 16), gdi.ly(dc, (mem.r16(L + 6) << 16) >> 16)); const b = gdi.alloc({ type: 'brush', style: 0, color: dc.bk }); gdi.fillRectDev(dc, r, b); gdi.objs.delete(b); }
    u.drawString(dc, gdi.lx(dc, x), gdi.ly(dc, y), m.str(s).slice(0, n)); return 1;
  });
  G(104, 'RectVisible', ['word', 'ptr'], 'w', ([h, p]) => {
    const dc = D(h); if (!dc) return 0; const L = m.lin(p); const s = (o: number) => (mem.r16(L + o) << 16) >> 16;
    const r = R(gdi.lx(dc, s(0)), gdi.ly(dc, s(2)), gdi.lx(dc, s(4)), gdi.ly(dc, s(6))); return gdi.clipRects(dc, r).length ? 1 : 0;
  });
  G(128, 'MulDiv', ['s_word', 's_word', 's_word'], 'w', ([a, b, c]) => c === 0 ? 0xffff : Math.round(a * b / c) & 0xffff);
  G(150, 'UnrealizeObject', ['word'], 'w', () => 1);
  G(123, 'PlayMetaFile', ['word', 'word'], 'w', () => 1);
  G(127, 'DeleteMetaFile', ['word'], 'w', () => 1);
  G(151, 'CopyMetaFile', ['word', 'str'], 'w', ([h]) => h);
  G(159, 'GetMetaFileBits', ['word'], 'w', ([h]) => h);
  G(196, 'SetMetaFileBitsBetter', ['word'], 'w', ([h]) => h);
  G(360, 'CreatePalette', ['ptr'], 'w', ([p]) => {
    const L = m.lin(p); const n = mem.r16(L + 2); const e = new Uint8Array(n * 4); e.set(mem.u8.subarray(L + 4, L + 4 + n * 4)); return gdi.alloc({ type: 'palette', entries: e });
  });
  G(363, 'GetPaletteEntries', ['word', 'word', 'word', 'ptr'], 'w', ([h, start, n, p]) => {
    const o = gdi.objs.get(h); if (!o) return 0; const e: Uint8Array = o.entries; const cnt = Math.min(n, e.length / 4 - start); if (!p) return e.length / 4;
    if (cnt <= 0) return 0; mem.u8.set(e.subarray(start * 4, (start + cnt) * 4), m.lin(p)); return cnt;
  });
  G(364, 'SetPaletteEntries', ['word', 'word', 'word', 'ptr'], 'w', ([h, start, n, p]) => { const o = gdi.objs.get(h); if (!o) return 0; const e: Uint8Array = o.entries; const L = m.lin(p); for (let i = 0; i < n && start + i < e.length / 4; i++) e.set(mem.u8.subarray(L + i * 4, L + i * 4 + 4), (start + i) * 4); return n; });
  G(367, 'AnimatePalette', ['word', 'word', 'word', 'ptr'], 'v', ([h, start, n, p]) => { const o = gdi.objs.get(h); if (!o) return; const e: Uint8Array = o.entries; const L = m.lin(p); for (let i = 0; i < n; i++) e.set(mem.u8.subarray(L + i * 4, L + i * 4 + 4), (start + i) * 4); gdi.realize(o); w.composeDirty = true; });
  G(375, 'GetSystemPaletteEntries', ['word', 'word', 'word', 'ptr'], 'w', ([, start, n, p]) => { const L = m.lin(p); for (let i = 0; i < n; i++) { const k = (start + i) & 255; mem.u8[L + i * 4] = gdi.sysPal[k * 4]; mem.u8[L + i * 4 + 1] = gdi.sysPal[k * 4 + 1]; mem.u8[L + i * 4 + 2] = gdi.sysPal[k * 4 + 2]; mem.u8[L + i * 4 + 3] = 0; } return n; });
  G(370, 'GetNearestPaletteIndex', ['word', 'long'], 'w', ([h, c]) => { const o = gdi.objs.get(h); if (!o) return 0; const e: Uint8Array = o.entries; let best = 0, bd = 1e9; for (let i = 0; i < e.length / 4; i++) { const d = (e[i * 4] - (c & 255)) ** 2 + (e[i * 4 + 1] - ((c >> 8) & 255)) ** 2 + (e[i * 4 + 2] - ((c >> 16) & 255)) ** 2; if (d < bd) { bd = d; best = i; } } return best; });
  G(154, 'GetNearestColor', ['word', 'long'], 'l', ([h, c]) => { const dc = D(h); return gdi.indexToRGB(gdi.colorIndex(dc || null, c)); });
  G(378, 'EndDoc', ['word'], 'w', () => 0);
  G(380, 'EndPage', ['word'], 'w', () => 0);
  G(473, 'GetViewportOrgEx', ['word', 'ptr'], 'w', ([h, p]) => { const dc = D(h); if (!dc) return 0; m.w16(p, 0, dc.vpOrgX); m.w16(p, 2, dc.vpOrgY); return 1; });
  G(480, 'SetViewportOrgEx', ['word', 's_word', 's_word', 'ptr'], 'w', ([h, x, y, p]) => { const dc = D(h); if (!dc) return 0; if (p) { m.w16(p, 0, dc.vpOrgX); m.w16(p, 2, dc.vpOrgY); } dc.vpOrgX = x; dc.vpOrgY = y; return 1; });
  G(479, 'SetViewportExtEx', ['word', 's_word', 's_word', 'ptr'], 'w', ([h, x, y, p]) => { const dc = D(h); if (!dc) return 0; if (p) { m.w16(p, 0, dc.vpExtX); m.w16(p, 2, dc.vpExtY); } if (dc.mapMode >= 7) { dc.vpExtX = x || 1; dc.vpExtY = y || 1; } return 1; });
  G(481, 'SetWindowExtEx', ['word', 's_word', 's_word', 'ptr'], 'w', ([h, x, y, p]) => { const dc = D(h); if (!dc) return 0; if (p) { m.w16(p, 0, dc.winExtX); m.w16(p, 2, dc.winExtY); } if (dc.mapMode >= 7) { dc.winExtX = x || 1; dc.winExtY = y || 1; } return 1; });
  G(482, 'SetWindowOrgEx', ['word', 's_word', 's_word', 'ptr'], 'w', ([h, x, y, p]) => { const dc = D(h); if (!dc) return 0; if (p) { m.w16(p, 0, dc.winOrgX); m.w16(p, 2, dc.winOrgY); } dc.winOrgX = x; dc.winOrgY = y; return 1; });
  G(11, 'SetWindowOrg', ['word', 's_word', 's_word'], 'l', ([h, x, y]) => { const dc = D(h); if (!dc) return 0; const o = ((dc.winOrgY << 16) | (dc.winOrgX & 0xffff)) >>> 0; dc.winOrgX = x; dc.winOrgY = y; return o; });
  G(13, 'SetViewportOrg', ['word', 's_word', 's_word'], 'l', ([h, x, y]) => { const dc = D(h); if (!dc) return 0; const o = ((dc.vpOrgY << 16) | (dc.vpOrgX & 0xffff)) >>> 0; dc.vpOrgX = x; dc.vpOrgY = y; return o; });

  // ---- DIBs ----
  G(442, 'CreateDIBitmap', ['word', 'ptr', 'long', 'ptr', 'ptr', 'word'], 'w', ([h, pbih, init, bits, pbmi, usage]) => {
    const dc = D(h) || null; const L = m.lin(pbih);
    const size = mem.r32(L); const bw = size === 12 ? mem.r16(L + 4) : mem.r32(L + 4) | 0; const bh = Math.abs(size === 12 ? (mem.r16(L + 6) << 16) >> 16 : mem.r32(L + 8) | 0);
    const bpp = size === 12 ? mem.r16(L + 10) : mem.r16(L + 14);
    const s = gdi.newSurface(bw, bh, bpp === 1 && false);
    if ((init & 4) && bits && pbmi) { const info = gdi.parseBMI(m.lin(pbmi), usage, dc); gdi.dibToSurface(info, w.hlin(bits, 0), s); }
    return gdi.alloc({ type: 'bitmap', surf: s });
  });
  G(441, 'GetDIBits', ['word', 'word', 'word', 'word', 'ptr', 'ptr', 'word'], 'w', ([h, hb, start, lines, bits, pbmi, usage]) => {
    const o = gdi.objs.get(hb); if (!o?.surf) return 0; const s: Surface = o.surf; const L = m.lin(pbmi);
    let bpp = mem.r16(L + 14);
    if (!bpp) { mem.w32(L + 4, s.w); mem.w32(L + 8, s.h); mem.w16(L + 12, 1); mem.w16(L + 14, s.mono ? 1 : 8); mem.w32(L + 16, 0); bpp = s.mono ? 1 : 8; }
    const ncol = bpp <= 8 ? 1 << bpp : 0; const hsz = mem.r32(L);
    mem.w32(L + 20, (((s.w * bpp + 31) >>> 5) << 2) * s.h);
    // color table
    for (let i = 0; i < ncol; i++) {
      if (usage === 1) mem.w16(L + hsz + i * 2, i);
      else { let rgb: number; if (s.mono) rgb = i ? 0xffffff : 0; else rgb = gdi.indexToRGB(i); mem.u8[L + hsz + i * 4] = (rgb >> 16) & 255; mem.u8[L + hsz + i * 4 + 1] = (rgb >> 8) & 255; mem.u8[L + hsz + i * 4 + 2] = rgb & 255; mem.u8[L + hsz + i * 4 + 3] = 0; }
    }
    if (!bits) return s.h;
    const out = w.hlin(bits, 0); const stride = ((s.w * bpp + 31) >>> 5) << 2;
    const n = Math.min(lines, s.h - start);
    for (let row = 0; row < n; row++) {
      const y = s.h - 1 - (start + row); const dst = out + row * stride; mem.u8.fill(0, dst, dst + stride);
      for (let x = 0; x < s.w; x++) {
        const v = s.data[y * s.w + x];
        if (bpp === 8) mem.u8[dst + x] = v;
        else if (bpp === 1) { const bit = s.mono ? v : (v === gdi.nearest(0xffffff) ? 1 : 0); if (bit) mem.u8[dst + (x >> 3)] |= 0x80 >> (x & 7); }
        else if (bpp === 4) { const q = v & 15; mem.u8[dst + (x >> 1)] |= x & 1 ? q : q << 4; }
        else if (bpp === 24) { const rgb = s.mono ? (v ? 0xffffff : 0) : gdi.indexToRGB(v); mem.u8[dst + x * 3] = (rgb >> 16) & 255; mem.u8[dst + x * 3 + 1] = (rgb >> 8) & 255; mem.u8[dst + x * 3 + 2] = rgb & 255; }
      }
    }
    return n;
  });
  G(440, 'SetDIBits', ['word', 'word', 'word', 'word', 'ptr', 'ptr', 'word'], 'w', ([h, hb, start, lines, bits, pbmi, usage]) => {
    const o = gdi.objs.get(hb); if (!o?.surf) return 0; const info = gdi.parseBMI(m.lin(pbmi), usage, D(h) || null);
    gdi.dibToSurface(info, w.hlin(bits, 0), o.surf, start, lines); w.composeDirty = true; return lines;
  });
  G(439, 'StretchDIBits', ['word', 's_word', 's_word', 's_word', 's_word', 's_word', 's_word', 's_word', 's_word', 'ptr', 'ptr', 'word', 'long'], 'w', ([h, dx, dy, dw, dh, sx, sy, sw, sh, bits, pbmi, usage, rop]) => {
    const dc = D(h); if (!dc) return 0; const info = gdi.parseBMI(m.lin(pbmi), usage, dc);
    const tmp = gdi.newSurface(info.w, Math.abs(info.h), false); gdi.dibToSurface(info, w.hlin(bits, 0), tmp);
    const tdc = gdi.makeDC(tmp, { isMem: true });
    // DIB source y is bottom-up
    const syTop = Math.abs(info.h) - sy - sh;
    gdi.blit(dc, gdi.lx(dc, dx), gdi.ly(dc, dy), gdi.sx(dc, dw), gdi.sy(dc, dh), tdc, sx, syTop, rop, sw, sh);
    gdi.dcs.delete(tdc.h); return sh;
  });
  G(443, 'SetDIBitsToDevice', ['word', 's_word', 's_word', 's_word', 's_word', 's_word', 's_word', 'word', 'word', 'ptr', 'ptr', 'word'], 'w', ([h, dx, dy, cw, ch, sx, sy, start, lines, bits, pbmi, usage]) => {
    const dc = D(h); if (!dc) return 0; const info = gdi.parseBMI(m.lin(pbmi), usage, dc); const H = Math.abs(info.h);
    const tmp = gdi.newSurface(info.w, H, false); gdi.dibToSurface(info, w.hlin(bits, 0), tmp, start, lines);
    const tdc = gdi.makeDC(tmp, { isMem: true }); gdi.blit(dc, gdi.lx(dc, dx), gdi.ly(dc, dy), cw, ch, tdc, sx, H - sy - ch, 0xcc0020); gdi.dcs.delete(tdc.h); return lines;
  });

  // ---- resources: bitmaps, cursors, icons ----
  w.loadBitmapRes = (hi: number, n: number) => {
    if (!hi) { // OBM_* system bitmaps: return small blank
      return gdi.alloc({ type: 'bitmap', surf: gdi.newSurface(16, 16, false) });
    }
    const r = w.findResource(hi, n, 2); const d = r ? w.resData(r) : undefined; if (!d) return 0;
    // copy DIB into emulated memory to reuse parse helpers
    const tmp = w.scratch(d.length); mem.u8.set(d, m.lin(tmp));
    const info = gdi.parseBMI(m.lin(tmp), 0, null); const s = gdi.newSurface(info.w, Math.abs(info.h), false);
    gdi.dibToSurface(info, m.lin(tmp) + info.bitsOff, s); w.scratchRelease(tmp);
    return gdi.alloc({ type: 'bitmap', surf: s });
  };
  const builtinCursor = (id: number) => {
    // simple arrow / hand / cross etc. drawn procedurally
    const W = 32, Hh = 32; const rgba = new Uint8Array(W * Hh * 4);
    const set = (x: number, y: number, c: number) => { const o = (y * W + x) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = c; rgba[o + 3] = 255; };
    let hx = 0, hy = 0;
    if (id === 32514) { // wait
      for (let y = 4; y < 20; y++) for (let x = 4; x < 16; x++) set(x, y, (y === 4 || y === 19 || x === 4 || x === 15) ? 0 : 255);
      hx = 10; hy = 12;
    } else if (id === 32515) { for (let i = 0; i < 21; i++) { set(i, 10, 0); set(10, i, 0); } hx = 10; hy = 10; }
    else {
      const arrow = ['X', 'XX', 'X.X', 'X..X', 'X...X', 'X....X', 'X.....X', 'X......X', 'X.......X', 'X........X', 'X.....XXXXX', 'X..X..X', 'X.X X..X', 'XX  X..X', 'X    X..X', '     X..X', '      X..X', '      XXX'];
      arrow.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'X') set(x, y, 0); else if (ch === '.') set(x, y, 255); }));
    }
    return { w: W, h: Hh, hx, hy, rgba, id };
  };
  let nextCur = 0x5000;
  w.loadCursor = (hi: number, n: number) => {
    if (!hi || (n >>> 16) === 0 && (n & 0xffff) >= 32512 && !w.findResource(hi, n, 12)) {
      const id = n & 0xffff; const h = 0x4000 + (id - 32512) * 2;
      if (!w.cursorImages.has(h)) w.cursorImages.set(h, builtinCursor(id));
      return h;
    }
    const g = w.findResource(hi, n, 12); const gd = g ? w.resData(g) : undefined; if (!gd) return w.loadCursor(0, 32512);
    // group cursor: first entry's resource id at offset 6+12
    const cnt = gd[4] | (gd[5] << 8); if (!cnt) return w.loadCursor(0, 32512);
    const rid = gd[6 + 12] | (gd[6 + 13] << 8);
    const cr = w.findResource(hi, rid, 1); const cd = cr ? w.resData(cr) : undefined; if (!cd) return w.loadCursor(0, 32512);
    const h = nextCur; nextCur += 2;
    w.cursorImages.set(h, decodeCursor(cd, h));
    return h;
  };
  w.loadIcon = (hi: number, n: number) => 0x4800 + ((n & 0xff) * 2);
  w.drawIcon = () => {};
  w.arrowCursor = w.loadCursor(0, 32512);
}

function decodeCursor(d: Uint8Array, id: number) {
  const hx = d[0] | (d[1] << 8), hy = d[2] | (d[3] << 8); const p = 4;
  const rd32 = (o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  const hs = rd32(p), W = rd32(p + 4), H2 = rd32(p + 8), bpp = d[p + 14] | (d[p + 15] << 8);
  const H = H2 / 2; const ncol = bpp <= 8 ? 1 << bpp : 0; const ct = p + hs; const xorOff = ct + ncol * 4;
  const xs = ((W * bpp + 31) >>> 5) << 2; const as = ((W + 31) >>> 5) << 2; const andOff = xorOff + xs * H;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const row = H - 1 - y; const a = (d[andOff + row * as + (x >> 3)] >> (7 - (x & 7))) & 1;
    let ci: number; if (bpp === 1) ci = (d[xorOff + row * xs + (x >> 3)] >> (7 - (x & 7))) & 1; else if (bpp === 4) { const b = d[xorOff + row * xs + (x >> 1)]; ci = x & 1 ? b & 15 : b >> 4; } else ci = d[xorOff + row * xs + x];
    const o = (y * W + x) * 4; const r = d[ct + ci * 4 + 2], g = d[ct + ci * 4 + 1], b = d[ct + ci * 4];
    if (a === 0) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
    else if (r | g | b) { rgba[o] = 255 - r; rgba[o + 1] = 255 - g; rgba[o + 2] = 255 - b; rgba[o + 3] = 255; } // inverted -> approximate
  }
  return { w: W, h: H, hx, hy, rgba, id };
}
