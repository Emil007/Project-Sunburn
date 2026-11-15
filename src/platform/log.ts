// Session log: everything noteworthy from the launcher, the renderer, the mods and the emulator worker
// goes into a ring buffer that the player can save (F10 menu / launcher footer) and send in.
const MAX = 20000;
const lines: string[] = [];
const t0 = performance.now();
let dropped = 0;

function stamp() {
  const ms = performance.now() - t0;
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(3, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}
export function hiLog(level: 'info' | 'warn' | 'error' | 'debug' | 'game' | 'input', ...parts: any[]) {
  const text = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? `${p.message}\n${p.stack || ''}` : (() => { try { return JSON.stringify(p); } catch { return String(p); } })())).join(' ');
  lines.push(`${stamp()} [${level}] ${text}`);
  if (lines.length > MAX) { lines.splice(0, lines.length - MAX); dropped++; }
}
export function logText() {
  return (dropped ? `(older lines dropped)\n` : '') + lines.join('\n') + '\n';
}
export function saveLog() {
  const blob = new Blob([logText()], { type: 'text/plain' });
  const a = document.createElement('a');
  const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `holiday-island-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// capture console output and uncaught errors too
for (const k of ['log', 'info', 'warn', 'error'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: any[]) => { hiLog(k === 'log' ? 'info' : k, ...a); orig(...a); };
}
window.addEventListener('error', (e) => hiLog('error', `uncaught: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => hiLog('error', 'unhandled rejection:', e.reason));
hiLog('info', `Project Sunburn, ${navigator.userAgent}`);
hiLog('info', `screen ${screen.width}x${screen.height} @${devicePixelRatio}, window ${innerWidth}x${innerHeight}, crossOriginIsolated=${(self as any).crossOriginIsolated}`);
