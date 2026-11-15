// Gamepad controls (standard mapping, see https://w3c.github.io/gamepad/#remapping).
// Runs in the page; drives the game's mouse pointer and keyboard through the mod API.
const VK = { LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, RETURN: 0x0d, ESCAPE: 0x1b };
const speed = +api.settings.speed || 8;
const [BTN_LEFT, BTN_RIGHT] = api.settings.swap ? [1, 0] : [0, 1];
const DEAD = 0.18;
let fx = null, fy = null;                    // sub-pixel pointer position
const prev = [];                            // previous button states
let lastScroll = 0;
const pressed = (pad, i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
const edge = (pad, i) => { const p = pressed(pad, i), was = !!prev[i]; prev[i] = p; return p === was ? 0 : p ? 1 : -1; };
const curve = (v) => { const a = Math.abs(v); if (a < DEAD) return 0; const t = (a - DEAD) / (1 - DEAD); return Math.sign(v) * t * t; };

// keyboard focus inside our own dialogs (menu, message boxes)
function uiNavigate(dir) {
  const items = [...document.querySelectorAll('#modal:not([hidden]) button, #drawer:not([hidden]) button, #drawer:not([hidden]) select, #drawer:not([hidden]) input')].filter((e) => e.offsetParent !== null);
  if (!items.length) return;
  let i = items.indexOf(document.activeElement);
  i = i < 0 ? 0 : (i + dir + items.length) % items.length;
  items[i].focus();
}

api.every(16, () => {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  const pad = pads.find((p) => p.mapping === 'standard') || pads[0];
  if (!pad) return;
  const e = (i) => edge(pad, i);
  const a = e(BTN_LEFT), b = e(BTN_RIGHT), start = e(9), select = e(8);
  const up = e(12), down = e(13), left = e(14), right = e(15);
  if (start === 1) api.openMenu();
  if (select === 1) api.toggleFullscreen();

  if (api.menuOpen()) {                    // our own menu / message box: D-pad moves focus, A presses
    if (up === 1 || left === 1) uiNavigate(-1);
    if (down === 1 || right === 1) uiNavigate(1);
    if (a === 1 && document.activeElement && document.activeElement.click) document.activeElement.click();
    if (b === 1) { const c = document.getElementById('drawerClose'); if (c && !document.getElementById('drawer').hidden) c.click(); }
    return;
  }

  // pointer
  const scr = api.screen(); const m = api.mouse();
  if (fx === null || Math.abs(fx - m.x) > 2 || Math.abs(fy - m.y) > 2) { fx = m.x; fy = m.y; }   // follow real mouse too
  const k = speed * (scr.w / 640) * (pressed(pad, 4) ? 0.3 : 1) * (pressed(pad, 6) ? 0.3 : 1);
  const dx = curve(pad.axes[0] || 0) * k, dy = curve(pad.axes[1] || 0) * k;
  if (dx || dy) { fx = Math.max(0, Math.min(scr.w - 1, fx + dx)); fy = Math.max(0, Math.min(scr.h - 1, fy + dy)); api.moveTo(fx, fy); }

  // buttons
  if (a) api.button(0, a === 1);
  if (b) api.button(2, b === 1);
  if (e(3) === 1) api.tapKey(VK.RETURN);   // Y: Enter
  if (e(2) === 1) api.tapKey(VK.ESCAPE);   // X: Escape

  // scrolling: D-pad (held keys) and right stick (taps)
  for (const [ev, vk] of [[up, VK.UP], [down, VK.DOWN], [left, VK.LEFT], [right, VK.RIGHT]]) if (ev) api.key(vk, ev === 1);
  const rx = curve(pad.axes[2] || 0), ry = curve(pad.axes[3] || 0);
  const now = performance.now();
  if ((rx || ry) && now - lastScroll > 140 - 100 * Math.max(Math.abs(rx), Math.abs(ry))) {
    lastScroll = now;
    if (Math.abs(rx) > 0.2) api.tapKey(rx > 0 ? VK.RIGHT : VK.LEFT);
    if (Math.abs(ry) > 0.2) api.tapKey(ry > 0 ? VK.DOWN : VK.UP);
  }
});
