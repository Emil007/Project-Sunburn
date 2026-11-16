// Game speed buttons, drawn into the main window's info bar in front of the date (in the empty wood
// plank), in the style of the game's own buttons, with a tooltip in the game's font.
// Speed = the game's own 100 ms tick timer fires faster (the same thing the German release's hidden
// Ctrl+Shift+Alt+N/M keys do by changing that timer's interval). Films and other timers keep their speed.
const SPEEDS = [1, 2, 5];
const TICK = 100; // interval of the game's tick timer (ms)
const TIPS = api.lang === 'de'
  ? ['Normales Tempo', 'Schnell (2x)', 'Sehr schnell (5x)']
  : ['Normal speed', 'Fast (2x)', 'Very fast (5x)'];
const BX = 452, BY = 19, BW = 14, BH = 12, GAP = 1;   // window-relative, original 640x480 layout
let speed = 0, hover = -1, hoverSince = 0, pressed = -1;

// ---- the game's bitmap font (GRAFIK\FONT.BMP: 12 px slots, bands of 14 rows; band 0 = mask) ----
let font = null;
api.onLoad((ctx) => {
  const d = ctx.readFile('D:\\GRAFIK\\FONT.BMP'); if (!d) return;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const off = dv.getUint32(10, true), w = dv.getInt32(18, true), h = Math.abs(dv.getInt32(22, true)), bpp = dv.getUint16(28, true);
  if (bpp !== 8) return;
  const ncol = dv.getUint32(46, true) || 256, pal = [];
  for (let i = 0; i < ncol; i++) pal.push((0xff000000 | (d[54 + i * 4 + 2] << 0) | (d[54 + i * 4 + 1] << 8) | (d[54 + i * 4] << 16)) >>> 0);
  const stride = (w + 3) & ~3, bottomUp = dv.getInt32(22, true) > 0;
  const px = (x, y) => d[off + (bottomUp ? h - 1 - y : y) * stride + x];
  // the brightest band (white text, like the date)
  let best = 1, bestL = -1;
  for (let b = 1; b < Math.floor(h / 14); b++) {
    const c = px(1 * 12 + 5, b * 14 + 6) || px(1 * 12 + 3, b * 14 + 10); if (!c) continue;
    const v = pal[c], l = (v & 255) + ((v >> 8) & 255) + ((v >> 16) & 255); if (l > bestL) { bestL = l; best = b; }
  }
  font = { px, pal, band: best, slots: Math.floor(w / 12) };
});
const SLOT = (ch) => {
  const c = ch.charCodeAt(0);
  if (ch === ' ') return 0; if (c >= 65 && c <= 90) return c - 64; if (c >= 97 && c <= 122) return c - 70;
  const i = 'ßÄäÖöÜü1234567890"/()'.indexOf(ch); if (i >= 0) return 53 + i;
  const j = '.,:;?+-=$!\''.indexOf(ch); return j >= 0 ? 75 + j : 74;
};
function glyphWidth(s) { // ink columns from the mask band
  if (s === 0) return 4;
  let r = 0; for (let x = 0; x < 12; x++) for (let y = 0; y < 14; y++) if (font.px(s * 12 + x, y) === 0) r = x + 1;
  return r + 1;
}
function textWidth(t) { let w = 0; for (const ch of t) w += glyphWidth(SLOT(ch)); return w; }
function drawText(P, W, H, t, x, y) {
  for (const ch of t) {
    const s = SLOT(ch), gw = glyphWidth(s);
    for (let gy = 0; gy < 14; gy++) for (let gx = 0; gx < 12; gx++) {
      if (font.px(s * 12 + gx, gy) !== 0) continue;            // mask: 0 = ink
      const c = font.px(s * 12 + gx, font.band * 14 + gy); const X = x + gx, Y = y + gy;
      if (c && X >= 0 && Y >= 0 && X < W && Y < H) P[Y * W + X] = font.pal[c];
    }
    x += gw;
  }
}

// ---- helpers ----
const mix = (v, k) => (0xff000000 | (Math.min(255, (((v >> 16) & 255) * k) | 0) << 16) | (Math.min(255, (((v >> 8) & 255) * k) | 0) << 8) | Math.min(255, ((v & 255) * k) | 0)) >>> 0;
const rgb = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
function mainWin() {
  const u = api.win16.user; let i = 0;
  for (const t of u.tops) {
    if (t.cls && t.cls.name === 'THauptschirm' && (t.style & 0x10000000) && t.w >= 520 && t.h_ >= 60) return { t, above: u.tops.slice(0, i) };
    i++;
  }
  return null;
}
function rects() {
  const m = mainWin(); if (!m) return null;
  const x0 = m.t.x + BX, y0 = m.t.y + BY;
  const r = SPEEDS.map((_, i) => ({ x: x0 + i * (BW + GAP), y: y0, w: BW, h: BH }));
  // hidden behind another window (a dialog over the info bar)?
  const all = { x: x0, y: y0, w: SPEEDS.length * (BW + GAP), h: BH };
  for (const o of m.above) if ((o.style & 0x10000000) && o.x < all.x + all.w && o.x + o.w > all.x && o.y < all.y + all.h && o.y + o.h_ > all.y) return null;
  return r;
}
const hit = (r, x, y) => r && r.findIndex((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

// ---- drawing ----
function icon(P, W, b, n, col) {        // n triangles "▶", 4 px wide each, centred
  const tw = n * 4 + (n - 1) * 0, x0 = b.x + Math.floor((b.w - tw) / 2) + (n === 1 ? 0 : 0), cy = b.y + Math.floor(b.h / 2);
  for (let k = 0; k < n; k++) for (let dx = 0; dx < 4; dx++) for (let dy = -(3 - dx); dy <= 3 - dx; dy++) {
    const X = x0 + k * 4 + dx, Y = cy + dy; P[Y * W + X] = col;
  }
}
api.onDraw((P, W, H) => {
  const r = rects(); if (!r) return;
  for (let i = 0; i < r.length; i++) {
    const b = r[i]; if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) continue;
    const on = i === speed, down = on || i === pressed;
    // face: the wood underneath, a bit lighter (darker when pressed)
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) P[y * W + x] = mix(P[y * W + x], down ? 0.72 : (i === hover ? 1.22 : 1.1));
    const light = rgb(255, 236, 190), dark = rgb(60, 36, 16), black = rgb(0, 0, 0);
    for (let x = b.x; x < b.x + b.w; x++) { P[b.y * W + x] = down ? dark : light; P[(b.y + b.h - 1) * W + x] = down ? light : dark; }
    for (let y = b.y; y < b.y + b.h; y++) { P[y * W + b.x] = down ? dark : light; P[y * W + b.x + b.w - 1] = down ? light : dark; }
    icon(P, W, { x: b.x + (down ? 1 : 0), y: b.y + (down ? 1 : 0), w: b.w, h: b.h }, i + 1, on ? rgb(255, 238, 60) : (i === hover ? rgb(255, 255, 255) : black));
  }
  // tooltip after a moment, in the game's font on a dark wood box
  if (hover >= 0 && font && api.win16.platform.now() - hoverSince > 450) {
    const t = TIPS[hover], tw = textWidth(t) + 8, th = 16;
    let x = r[hover].x, y = r[hover].y + BH + 4; if (x + tw > W) x = W - tw;
    for (let yy = y; yy < y + th; yy++) for (let xx = x; xx < x + tw; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) P[yy * W + xx] = (yy === y || yy === y + th - 1 || xx === x || xx === x + tw - 1) ? rgb(0, 0, 0) : rgb(92, 58, 26);
    drawText(P, W, H, t, x + 4, y + 1);
  }
});

// ---- input ----
api.onInput((e) => {
  if (e.type !== 'mousemove' && e.type !== 'mousedown' && e.type !== 'mouseup') return false;
  const r = rects(); const i = r ? hit(r, e.x, e.y) : -1;
  if (e.type === 'mousemove') {
    if (i !== hover) { hover = i; hoverSince = api.win16.platform.now(); api.redraw(); }
    return false;                       // the game still tracks the mouse
  }
  if ((e.button || 0) !== 0) return i >= 0;
  if (e.type === 'mousedown') { if (i < 0) return false; pressed = i; api.redraw(); return true; }
  // mouseup
  if (pressed < 0) return false;
  const p = pressed; pressed = -1;
  if (i === p) { speed = p; api.setSpeed(SPEEDS[p], TICK); api.log(`speed ${SPEEDS[p]}x`); }
  api.redraw();
  return true;
});

// keep the tooltip appearing even when nothing else changes on screen
api.onTick(() => { if (hover >= 0) api.redraw(); });
