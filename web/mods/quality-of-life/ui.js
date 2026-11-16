// Runs in the UI thread. The game scrolls the island with the arrow keys: one tap moves the view
// 64 px sideways or 32 px up/down.
const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const STEP_X = 64, STEP_Y = 32;
// scrolling goes to the island window whichever game window has the keyboard (script.js)
const scroll = (vk, n = 1) => { if (n > 0) api.command(1, vk | (n << 8)); };

// --- mouse wheel ---
const steps = +api.settings.wheel || 0;
api.onWheel((dy, dx, shift) => {
  if (!steps) return false;
  const horizontal = shift || Math.abs(dx) > Math.abs(dy);
  const d = horizontal ? (dx || dy) : dy;
  const vk = horizontal ? (d > 0 ? VK_RIGHT : VK_LEFT) : (d > 0 ? VK_DOWN : VK_UP);
  scroll(vk, steps);
  return true;
});

// --- edge scrolling ---
if (api.settings.edge) {
  api.every(120, () => {
    const { x, y, inside } = api.mouse(); if (!inside || drag) return;
    // edges of the part of the screen that is visible (the window can be smaller than the game screen)
    const v = api.visible ? api.visible() : { x: 0, y: 0, ...api.screen() }, m = 3;
    if (x <= v.x + m) scroll(VK_LEFT); else if (x >= v.x + v.w - 1 - m) scroll(VK_RIGHT);
    if (y <= v.y + m) scroll(VK_UP); else if (y >= v.y + v.h - 1 - m) scroll(VK_DOWN);
  });
}

// --- right-button drag ("grab the island") ---
let view = null;                       // { map, covers, mini, tops } from script.js
api.onMessage((m) => { view = m; });
const inRect = (x, y, r) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
// The overview map ("General map") centres its own picture on the point you right-click. Its picture
// area and centre, relative to the window:
const MINI_AREA = [4, 20, 400, 270], MINI_CX = 202, MINI_CY = 153;
const onMini = (x, y) => {
  if (!view || !view.mini) return false;
  const top = view.tops.find((t) => inRect(x, y, t));          // front-most game window under the mouse
  if (!top || !top[4]) return false;
  const [mx, my] = view.mini;
  return inRect(x - mx, y - my, MINI_AREA);
};
// move the overview map's picture by (dx, dy) pixels: a right click that far from its centre
const miniShift = (dx, dy) => { const [mx, my] = view.mini; api.click(mx + MINI_CX - dx, my + MINI_CY - dy, 2); };
let drag = null;
let glide = null;                       // a right click on the overview map, done as a short glide
if (api.settings.rdrag !== false) {
  api.onMouse((type, x, y, button) => {
    if (type === 'down' && button === 2) {
      if (onMini(x, y)) { drag = { mini: true, x0: x, y0: y, ax: x, ay: y, moved: false }; return true; }
      if (!view || !inRect(x, y, view.map) || view.covers.some((r) => inRect(x, y, r))) return false;
      drag = { x0: x, y0: y, ax: x, ay: y, moved: false };
      return true;                                     // hold the click back until we know it's not a drag
    }
    if (!drag) return false;
    if (type === 'move') {
      if (!drag.moved && Math.abs(x - drag.x0) + Math.abs(y - drag.y0) > 6) drag.moved = true;
      if (drag.moved && drag.mini) {
        // grab semantics on the overview map: its picture follows the mouse
        const dx = x - drag.ax, dy = y - drag.ay;
        if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) { miniShift(dx, dy); drag.ax = x; drag.ay = y; }
      } else if (drag.moved) {
        // grab semantics: the island follows the mouse
        while (x - drag.ax >= STEP_X) { scroll(VK_LEFT); drag.ax += STEP_X; }
        while (drag.ax - x >= STEP_X) { scroll(VK_RIGHT); drag.ax -= STEP_X; }
        while (y - drag.ay >= STEP_Y) { scroll(VK_UP); drag.ay += STEP_Y; }
        while (drag.ay - y >= STEP_Y) { scroll(VK_DOWN); drag.ay -= STEP_Y; }
      }
      return false;                                    // the cursor keeps moving normally
    }
    if (type === 'up' && button === 2) {
      const d = drag; drag = null;
      if (!d.moved && d.mini && view && view.mini) {
        // a plain right click on the overview map: glide there instead of jumping
        const [mx, my] = view.mini;
        glide = { left: 8, tx: mx + MINI_CX - d.x0, ty: my + MINI_CY - d.y0 };
      } else if (!d.moved) api.click(d.x0, d.y0, 2);   // a plain right click: deliver it as usual
      return true;
    }
    return false;
  });
  // the glide: the remaining distance in a few eased steps
  api.every(30, () => {
    if (!glide || !view || !view.mini) { glide = null; return; }
    const k = glide.left <= 1 ? 1 : 0.35;
    const dx = Math.round(glide.tx * k), dy = Math.round(glide.ty * k);
    glide.tx -= dx; glide.ty -= dy; glide.left--;
    if (dx || dy) miniShift(dx, dy);
    if (glide.left <= 0 || (!glide.tx && !glide.ty)) glide = null;
  });
}
