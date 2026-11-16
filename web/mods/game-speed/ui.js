// Speed hotkeys: F5 normal, F6 2x, F7 5x, Pause pauses / goes on. Gamepad: RB steps through the speeds.
const KEYS = { F5: 0, F6: 1, F7: 2 };
api.onKey((e) => {
  if (e.code in KEYS) { if (e.type === 'keydown' && !e.repeat) api.command(1, KEYS[e.code]); return true; }
  if (e.code === 'Pause') { if (e.type === 'keydown' && !e.repeat) api.command(2); return true; }
  return false;
});
let rb = false;
api.every(50, () => {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let now = false;
  for (const p of pads) if (p && p.buttons[5] && p.buttons[5].pressed) now = true;
  if (now && !rb) api.command(3);
  rb = now;
});
