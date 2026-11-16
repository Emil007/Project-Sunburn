// Rivals overview (F8): a panel with every player's money and a chart of its history.
const de = api.lang === 'de';
const COLOURS = ['#888', '#ffff00', '#ffa700', '#ff007f', '#b700ff', '#ff73ff', '#00e3e3', '#0000ff', '#00ff77'];
const T = de ? { title: 'Konkurrenz', you: 'du', none: 'Starte oder lade ein Spiel.', since: 'Geld seit Beginn dieser Sitzung', close: 'Schließen (F8)' }
             : { title: 'Rivals', you: 'you', none: 'Start or load a game.', since: 'Money since you started this session', close: 'Close (F8)' };
const root = api.overlay();
const panel = document.createElement('div'); root.appendChild(panel); panel.hidden = true;
Object.assign(panel.style, { position: 'absolute', left: '16px', top: '16px', width: '380px', pointerEvents: 'auto', background: 'linear-gradient(#c89a5e, #a8783e)',
  color: '#2a1606', border: '2px solid #3c2410', borderRadius: '4px', boxShadow: 'inset 1px 1px 0 #ffecbe, inset -1px -1px 0 #5a3618, 0 6px 24px rgba(0,0,0,.5)',
  font: '13px/1.35 system-ui, sans-serif', paddingBottom: '8px', zIndex: 49, userSelect: 'none' });
const history = new Map();   // player -> [money per day]
let last = null;
const fmt = (n) => n.toLocaleString(de ? 'de-DE' : 'en-GB');
function render() {
  panel.textContent = '';
  const h = document.createElement('div'); h.textContent = T.title;
  Object.assign(h.style, { padding: '6px 10px', fontWeight: '700', fontSize: '15px', color: '#ffe66e', background: 'linear-gradient(#6a3e8e, #4a2470)', borderBottom: '2px solid #3c2410', textShadow: '1px 1px 0 #000' });
  panel.appendChild(h);
  if (!last) { const p = document.createElement('div'); p.textContent = T.none; p.style.padding = '8px 10px'; panel.appendChild(p); return; }
  const list = [...last.players].sort((a, b) => b.money - a.money);
  for (const pl of list) {
    const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 10px' });
    const sw = document.createElement('i'); Object.assign(sw.style, { width: '14px', height: '14px', background: COLOURS[pl.colour] || '#888', border: '1px solid #3c2410', display: 'inline-block' });
    const nm = document.createElement('span'); nm.style.flex = '1'; nm.style.fontWeight = pl.p === 1 ? '700' : '600'; nm.textContent = pl.name + (pl.p === 1 ? ` (${T.you})` : '');
    const mo = document.createElement('span'); mo.textContent = fmt(pl.money); mo.style.color = pl.money < 0 ? '#8a0000' : '#2a1606'; mo.style.fontVariantNumeric = 'tabular-nums';
    row.append(sw, nm, mo); panel.appendChild(row);
  }
  const cap = document.createElement('div'); cap.textContent = T.since; Object.assign(cap.style, { padding: '6px 10px 2px', fontSize: '12px' }); panel.appendChild(cap);
  const cv = document.createElement('canvas'); cv.width = 360; cv.height = 140; Object.assign(cv.style, { display: 'block', margin: '0 10px', background: '#f6e4c0', border: '1px solid #3c2410' });
  panel.appendChild(cv); chart(cv);
}
function chart(cv) {
  const g = cv.getContext('2d'); if (!g) return;
  let lo = Infinity, hi = -Infinity, len = 0;
  for (const v of history.values()) { for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); } len = Math.max(len, v.length); }
  if (len < 2) return;
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = (i) => 4 + (i / (len - 1)) * (cv.width - 8), Y = (v) => cv.height - 4 - ((v - lo) / (hi - lo)) * (cv.height - 8);
  if (lo < 0 && hi > 0) { g.strokeStyle = '#b89870'; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(cv.width, Y(0)); g.stroke(); }
  for (const pl of last.players) {
    const v = history.get(pl.p); if (!v || v.length < 2) continue;
    g.strokeStyle = COLOURS[pl.colour] || '#888'; g.lineWidth = pl.p === 1 ? 2.5 : 1.5; g.beginPath();
    v.forEach((x, i) => (i ? g.lineTo(X(i + len - v.length), Y(x)) : g.moveTo(X(i + len - v.length), Y(x))));
    g.stroke();
  }
}
api.onMessage((d) => {
  last = d;
  for (const pl of d.players) { const v = history.get(pl.p) || []; v.push(pl.money); if (v.length > 2000) v.shift(); history.set(pl.p, v); }
  if (!panel.hidden) render();
});
api.onKey((e) => {
  if (e.code !== 'F8') return false;
  if (e.type === 'keydown' && !e.repeat) { panel.hidden = !panel.hidden; if (!panel.hidden) render(); }
  return true;
});
