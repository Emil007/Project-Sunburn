// Zoom: the island view (the picture part of the main window) is shown enlarged around its centre.
// The game draws as always; when the frame is put together, the map's own pixels are scaled up (only
// where no other window covers the view), and mouse positions over the view are mapped back, so the
// game sees the point under the cursor.
const LEVELS = [1, 1.5, 2, 3];
let z = Math.max(1, +api.settings.start || 1);
const vis = (t) => (t.style & 0x10000000) && t.w > 0 && t.h_ > 0;
function view() {
  const tops = api.win16.user.tops;
  const i = tops.findIndex((t) => t.cls.name === 'THauptschirm' && vis(t)); if (i < 0) return null;
  const t = tops[i]; if (!t.surface) return null;
  // the map picture: below the title/info/tool bars (59 px), left of the scrollbar, above the bottom bar
  const r = { x: t.x, y: t.y + 59, w: t.w - 16, h: t.h_ - 75 };
  if (r.w < 64 || r.h < 64) return null;
  const covers = tops.slice(0, i).filter((o) => vis(o) && o.cls.name !== 'THintWindow' && o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h_ > r.y);
  return { t, r, covers };
}
const covered = (v, x, y) => v.covers.some((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h_);

let p32 = new Uint32Array(256), palKey = '';
api.onDraw((P, W, H) => {
  if (z === 1) return;
  const v = view(); if (!v) return;
  const pal = api.win16.gdi.sysPal; const key = pal.join(',');
  if (key !== palKey) { palKey = key; for (let i = 0; i < 256; i++) p32[i] = (pal[i * 4] | (pal[i * 4 + 1] << 8) | (pal[i * 4 + 2] << 16) | 0xff000000) >>> 0; }
  const { t, r } = v, s = t.surface;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const x0 = Math.max(0, r.x), x1 = Math.min(W, r.x + r.w), y0 = Math.max(0, r.y), y1 = Math.min(H, r.y + r.h);
  // source column for every screen column (window-relative)
  const sxs = new Int32Array(x1 - x0);
  for (let x = x0; x < x1; x++) sxs[x - x0] = Math.min(s.w - 1, Math.max(0, Math.floor(cx + (x + 0.5 - cx) / z) - t.x));
  for (let y = y0; y < y1; y++) {
    const sy = Math.min(s.h - 1, Math.max(0, Math.floor(cy + (y + 0.5 - cy) / z) - t.y)) * s.w;
    // spans of this row hidden by windows in front
    const spans = v.covers.filter((o) => y >= o.y && y < o.y + o.h_).map((o) => [o.x, o.x + o.w]);
    let o = y * W + x0;
    for (let x = x0; x < x1; x++, o++) {
      if (spans.length && spans.some((sp) => x >= sp[0] && x < sp[1])) continue;
      P[o] = p32[s.data[sy + sxs[x - x0]]];
    }
  }
});

// mouse over the view: tell the game the point that is shown there
api.onInput((e) => {
  if (z === 1 || (e.type !== 'mousemove' && e.type !== 'mousedown' && e.type !== 'mouseup')) return false;
  const v = view(); if (!v) return false;
  const { r } = v;
  if (e.x < r.x || e.y < r.y || e.x >= r.x + r.w || e.y >= r.y + r.h || covered(v, e.x, e.y)) return false;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  e.x = Math.round(cx + (e.x - cx) / z); e.y = Math.round(cy + (e.y - cy) / z);
  return false;
});

function setZoom(n) { z = n; api.log(`zoom ${z}x`); api.redraw(); }
// commands from ui.js: 1 = in, 2 = out, 3 = back to 1x
api.onCommand((cmd) => {
  const i = LEVELS.indexOf(z);
  if (cmd === 1 && i < LEVELS.length - 1) setZoom(LEVELS[i + 1]);
  if (cmd === 2 && i > 0) setZoom(LEVELS[i - 1]);
  if (cmd === 3) setZoom(1);
});
// the view changes all the time while zoomed in (the game redraws only what changed)
api.onTick(() => { if (z !== 1) api.redraw(); });
// let the page know when the keys may zoom: the island is on screen and no text field has the keyboard
let lastState = '';
let nextState = 0;
api.onTick((now) => {
  if (now < nextState) return; nextState = now + 250;
  const u = api.win16.user; const f = u.get(u.focus);
  const st = JSON.stringify({ map: !!view(), typing: !!f && /Edit|Memo|ComboBox/i.test(f.cls.name) });
  if (st !== lastState) { lastState = st; api.toUI(JSON.parse(st)); }
});
