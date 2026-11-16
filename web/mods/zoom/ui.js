// Zoom keys: + / − (main keys or number pad) zoom in and out, 0 goes back to 1x.
let state = { map: false, typing: false };
api.onMessage((m) => { if (m) state = m; });
api.onKey((e) => {
  if (!state.map || state.typing) return false;
  const inK = e.code === 'NumpadAdd' || e.key === '+' || (e.code === 'Equal' && e.shiftKey);
  const outK = e.code === 'NumpadSubtract' || e.key === '-';
  const resetK = e.code === 'Numpad0' || e.key === '0';
  if (!inK && !outK && !resetK) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.type === 'keydown') api.command(inK ? 1 : outK ? 2 : 3);
  return true;
});
