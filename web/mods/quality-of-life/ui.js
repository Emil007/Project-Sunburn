// Runs in the UI thread. The game scrolls the island with the arrow keys: one tap moves the view
// 64 px sideways or 32 px up/down.
const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const STEP_X = 64, STEP_Y = 32;

// --- mouse wheel ---
const steps = +api.settings.wheel || 0;
api.onWheel((dy, dx, shift) => {
  if (!steps) return false;
  const horizontal = shift || Math.abs(dx) > Math.abs(dy);
  const d = horizontal ? (dx || dy) : dy;
  const vk = horizontal ? (d > 0 ? VK_RIGHT : VK_LEFT) : (d > 0 ? VK_DOWN : VK_UP);
  for (let i = 0; i < steps; i++) api.tapKey(vk);
  return true;
});

// --- edge scrolling ---
if (api.settings.edge) {
  api.every(120, () => {
    const { x, y, inside } = api.mouse(); if (!inside || drag) return;
    const W = api.screen().w, H = api.screen().h, m = 3;
    if (x <= m) api.tapKey(VK_LEFT); else if (x >= W - 1 - m) api.tapKey(VK_RIGHT);
    if (y <= m) api.tapKey(VK_UP); else if (y >= H - 1 - m) api.tapKey(VK_DOWN);
  });
}

// --- right-button drag ("grab the island") ---
let view = null;                       // { map: [x,y,w,h], covers: [[x,y,w,h]...] } from script.js
api.onMessage((m) => { view = m; });
const inRect = (x, y, r) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
let drag = null;
if (api.settings.rdrag !== false) {
  api.onMouse((type, x, y, button) => {
    if (type === 'down' && button === 2) {
      if (!view || !inRect(x, y, view.map) || view.covers.some((r) => inRect(x, y, r))) return false;
      drag = { x0: x, y0: y, ax: x, ay: y, moved: false };
      return true;                                     // hold the click back until we know it's not a drag
    }
    if (!drag) return false;
    if (type === 'move') {
      if (!drag.moved && Math.abs(x - drag.x0) + Math.abs(y - drag.y0) > 6) drag.moved = true;
      if (drag.moved) {
        // grab semantics: the island follows the mouse
        while (x - drag.ax >= STEP_X) { api.tapKey(VK_LEFT); drag.ax += STEP_X; }
        while (drag.ax - x >= STEP_X) { api.tapKey(VK_RIGHT); drag.ax -= STEP_X; }
        while (y - drag.ay >= STEP_Y) { api.tapKey(VK_UP); drag.ay += STEP_Y; }
        while (drag.ay - y >= STEP_Y) { api.tapKey(VK_DOWN); drag.ay -= STEP_Y; }
      }
      return false;                                    // the cursor keeps moving normally
    }
    if (type === 'up' && button === 2) {
      const d = drag; drag = null;
      if (!d.moved) api.click(d.x0, d.y0, 2);          // a plain right click: deliver it as usual
      return true;
    }
    return false;
  });
}
