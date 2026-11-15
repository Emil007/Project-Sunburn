import type { Win16 } from './win16';
import { WM } from './user';
import type { Rect } from './gdi';

const R = (l: number, t: number, r: number, b: number): Rect => ({ l, t, r, b });

export function installUserApi(w: Win16) {
  const m = w.m, mem = m.mem, u = w.user, gdi = w.gdi;
  const U = (o: number, n: string, a: any[], r: any, f: (a: number[]) => any) => m.defNative('USER', o, n, a, r, f);
  const rdRect = (p: number): Rect => { const L = m.lin(p); const s = (o: number) => (mem.r16(L + o) << 16) >> 16; return R(s(0), s(2), s(4), s(6)); };
  const wrRect = (p: number, r: Rect) => { const L = m.lin(p); mem.w16(L, r.l); mem.w16(L + 2, r.t); mem.w16(L + 4, r.r); mem.w16(L + 6, r.b); };
  const H = (h: number) => u.get(h);

  // builtin window classes needed by VCL (none of standard controls used by the game, but provide basics)
  for (const name of ['BUTTON', 'STATIC', 'EDIT', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', 'MDICLIENT', '#32770']) {
    u.registerClass({ name, style: 0, proc: 0, clsExtra: 0, wndExtra: 8, hInst: 0, icon: 0, cursor: 0, brush: 6, menuName: 0, atom: 0 });
  }
  const defProcFp = m.makeNativeProc('DefWindowProc', ['word', 'word', 'word', 'long'], 'l', ([h, msg, wp, lp]) => u.defProc(h, msg, wp, lp));
  for (const c of u.classes.values()) c.proc = defProcFp;

  U(5, 'InitApp', ['word'], 'w', () => 1);
  U(1, 'MessageBox', ['word', 'str', 'str', 'word'], 'w', ([, t, c, ty]) => { w.present(true); return w.platform.messageBox(m.str(t), m.str(c), ty); });
  U(6, 'PostQuitMessage', ['word'], 'v', ([c]) => { u.quit = true; u.quitCode = c; });
  U(10, 'SetTimer', ['word', 'word', 'word', 'segptr'], 'w', ([h, id, ms, p]) => u.setTimer(h, id, ms, p));
  U(12, 'KillTimer', ['word', 'word'], 'w', ([h, id]) => u.killTimer(h, id));
  U(13, 'GetTickCount', [], 'l', () => Math.floor(w.platform.now()) >>> 0);
  U(14, 'GetTimerResolution', [], 'l', () => 1000);
  U(17, 'GetCursorPos', ['ptr'], 'v', ([p]) => { const L = m.lin(p); mem.w16(L, u.mouseX); mem.w16(L + 2, u.mouseY); });
  U(18, 'SetCapture', ['word'], 'w', ([h]) => { const p = u.capture; u.capture = h; return p; });
  U(19, 'ReleaseCapture', [], 'v', () => { const p = u.capture; u.capture = 0; if (p) u.send(p, WM.CANCELMODE, 0, 0); });
  U(236, 'GetCapture', [], 'w', () => u.capture);
  U(22, 'SetFocus', ['word'], 'w', ([h]) => u.setFocus(h));
  U(23, 'GetFocus', [], 'w', () => u.focus);
  U(24, 'RemoveProp', ['word', 'ptr'], 'w', ([h, p]) => { const wd = H(h); if (!wd) return 0; const k = u.propKey(p); const v = wd.props.get(k) ?? 0; wd.props.delete(k); return v; });
  U(25, 'GetProp', ['word', 'str'], 'w', ([h, p]) => H(h)?.props.get(u.propKey(p)) ?? 0);
  U(26, 'SetProp', ['word', 'str', 'word'], 'w', ([h, p, v]) => { const wd = H(h); if (!wd) return 0; wd.props.set(u.propKey(p), v); return 1; });
  U(28, 'ClientToScreen', ['word', 'ptr'], 'v', ([h, p]) => { const wd = H(h); if (!wd) return; const L = m.lin(p); const [x, y] = u.clientToScreen(wd, (mem.r16(L) << 16) >> 16, (mem.r16(L + 2) << 16) >> 16); mem.w16(L, x); mem.w16(L + 2, y); });
  U(29, 'ScreenToClient', ['word', 'ptr'], 'v', ([h, p]) => { const wd = H(h); if (!wd) return; const L = m.lin(p); const [ox, oy] = u.clientToScreen(wd, 0, 0); mem.w16(L, ((mem.r16(L) << 16) >> 16) - ox); mem.w16(L + 2, ((mem.r16(L + 2) << 16) >> 16) - oy); });
  U(30, 'WindowFromPoint', ['long'], 'w', ([pt]) => u.windowAt((pt << 16) >> 16, pt >> 16)?.h ?? 0);
  U(31, 'IsIconic', ['word'], 'w', ([h]) => H(h)?.minimized ? 1 : 0);
  U(272, 'IsZoomed', ['word'], 'w', ([h]) => H(h)?.maximized ? 1 : 0);
  U(32, 'GetWindowRect', ['word', 'ptr'], 'v', ([h, p]) => {
    const wd = h ? H(h) : u.desktop; if (!wd) return;
    if (!h) { wrRect(p, R(0, 0, u.desktop.w, u.desktop.h_)); return; }
    const [x, y] = u.screenOrg(wd); wrRect(p, R(x, y, x + wd.w, y + wd.h_));
  });
  U(33, 'GetClientRect', ['word', 'ptr'], 'v', ([h, p]) => { const wd = h ? H(h) : u.desktop; if (!wd) { wrRect(p, R(0, 0, 0, 0)); return; } wrRect(p, h ? u.clientRect(wd) : R(0, 0, u.desktop.w, u.desktop.h_)); });
  U(34, 'EnableWindow', ['word', 'word'], 'w', ([h, en]) => {
    const wd = H(h); if (!wd) return 0; const was = (wd.style & 0x08000000) !== 0;
    if (en) wd.style &= ~0x08000000; else { wd.style |= 0x08000000; if (u.focus === h) u.setFocus(0); }
    if (was === !!en) u.send(h, WM.ENABLE, en ? 1 : 0, 0);
    return was ? 1 : 0;
  });
  U(35, 'IsWindowEnabled', ['word'], 'w', ([h]) => { const wd = H(h); return wd && !(wd.style & 0x08000000) ? 1 : 0; });
  U(36, 'GetWindowText', ['word', 'segptr', 'word'], 'w', ([h, p, n]) => u.send(h, WM.GETTEXT, n, p));
  U(37, 'SetWindowText', ['word', 'segstr'], 'v', ([h, p]) => { u.send(h, WM.SETTEXT, 0, p); });
  U(38, 'GetWindowTextLength', ['word'], 'w', ([h]) => u.send(h, WM.GETTEXTLENGTH, 0, 0));
  U(39, 'BeginPaint', ['word', 'ptr'], 'w', ([h, p]) => u.beginPaint(h, p));
  U(40, 'EndPaint', ['word', 'ptr'], 'v', ([h, p]) => { u.endPaint(h, p); });
  U(41, 'CreateWindow', ['str', 'str', 'long', 's_word', 's_word', 's_word', 's_word', 'word', 'word', 'word', 'segptr'], 'w',
    ([c, t, st, x, y, cw, ch, p, mn, hi, pa]) => u.create(0, clsName(c), m.str(t), st, x, y, cw, ch, p, mn, hi, pa));
  U(452, 'CreateWindowEx', ['long', 'str', 'str', 'long', 's_word', 's_word', 's_word', 's_word', 'word', 'word', 'word', 'segptr'], 'w',
    ([ex, c, t, st, x, y, cw, ch, p, mn, hi, pa]) => u.create(ex, clsName(c), m.str(t), st, x, y, cw, ch, p, mn, hi, pa));
  const clsName = (p: number) => (p >>> 16) === 0 ? (u.atomNames.get(p & 0xffff) ?? `#${p & 0xffff}`) : m.str(p);
  U(42, 'ShowWindow', ['word', 'word'], 'w', ([h, c]) => u.show(h, c));
  U(45, 'BringWindowToTop', ['word'], 'w', ([h]) => { const wd = H(h); if (wd) { u.bringToTop(wd); if (u.isTop(wd)) u.activate(h, false); } return 1; });
  U(46, 'GetParent', ['word'], 'w', ([h]) => { const wd = H(h); if (!wd) return 0; return (wd.style & 0x40000000) ? wd.parent?.h ?? 0 : wd.owner?.h ?? 0; });
  U(47, 'IsWindow', ['word'], 'w', ([h]) => H(h) ? 1 : 0);
  U(48, 'IsChild', ['word', 'word'], 'w', ([p, c]) => { const pw = H(p), cw = H(c); if (!pw || !cw || cw === pw) return 0; return u.isChildOf(cw, pw) ? 1 : 0; });
  U(49, 'IsWindowVisible', ['word'], 'w', ([h]) => { const wd = H(h); return wd && u.isVisible(wd) ? 1 : 0; });
  U(53, 'DestroyWindow', ['word'], 'w', ([h]) => u.destroy(h));
  U(54, 'EnumWindows', ['segptr', 'long'], 'w', ([p, lp]) => { for (const t of [...u.tops]) { if (!m.callFar(p, [[t.h, 2], [lp, 4]], w.mainModule.autoDS) && true) { if (!(m.cpu.ax)) break; } } return 1; });
  U(225, 'EnumTaskWindows', ['word', 'segptr', 'long'], 'w', ([, p, lp]) => { for (const t of [...u.tops]) { const r = m.callFar(p, [[t.h, 2], [lp, 4]], w.mainModule.autoDS); if (!(r & 0xffff)) break; } return 1; });
  U(57, 'RegisterClass', ['ptr'], 'w', ([p]) => {
    const L = m.lin(p);
    const cls = { style: mem.r16(L), proc: mem.r32(L + 2), clsExtra: (mem.r16(L + 6) << 16) >> 16, wndExtra: (mem.r16(L + 8) << 16) >> 16, hInst: mem.r16(L + 10), icon: mem.r16(L + 12), cursor: mem.r16(L + 14), brush: mem.r16(L + 16), menuName: mem.r32(L + 18), name: clsName(mem.r32(L + 22)), atom: 0 };
    if (cls.wndExtra < 0) cls.wndExtra = 0;
    return u.registerClass(cls);
  });
  U(58, 'UnregisterClass', ['str', 'word'], 'w', ([p]) => { u.classes.delete(clsName(p).toUpperCase()); return 1; });
  U(404, 'GetClassInfo', ['word', 'segstr', 'ptr'], 'w', ([, n, p]) => {
    const c = u.findClass(clsName(n)); if (!c) return 0; const L = m.lin(p);
    mem.w16(L, c.style); mem.w32(L + 2, c.proc); mem.w16(L + 6, c.clsExtra); mem.w16(L + 8, c.wndExtra); mem.w16(L + 10, c.hInst); mem.w16(L + 12, c.icon); mem.w16(L + 14, c.cursor); mem.w16(L + 16, c.brush); mem.w32(L + 18, c.menuName); mem.w32(L + 22, n);
    return 1;
  });
  U(59, 'SetActiveWindow', ['word'], 'w', ([h]) => { const p = u.active; u.activate(h, false); return p; });
  U(60, 'GetActiveWindow', [], 'w', () => u.active);
  U(61, 'ScrollWindow', ['word', 's_word', 's_word', 'ptr', 'ptr'], 'v', ([h, dx, dy, pr, pc]) => {
    const wd = H(h); if (!wd) return;
    const cr = u.clientRect(wd); let r = pr ? rdRect(pr) : cr; if (pc) { const c = rdRect(pc); r = R(Math.max(r.l, c.l), Math.max(r.t, c.t), Math.min(r.r, c.r), Math.min(r.b, c.b)); }
    const dc = u.windowDC(wd); const sx = r.l + dc.orgX, sy = r.t + dc.orgY;
    const tmp = gdi.newSurface(r.r - r.l, r.b - r.t, false);
    const s = dc.surface; for (let y = 0; y < tmp.h; y++) tmp.data.set(s.data.subarray((sy + y) * s.w + sx, (sy + y) * s.w + sx + tmp.w), y * tmp.w);
    const tdc = gdi.makeDC(tmp); tdc.isMem = true;
    gdi.blit(dc, sx + dx, sy + dy, tmp.w, tmp.h, tdc, 0, 0, 0xcc0020); gdi.dcs.delete(tdc.h); w.releaseDC(dc.h);
    // invalidate exposed strips
    if (dx > 0) u.invalidate(h, R(r.l, r.t, r.l + dx, r.b), true); else if (dx < 0) u.invalidate(h, R(r.r + dx, r.t, r.r, r.b), true);
    if (dy > 0) u.invalidate(h, R(r.l, r.t, r.r, r.t + dy), true); else if (dy < 0) u.invalidate(h, R(r.l, r.b + dy, r.r, r.b), true);
    for (const c of wd.children) { c.x += dx; c.y += dy; }
  });
  U(62, 'SetScrollPos', ['word', 'word', 's_word', 'word'], 'w', ([h, bar, pos]) => { const wd = H(h); if (!wd) return 0; const s = wd.scroll[bar] ||= { pos: 0, min: 0, max: 100 }; const o = s.pos; s.pos = pos; return o; });
  U(63, 'GetScrollPos', ['word', 'word'], 'w', ([h, bar]) => H(h)?.scroll[bar]?.pos ?? 0);
  U(64, 'SetScrollRange', ['word', 'word', 's_word', 's_word', 'word'], 'v', ([h, bar, a, b]) => { const wd = H(h); if (!wd) return; const s = wd.scroll[bar] ||= { pos: 0, min: 0, max: 100 }; s.min = a; s.max = b; });
  U(65, 'GetScrollRange', ['word', 'word', 'ptr', 'ptr'], 'v', ([h, bar, pa, pb]) => { const s = H(h)?.scroll[bar] || { min: 0, max: 0 }; m.w16(pa, 0, s.min); m.w16(pb, 0, s.max); });
  U(66, 'GetDC', ['word'], 'w', ([h]) => { const wd = h ? H(h) : null; const dc = u.windowDC(wd || null); w.dcOwner.set(dc.h, h); return dc.h; });
  U(359, 'GetDCEx', ['word', 'word', 'long'], 'w', ([h, , fl]) => { const wd = h ? H(h) : null; const dc = u.windowDC(wd || null, (fl & 1) !== 0); w.dcOwner.set(dc.h, h); return dc.h; });
  U(67, 'GetWindowDC', ['word'], 'w', ([h]) => { const wd = h ? H(h) : null; const dc = u.windowDC(wd || null, true); return dc.h; });
  U(68, 'ReleaseDC', ['word', 'word'], 'w', ([, d]) => w.releaseDC(d));
  U(69, 'SetCursor', ['word'], 'w', ([h]) => u.setCursor(h));
  U(71, 'ShowCursor', ['word'], 'w', ([s]) => { u.cursorVisible = !!s; return s ? 0 : -1; });
  U(72, 'SetRect', ['ptr', 's_word', 's_word', 's_word', 's_word'], 'v', ([p, l, t, r, b]) => wrRect(p, R(l, t, r, b)));
  U(73, 'SetRectEmpty', ['ptr'], 'v', ([p]) => wrRect(p, R(0, 0, 0, 0)));
  U(74, 'CopyRect', ['ptr', 'ptr'], 'w', ([d, s]) => { wrRect(d, rdRect(s)); return 1; });
  U(75, 'IsRectEmpty', ['ptr'], 'w', ([p]) => { const r = rdRect(p); return r.r <= r.l || r.b <= r.t ? 1 : 0; });
  U(76, 'PtInRect', ['ptr', 'long'], 'w', ([p, pt]) => { const r = rdRect(p); const x = (pt << 16) >> 16, y = pt >> 16; return x >= r.l && x < r.r && y >= r.t && y < r.b ? 1 : 0; });
  U(77, 'OffsetRect', ['ptr', 's_word', 's_word'], 'w', ([p, dx, dy]) => { const r = rdRect(p); wrRect(p, R(r.l + dx, r.t + dy, r.r + dx, r.b + dy)); return 1; });
  U(78, 'InflateRect', ['ptr', 's_word', 's_word'], 'w', ([p, dx, dy]) => { const r = rdRect(p); wrRect(p, R(r.l - dx, r.t - dy, r.r + dx, r.b + dy)); return 1; });
  U(79, 'IntersectRect', ['ptr', 'ptr', 'ptr'], 'w', ([d, a, b]) => { const x = rdRect(a), y = rdRect(b); const r = R(Math.max(x.l, y.l), Math.max(x.t, y.t), Math.min(x.r, y.r), Math.min(x.b, y.b)); if (r.r <= r.l || r.b <= r.t) { wrRect(d, R(0, 0, 0, 0)); return 0; } wrRect(d, r); return 1; });
  U(80, 'UnionRect', ['ptr', 'ptr', 'ptr'], 'w', ([d, a, b]) => { const x = rdRect(a), y = rdRect(b); wrRect(d, R(Math.min(x.l, y.l), Math.min(x.t, y.t), Math.max(x.r, y.r), Math.max(x.b, y.b))); return 1; });
  U(81, 'FillRect', ['word', 'ptr', 'word'], 'w', ([hdc, p, br]) => {
    const dc = gdi.dcs.get(hdc); if (!dc) return 0; const r = rdRect(p);
    if (br <= 31) br = w.sysColorBrush(br - 1);
    gdi.fillRectDev(dc, R(gdi.lx(dc, r.l), gdi.ly(dc, r.t), gdi.lx(dc, r.r), gdi.ly(dc, r.b)), br); return 1;
  });
  U(82, 'InvertRect', ['word', 'ptr'], 'v', ([hdc, p]) => { const dc = gdi.dcs.get(hdc); if (!dc) return; const r = rdRect(p); gdi.fillRectDev(dc, R(gdi.lx(dc, r.l), gdi.ly(dc, r.t), gdi.lx(dc, r.r), gdi.ly(dc, r.b)), dc.brush, 0x550009); });
  U(83, 'FrameRect', ['word', 'ptr', 'word'], 'w', ([hdc, p, br]) => {
    const dc = gdi.dcs.get(hdc); if (!dc) return 0; const r0 = rdRect(p);
    const r = R(gdi.lx(dc, r0.l), gdi.ly(dc, r0.t), gdi.lx(dc, r0.r), gdi.ly(dc, r0.b));
    gdi.fillRectDev(dc, R(r.l, r.t, r.r, r.t + 1), br); gdi.fillRectDev(dc, R(r.l, r.b - 1, r.r, r.b), br);
    gdi.fillRectDev(dc, R(r.l, r.t, r.l + 1, r.b), br); gdi.fillRectDev(dc, R(r.r - 1, r.t, r.r, r.b), br); return 1;
  });
  U(466, 'DrawFocusRect', ['word', 'ptr'], 'v', ([hdc, p]) => {
    const dc = gdi.dcs.get(hdc); if (!dc) return; const r0 = rdRect(p);
    const r = R(gdi.lx(dc, r0.l), gdi.ly(dc, r0.t), gdi.lx(dc, r0.r), gdi.ly(dc, r0.b)); const s = dc.surface;
    const inv = (x: number, y: number) => { for (const c of gdi.clipRects(dc, R(x, y, x + 1, y + 1))) { void c; s.data[y * s.w + x] ^= 0xff; } };
    for (let x = r.l; x < r.r; x += 2) { inv(x, r.t); inv(x, r.b - 1); } for (let y = r.t; y < r.b; y += 2) { inv(r.l, y); inv(r.r - 1, y); }
    gdi.dirty(dc, r);
  });
  U(84, 'DrawIcon', ['word', 's_word', 's_word', 'word'], 'w', ([hdc, x, y, hi]) => { w.drawIcon(hdc, x, y, hi); return 1; });
  U(85, 'DrawText', ['word', 'str', 's_word', 'ptr', 'word'], 'w', ([hdc, sp, n, pr, fmt]) => {
    const dc = gdi.dcs.get(hdc); if (!dc) return 0;
    let s = m.str(sp); if (n >= 0) s = s.slice(0, n);
    const r = rdRect(pr);
    if (!(fmt & 0x800)) s = s.replace(/&(.)/g, '$1');
    const F = u.fontFor(dc); const lh = F.h;
    let lines: string[] = [];
    const maxW = r.r - r.l;
    if (fmt & 0x20) lines = [s.replace(/[\r\n]/g, '')];
    else for (const para of s.split(/\r?\n/)) {
      if (!(fmt & 0x10)) { lines.push(para); continue; }
      const words = para.split(' '); let cur = '';
      for (const wd of words) { const t = cur ? cur + ' ' + wd : wd; if (cur && u.textWidth(dc, t) > maxW) { lines.push(cur); cur = wd; } else cur = t; }
      lines.push(cur);
    }
    const totalH = lines.length * lh;
    if (fmt & 0x400) { let mw = 0; for (const l of lines) mw = Math.max(mw, u.textWidth(dc, l)); wrRect(pr, R(r.l, r.t, r.l + mw, r.t + totalH)); return totalH; }
    let y = r.t; if (fmt & 0x20) { if (fmt & 4) y = r.t + Math.floor((r.b - r.t - lh) / 2); else if (fmt & 8) y = r.b - lh; }
    const saved = dc.userClip;
    if (!(fmt & 0x100)) { const cl = R(gdi.lx(dc, r.l), gdi.ly(dc, r.t), gdi.lx(dc, r.r), gdi.ly(dc, r.b)); dc.userClip = saved ? R(Math.max(saved.l, cl.l), Math.max(saved.t, cl.t), Math.min(saved.r, cl.r), Math.min(saved.b, cl.b)) : cl; gdi.updateClip(dc); }
    for (const l of lines) {
      const tw = u.textWidth(dc, l); let x = r.l; if (fmt & 1) x = r.l + Math.floor((maxW - tw) / 2); else if (fmt & 2) x = r.r - tw;
      u.drawString(dc, gdi.lx(dc, x), gdi.ly(dc, y), l); y += lh;
    }
    dc.userClip = saved; gdi.updateClip(dc);
    return totalH;
  });
  U(90, 'IsDialogMessage', ['word', 'ptr'], 'w', () => 0);
  U(104, 'MessageBeep', ['word'], 'v', () => {});
  U(106, 'GetKeyState', ['word'], 'w', ([vk]) => { const s = u.keyState[vk & 0xff]; return ((s & 0x80) ? 0xff80 : 0) | (s & 1); });
  U(249, 'GetAsyncKeyState', ['word'], 'w', ([vk]) => (u.keyState[vk & 0xff] & 0x80) ? 0x8000 : 0);
  U(107, 'DefWindowProc', ['word', 'word', 'word', 'long'], 'l', ([h, msg, wp, lp]) => u.defProc(h, msg, wp, lp));
  U(108, 'GetMessage', ['segptr', 'word', 'word', 'word'], 'w', ([p, h, a, b]) => {
    for (;;) {
      const q = u.nextMessage(h, a, b, true);
      if (q) { u.writeMsg(p, q); return q.msg === WM.QUIT ? 0 : 1; }
      u.waitForWork(); if (w.exited) { u.writeMsg(p, { hwnd: 0, msg: WM.QUIT, wp: 0, lp: 0, time: 0, x: 0, y: 0 }); return 0; }
    }
  });
  U(109, 'PeekMessage', ['ptr', 'word', 'word', 'word', 'word'], 'w', ([p, h, a, b, fl]) => {
    const q = u.nextMessage(h, a, b, (fl & 1) !== 0);
    if (!q) { w.present(); w.mmTick(); w.idleCount++; if (w.idleCount > 200) { w.platform.wait(1); w.idleCount = 0; w.lastIdle = w.platform.now(); } return 0; }
    w.idleCount = 0; u.writeMsg(p, q); return 1;
  });
  U(110, 'PostMessage', ['word', 'word', 'word', 'long'], 'w', ([h, msg, wp, lp]) => { if (h === 0xffff) { for (const t of u.tops) u.post(t.h, msg, wp, lp); return 1; } return u.post(h, msg, wp, lp); });
  U(111, 'SendMessage', ['word', 'word', 'word', 'long'], 'l', ([h, msg, wp, lp]) => { if (h === 0xffff) { for (const t of [...u.tops]) u.send(t.h, msg, wp, lp); return 0; } return u.send(h, msg, wp, lp); });
  U(112, 'WaitMessage', [], 'v', () => { u.waitForWork(); });
  U(113, 'TranslateMessage', ['ptr'], 'w', ([p]) => {
    const L = m.lin(p); const msg = mem.r16(L + 2); const ch = u.pendingChar.get(L); u.pendingChar.delete(L);
    if ((msg === WM.KEYDOWN || msg === WM.SYSKEYDOWN) && ch !== undefined && ch > 0) { u.queue.unshift({ hwnd: mem.r16(L), msg: msg === WM.KEYDOWN ? WM.CHAR : WM.SYSCHAR, wp: ch, lp: mem.r32(L + 6), time: 0, x: 0, y: 0 }); return 1; }
    return 0;
  });
  U(114, 'DispatchMessage', ['ptr'], 'l', ([p]) => u.dispatch(p));
  U(118, 'RegisterWindowMessage', ['str'], 'w', ([p]) => u.atom('msg:' + m.str(p)));
  U(122, 'CallWindowProc', ['segptr', 'word', 'word', 'word', 'long'], 'l', ([proc, h, msg, wp, lp]) => u.callProc(proc, h, msg, wp, lp));
  U(124, 'UpdateWindow', ['word'], 'v', ([h]) => {
    const wd = H(h); if (!wd) return;
    const go = (x: typeof wd) => { if (!(x.style & 0x10000000)) return; if (x.ncPaint) { x.ncPaint = false; u.drawNC(x); } if (x.update) u.send(x.h, WM.PAINT, 0, 0); for (const c of [...x.children]) go(c); };
    go(wd);
  });
  U(125, 'InvalidateRect', ['word', 'ptr', 'word'], 'v', ([h, p, e]) => { u.invalidate(h, p ? rdRect(p) : null, !!e); });
  U(126, 'InvalidateRgn', ['word', 'word', 'word'], 'v', ([h, , e]) => { u.invalidate(h, null, !!e); });
  U(127, 'ValidateRect', ['word', 'ptr'], 'v', ([h, p]) => u.validate(h, p ? rdRect(p) : null));
  U(133, 'GetWindowWord', ['word', 's_word'], 'w', ([h, i]) => {
    const wd = H(h); if (!wd) return 0;
    if (i >= 0) return wd.extra[i] | (wd.extra[i + 1] << 8);
    if (i === -6) return wd.hInst; if (i === -8) return (wd.style & 0x40000000) ? wd.parent?.h ?? 0 : wd.owner?.h ?? 0; if (i === -12) return wd.id;
    return 0;
  });
  U(134, 'SetWindowWord', ['word', 's_word', 'word'], 'w', ([h, i, v]) => {
    const wd = H(h); if (!wd) return 0;
    if (i >= 0) { const o = wd.extra[i] | (wd.extra[i + 1] << 8); wd.extra[i] = v; wd.extra[i + 1] = v >> 8; return o; }
    if (i === -12) { const o = wd.id; wd.id = v; return o; }
    if (i === -8) { const o = wd.owner?.h ?? 0; wd.owner = H(v) || null; return o; }
    if (i === -6) { const o = wd.hInst; wd.hInst = v; return o; }
    return 0;
  });
  U(135, 'GetWindowLong', ['word', 's_word'], 'l', ([h, i]) => {
    const wd = H(h); if (!wd) return 0;
    if (i === -4) return wd.proc; if (i === -16) return wd.style >>> 0; if (i === -20) return wd.ex >>> 0;
    if (i >= 0) return (wd.extra[i] | (wd.extra[i + 1] << 8) | (wd.extra[i + 2] << 16) | (wd.extra[i + 3] << 24)) >>> 0;
    return 0;
  });
  U(136, 'SetWindowLong', ['word', 's_word', 'long'], 'l', ([h, i, v]) => {
    const wd = H(h); if (!wd) return 0;
    if (i === -4) { const o = wd.proc; wd.proc = v; return o; }
    if (i === -16) { const o = wd.style; wd.style = v | 0; return o >>> 0; }
    if (i === -20) { const o = wd.ex; wd.ex = v | 0; return o >>> 0; }
    if (i >= 0) { const o = (wd.extra[i] | (wd.extra[i + 1] << 8) | (wd.extra[i + 2] << 16) | (wd.extra[i + 3] << 24)) >>> 0; for (let k = 0; k < 4; k++) wd.extra[i + k] = v >> (8 * k); return o; }
    return 0;
  });
  // menus (minimal)
  let nextMenu = 0x3000;
  const newMenu = () => { const h = nextMenu; nextMenu += 2; u.menus.set(h, { items: [] }); return h; };
  U(151, 'CreateMenu', [], 'w', () => newMenu());
  U(415, 'CreatePopupMenu', [], 'w', () => newMenu());
  U(152, 'DestroyMenu', ['word'], 'w', ([h]) => { u.menus.delete(h); return 1; });
  U(155, 'EnableMenuItem', ['word', 'word', 'word'], 'w', () => 0);
  U(156, 'GetSystemMenu', ['word', 'word'], 'w', ([h]) => { const wd = H(h); if (!wd) return 0; if (!(wd as any).sysMenu) { const mh = newMenu(); const mm = u.menus.get(mh)!; for (const [id, t] of [[0xf120, 'Restore'], [0xf010, 'Move'], [0xf000, 'Size'], [0xf020, 'Minimize'], [0xf030, 'Maximize'], [0, ''], [0xf060, 'Close']] as [number, string][]) mm.items.push({ id, flags: id ? 0 : 0x800, text: t, sub: 0 }); (wd as any).sysMenu = mh; } return (wd as any).sysMenu; });
  U(157, 'GetMenu', ['word'], 'w', ([h]) => H(h)?.menu ?? 0);
  U(158, 'SetMenu', ['word', 'word'], 'w', ([h, mn]) => { const wd = H(h); if (wd) wd.menu = mn; return 1; });
  U(160, 'DrawMenuBar', ['word'], 'v', () => {});
  U(161, 'GetMenuString', ['word', 'word', 'ptr', 's_word', 'word'], 'w', ([h, id, p, n, fl]) => { const mm = u.menus.get(h); const it = mm && (fl & 0x400 ? mm.items[id] : mm.items.find(i => i.id === id)); return mem.writeCStr(p >>> 16, p & 0xffff, it?.text ?? '', n); });
  U(250, 'GetMenuState', ['word', 'word', 'word'], 'w', ([h, id, fl]) => { const mm = u.menus.get(h); const it = mm && (fl & 0x400 ? mm.items[id] : mm.items.find(i => i.id === id)); return it ? it.flags : 0xffff; });
  U(263, 'GetMenuItemCount', ['word'], 'w', ([h]) => u.menus.get(h)?.items.length ?? 0xffff);
  U(410, 'InsertMenu', ['word', 'word', 'word', 'word', 'segptr'], 'w', ([h, pos, fl, id, p]) => { const mm = u.menus.get(h); if (!mm) return 0; const it = { id, flags: fl & ~0x400, text: (fl & 0x804) ? '' : m.str(p), sub: fl & 0x10 ? id : 0 }; if (pos === 0xffff) mm.items.push(it); else mm.items.splice(pos, 0, it); return 1; });
  U(411, 'AppendMenu', ['word', 'word', 'word', 'segptr'], 'w', ([h, fl, id, p]) => { const mm = u.menus.get(h); if (!mm) return 0; mm.items.push({ id, flags: fl, text: (fl & 0x804) ? '' : m.str(p), sub: 0 }); return 1; });
  const rmItem = (h: number, id: number, fl: number) => { const mm = u.menus.get(h); if (!mm) return 0; const i = fl & 0x400 ? id : mm.items.findIndex(x => x.id === id); if (i < 0 || i >= mm.items.length) return 0; mm.items.splice(i, 1); return 1; };
  U(412, 'RemoveMenu', ['word', 'word', 'word'], 'w', ([h, id, fl]) => rmItem(h, id, fl));
  U(413, 'DeleteMenu', ['word', 'word', 'word'], 'w', ([h, id, fl]) => rmItem(h, id, fl));
  U(416, 'TrackPopupMenu', ['word', 'word', 's_word', 's_word', 's_word', 'word', 'ptr'], 'w', () => 0);
  U(171, 'WinHelp', ['word', 'str', 'word', 'long'], 'w', () => 1);
  U(173, 'LoadCursor', ['word', 'str'], 'w', ([hi, n]) => w.loadCursor(hi, n));
  U(174, 'LoadIcon', ['word', 'str'], 'w', ([hi, n]) => w.loadIcon(hi, n));
  U(175, 'LoadBitmap', ['word', 'str'], 'w', ([hi, n]) => w.loadBitmapRes(hi, n));
  U(176, 'LoadString', ['word', 'word', 'ptr', 's_word'], 'w', ([hi, id, p, n]) => {
    const r = w.findResource(hi, (id >> 4) + 1, 6); const d = r ? w.resData(r) : undefined; if (!d) { if (n > 0) mem.writeCStr(p >>> 16, p & 0xffff, ''); return 0; }
    let o = 0; for (let i = 0; i < (id & 15); i++) o += 1 + d[o];
    const l = d[o]; const s = String.fromCharCode(...d.subarray(o + 1, o + 1 + l)); return mem.writeCStr(p >>> 16, p & 0xffff, s, n);
  });
  U(179, 'GetSystemMetrics', ['s_word'], 'w', ([i]) => {
    const t: Record<number, number> = { 0: u.desktop.w, 1: u.desktop.h_, 2: 17, 3: 17, 4: 20, 5: 1, 6: 1, 7: 4, 8: 4, 9: 17, 10: 17, 11: 32, 12: 32, 13: 32, 14: 32, 15: 18, 16: u.desktop.w, 17: u.desktop.h_ - 20, 19: 1, 20: 17, 21: 17, 28: 100, 29: 26, 30: 18, 31: 18, 32: 4, 33: 4, 34: 100, 35: 26, 36: 4, 37: 4, 38: 64, 39: 64, 43: 2 };
    return t[i] ?? 0;
  });
  U(180, 'GetSysColor', ['word'], 'l', ([i]) => (w as any).sysColorFn(i));
  U(262, 'GetWindow', ['word', 'word'], 'w', ([h, cmd]) => {
    const wd = H(h); if (!wd) return 0;
    const sibs = (wd.style & 0x40000000) && wd.parent ? wd.parent.children : u.tops;
    const i = sibs.indexOf(wd);
    switch (cmd) {
      case 0: return sibs[0]?.h ?? 0; case 1: return sibs[sibs.length - 1]?.h ?? 0;
      case 2: return sibs[i + 1]?.h ?? 0; case 3: return i > 0 ? sibs[i - 1].h : 0;
      case 4: return wd.owner?.h ?? 0; case 5: return wd.children[0]?.h ?? 0;
    }
    return 0;
  });
  U(265, 'ShowOwnedPopups', ['word', 'word'], 'v', () => {});
  U(266, 'SetMessageQueue', ['word'], 'w', () => 1);
  U(268, 'GlobalAddAtom', ['str'], 'w', ([p]) => (p >>> 16) === 0 ? p & 0xffff : u.atom(m.str(p)));
  U(269, 'GlobalDeleteAtom', ['word'], 'w', () => 0);
  U(270, 'GlobalFindAtom', ['str'], 'w', ([p]) => u.atoms.get(m.str(p).toUpperCase()) ?? 0);
  U(271, 'GlobalGetAtomName', ['word', 'ptr', 's_word'], 'w', ([a, p, n]) => mem.writeCStr(p >>> 16, p & 0xffff, u.atomNames.get(a) ?? '', n));
  U(282, 'SelectPalette', ['word', 'word', 'word'], 'w', ([hdc, hp]) => { const dc = gdi.dcs.get(hdc); if (!dc) return 0; const o = dc.palette; dc.palette = hp; return o; });
  U(283, 'RealizePalette', ['word'], 'w', ([hdc]) => { const dc = gdi.dcs.get(hdc); if (!dc) return 0; const p = gdi.objs.get(dc.palette); if (!p || p.stock) return 0; const n = gdi.realize(p); if (n) { w.composeDirty = true; } return n; });
  U(287, 'GetLastActivePopup', ['word'], 'w', ([h]) => h);
  U(292, 'UnhookWindowsHookEx', ['segptr'], 'w', () => 1);
  U(291, 'SetWindowsHookEx', ['s_word', 'segptr', 'word', 'word'], 'l', () => 0x10001);
  U(232, 'SetWindowPos', ['word', 'word', 'word', 'word', 'word', 'word', 'word'], 'w', ([h, after, x, y, cx, cy, fl]) => {
    const wd = H(h); if (!wd) return 0;
    return u.setPos(wd, after, (x << 16) >> 16, (y << 16) >> 16, (cx << 16) >> 16, (cy << 16) >> 16, fl);
  });
  U(56, 'MoveWindow', ['word', 's_word', 's_word', 's_word', 's_word', 'word'], 'w', ([h, x, y, cx, cy]) => { const wd = H(h); if (!wd) return 0; return u.setPos(wd, 0, x, y, cx, cy, 0x14); });
  U(370, 'GetWindowPlacement', ['word', 'ptr'], 'w', ([h, p]) => {
    const wd = H(h); if (!wd) return 0; const L = m.lin(p); mem.w16(L, 22); mem.w16(L + 2, 0); mem.w16(L + 4, wd.maximized ? 3 : wd.minimized ? 2 : 1);
    const r = wd.restore || R(wd.x, wd.y, wd.x + wd.w, wd.y + wd.h_); mem.w16(L + 14, r.l); mem.w16(L + 16, r.t); mem.w16(L + 18, r.r); mem.w16(L + 20, r.b); return 1;
  });
  U(371, 'SetWindowPlacement', ['word', 'ptr'], 'w', ([h, p]) => {
    const wd = H(h); if (!wd) return 0; const L = m.lin(p); const s = (o: number) => (mem.r16(L + o) << 16) >> 16;
    const r = R(s(14), s(16), s(18), s(20)); if (wd.maximized) wd.restore = r; else u.setPos(wd, 0, r.l, r.t, r.r - r.l, r.b - r.t, 0x14);
    const cmd = mem.r16(L + 4); if (cmd && (wd.style & 0x10000000 || cmd !== 0)) u.show(h, cmd); return 1;
  });
  U(407, 'CreateIcon', ['word', 'word', 'word', 'word', 'word', 'ptr', 'ptr'], 'w', () => w.gdi.alloc({ type: 'bitmap', icon: true, surf: w.gdi.newSurface(32, 32, false) }));
  U(457, 'DestroyIcon', ['word'], 'w', () => 1);
  U(458, 'DestroyCursor', ['word'], 'w', () => 1);
  U(247, 'GetCursor', [], 'w', () => u.cursor);
  U(432, 'AnsiLower', ['segstr'], 'l', ([p]) => { if ((p >>> 16) === 0) return String.fromCharCode(p & 0xff).toLowerCase().charCodeAt(0); const s = m.str(p); mem.writeCStr(p >>> 16, p & 0xffff, lowerAnsi(s)); return p; });
  U(431, 'AnsiUpper', ['segstr'], 'l', ([p]) => { if ((p >>> 16) === 0) return upperAnsi(String.fromCharCode(p & 0xff)).charCodeAt(0); const s = m.str(p); mem.writeCStr(p >>> 16, p & 0xffff, upperAnsi(s)); return p; });
  U(471, 'lstrcmpi', ['str', 'str'], 'w', ([a, b]) => { const x = lowerAnsi(m.str(a)), y = lowerAnsi(m.str(b)); return x < y ? 0xffff : x > y ? 1 : 0; });
  U(430, 'lstrcmp', ['str', 'str'], 'w', ([a, b]) => { const x = m.str(a), y = m.str(b); return x < y ? 0xffff : x > y ? 1 : 0; });
  U(445, 'DefFrameProc', ['word', 'word', 'word', 'word', 'long'], 'l', ([h, , msg, wp, lp]) => u.defProc(h, msg, wp, lp));
  U(447, 'DefMDIChildProc', ['word', 'word', 'word', 'long'], 'l', ([h, msg, wp, lp]) => u.defProc(h, msg, wp, lp));
  U(451, 'TranslateMDISysAccel', ['word', 'ptr'], 'w', () => 0);
  U(420, 'wsprintf', [], 'w', () => 0);
}
function lowerAnsi(s: string) { return s.replace(/[A-Z\xc0-\xde]/g, c => (c === '\xd7' ? c : String.fromCharCode(c.charCodeAt(0) + 32))); }
function upperAnsi(s: string) { return s.replace(/[a-z\xe0-\xfe]/g, c => (c === '\xf7' ? c : String.fromCharCode(c.charCodeAt(0) - 32))); }
