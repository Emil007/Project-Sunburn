// Rivals overview (F8): a panel with every player's money and a chart of its history.
const de = api.lang === 'de';
const COLOURS = ['#888', '#ffff00', '#ffa700', '#ff007f', '#b700ff', '#ff73ff', '#00e3e3', '#0000ff', '#00ff77'];
const T = de ? { title: 'Konkurrenz', you: 'du', none: 'Starte oder lade ein Spiel.', since: 'Geld seit Beginn dieser Sitzung', close: 'Schließen (F8)' }
             : { title: 'Rivals', you: 'you', none: 'Start or load a game.', since: 'Money since you started this session', close: 'Close (F8)' };
const win = api.window({ title: T.title, width: 380, side: 'left' });
const panel = win.body;
const history = new Map();   // player -> [money per day]
let last = null;
const fmt = (n) => n.toLocaleString(de ? 'de-DE' : 'en-GB');
function render() {
  panel.textContent = '';
  if (!last) { const p = document.createElement('div'); p.textContent = T.none; p.style.padding = '6px 8px'; panel.appendChild(p); return; }
  const list = [...last.players].sort((a, b) => b.money - a.money);
  for (const pl of list) {
    const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 8px' });
    const sw = document.createElement('i'); Object.assign(sw.style, { width: '14px', height: '14px', background: COLOURS[pl.colour] || '#888', border: '1px solid #3c2410', display: 'inline-block' });
    const nm = document.createElement('span'); nm.style.flex = '1'; nm.style.fontWeight = pl.p === 1 ? '700' : 'normal'; nm.textContent = pl.name + (pl.p === 1 ? ` (${T.you})` : '');
    const mo = document.createElement('span'); mo.textContent = fmt(pl.money); mo.style.color = pl.money < 0 ? '#8a0000' : '#171717'; mo.style.fontVariantNumeric = 'tabular-nums';
    row.append(sw, nm, mo); panel.appendChild(row);
  }
  const cap = document.createElement('div'); cap.textContent = T.since; Object.assign(cap.style, { padding: '6px 8px 2px', fontSize: '11px', fontWeight: 'normal' }); panel.appendChild(cap);
  const cv = document.createElement('canvas'); cv.width = 362; cv.height = 140; cv.className = 'inset'; Object.assign(cv.style, { display: 'block', margin: '0 8px', background: '#6b5538' });
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
  if (win.shown) render();
});
api.onKey((e) => {
  if (e.code !== 'F8') return false;
  if (e.type === 'keydown' && !e.repeat) { if (win.toggle()) render(); }
  return true;
});
