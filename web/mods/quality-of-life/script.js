// Worker side: tell the page where the island view is (and which game windows cover it), so the
// page script can start right-button drags only on the visible map.
let last = '';
let next = 0;
api.onTick((now) => {
  if (now < next) return; next = now + 150;
  const tops = api.win16.user.tops;
  const vis = (t) => (t.style & 0x10000000) && t.w > 0 && t.h_ > 0;
  const mi = tops.findIndex((t) => t.cls.name === 'THauptschirm' && vis(t));
  let msg = null;
  if (mi >= 0) {
    const m = tops[mi];
    // map image: below title/info/tool bars (59 px), left of the vertical scrollbar, above the bottom bar
    msg = { map: [m.x, m.y + 59, m.w - 16, m.h_ - 75], covers: tops.slice(0, mi).filter((t) => vis(t) && t.cls.name !== 'THintWindow').map((t) => [t.x, t.y, t.w, t.h_]) };
  }
  const s = JSON.stringify(msg);
  if (s !== last) { last = s; api.toUI(msg); }
});
