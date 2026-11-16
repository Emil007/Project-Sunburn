// Worker side of "Quality of life".
// 1. Tells the page where the island view is (and which game windows cover it), so the page script
//    starts right-button drags only on the visible map.
// 2. Scrolls the island: the game scrolls with the arrow keys, but only in the window that has the
//    keyboard. With the finance window in front, or in building mode (where the hidden building menu
//    keeps the keyboard and the arrows flip through the building types), they went to the wrong
//    window. Scrolling from the page (wheel, drag, edge) and the arrow keys now go to the island.
const vis = (t) => (t.style & 0x10000000) && t.w > 0 && t.h_ > 0;
const U = () => api.win16.user;
const mapWnd = () => U().tops.find((t) => t.cls.name === 'THauptschirm' && vis(t));
const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101;
const key = (h, vk, down) => U().post(h, down ? WM_KEYDOWN : WM_KEYUP, vk, down ? 1 : 0xc0000001);

let last = '';
let next = 0;
api.onTick((now) => {
  if (now < next) return; next = now + 150;
  const tops = U().tops;
  const mi = tops.findIndex((t) => t.cls.name === 'THauptschirm' && vis(t));
  let msg = null;
  if (mi >= 0) {
    const m = tops[mi];
    const mini = tops.find((t) => t.cls.name === 'TUebersichtsmap2' && vis(t));
    // map image: below title/info/tool bars (59 px), left of the vertical scrollbar, above the bottom bar
    msg = {
      map: [m.x, m.y + 59, m.w - 16, m.h_ - 75],
      covers: tops.slice(0, mi).filter((t) => vis(t) && t.cls.name !== 'THintWindow').map((t) => [t.x, t.y, t.w, t.h_]),
      mini: mini ? [mini.x, mini.y, mini.w, mini.h_, tops.indexOf(mini)] : null,
      tops: tops.filter(vis).filter((t) => t.cls.name !== 'THintWindow').map((t) => [t.x, t.y, t.w, t.h_, t.cls.name === 'TUebersichtsmap2' ? 1 : 0]),
    };
  }
  const s = JSON.stringify(msg);
  if (s !== last) { last = s; api.toUI(msg); }
});

// command 1: scroll the island; arg = arrow key code | count << 8
api.onCommand((cmd, arg) => {
  if (cmd !== 1) return;
  const m = mapWnd(); if (!m) return;
  const vk = arg & 0xff, n = Math.min(64, (arg >> 8) || 1);
  for (let i = 0; i < n; i++) { key(m.h, vk, true); key(m.h, vk, false); }
});

// the arrow keys scroll the island unless a window that uses them has the keyboard: the visible
// building menu (flipping through the types, as in the original) or a text field or list
const topOf = (w) => { while (w && w.parent) w = w.parent; return w; };
const usesArrows = (f) => {
  if (!f) return false;
  if (/Edit|ListBox|ComboBox|Memo|ScrollBar/i.test(f.cls.name)) return vis(topOf(f));
  const t = topOf(f);
  return !!t && vis(t) && t.cls.name === 'TBaumenue';
};
api.onInput((e) => {
  if (e.type !== 'keydown' && e.type !== 'keyup') return false;
  const vk = e.vk & 0xff; if (vk < 0x25 || vk > 0x28) return false;
  const u = U(); const m = mapWnd(); if (!m) return false;
  const f = u.get(u.focus);
  if (f === m || usesArrows(f)) return false;
  if (e.type === 'keydown') u.keyState[vk] = (u.keyState[vk] & 1 ? 0 : 1) | 0x80; else u.keyState[vk] &= 1;
  key(m.h, vk, e.type === 'keydown');
  return true;
});
