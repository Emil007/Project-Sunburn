// Cheat menu (F9). Draws the panel and sends commands to script.js, which changes the game.
const CMD = { MONEY: 1, FREEZE_MONEY: 2, KEEP_WIN: 3, NEXT_BUILDING: 4, ALL_BUILDINGS: 5, NEXT_AUCTION: 6, ALL_ATTRACTIONS: 7,
  SKIP_DAYS: 8, FREEZE_TIME: 9, BANKRUPT: 10, STATE: 11, STOP_FF: 12 };
const de = api.lang === 'de';
const T = de ? {
  title: 'Cheats', close: 'Schließen (F9)', notInGame: 'Starte oder lade zuerst ein Spiel.',
  money: 'Geld', million: '+1 Million', billion: '+1 Milliarde', freezeMoney: 'Geld einfrieren',
  freezeMoneyHelp: 'Dein Kontostand bleibt, egal was du ausgibst.',
  keepWin: 'Original-Cheat ohne Strafe', keepWinHelp: 'Strg + Umschalt + Alt + G gibt im Original Geld, aber du kannst dann nicht mehr gewinnen. Hiermit schon.',
  menuNote: 'Cheats aus diesem Menü kosten dich nie den Sieg.',
  buildings: 'Gebäude', nextBuilding: 'Nächstes freischalten', allBuildings: 'Alle freischalten', left: (n) => `${n} noch gesperrt`,
  attractions: 'Sehenswürdigkeiten', nextAuction: 'Nächste Auktion starten', allAttractions: 'Alle ins Freizeit-Menü',
  auctionsLeft: (n) => `${n} Auktionen ausstehend`, auctionHelp: 'Die Auktion beginnt am nächsten Tag.',
  time: 'Zeit', week: 'Eine Woche', month: 'Einen Monat', year: 'Ein Jahr', ffLabel: 'Vorspulen (das Spiel läuft schnell, alles passiert wie sonst):', freezeTime: 'Zeit anhalten',
  freezeTimeHelp: 'Die Uhr steht: keine neuen Tage, Baustellen ruhen. Du kannst weiter bauen.', ff: (n) => `Spule vor … noch ${n} Tage`, ffPaused: 'Pause für Nachrichten oder Auktion – geht danach weiter.', stop: 'Anhalten',
  rivals: 'Konkurrenten', bankrupt: 'In die Pleite treiben', broke: 'pleite gemacht', rivalsHelp: 'Der Konkurrent geht nach den Regeln des Spiels pleite, seine Häuser werden versteigert.',
} : {
  title: 'Cheats', close: 'Close (F9)', notInGame: 'Start or load a game first.',
  money: 'Money', million: '+1 million', billion: '+1 billion', freezeMoney: 'Freeze money',
  freezeMoneyHelp: 'Your balance stays the same whatever you spend.',
  keepWin: 'Original cheat without penalty', keepWinHelp: 'Ctrl + Shift + Alt + G gives money in the original, but then you can no longer win. With this on you still can.',
  menuNote: 'Cheats from this menu never cost you the win.',
  buildings: 'Buildings', nextBuilding: 'Unlock next', allBuildings: 'Unlock all', left: (n) => `${n} still locked`,
  attractions: 'Attractions', nextAuction: 'Start next auction', allAttractions: 'All into the Attractions menu',
  auctionsLeft: (n) => `${n} auctions to come`, auctionHelp: 'The auction starts the next day.',
  time: 'Time', week: 'A week', month: 'A month', year: 'A year', ffLabel: 'Fast-forward (the game runs fast, everything happens as usual):', freezeTime: 'Freeze time',
  freezeTimeHelp: 'The clock stops: no new days, construction waits. You can keep building.', ff: (n) => `Fast-forwarding … ${n} days to go`, ffPaused: 'Paused for the news or an auction – goes on afterwards.', stop: 'Stop',
  rivals: 'Rivals', bankrupt: 'Bankrupt', broke: 'bankrupted', rivalsHelp: 'The rival goes bankrupt by the game\'s own rules and their property is auctioned.',
};

const root = api.overlay();
const panel = document.createElement('div');
root.appendChild(panel);
panel.hidden = true;
Object.assign(panel.style, {
  position: 'absolute', right: '16px', top: '16px', width: '330px', maxHeight: 'calc(100% - 32px)', overflowY: 'auto',
  pointerEvents: 'auto', background: 'linear-gradient(#c89a5e, #a8783e)', color: '#2a1606', border: '2px solid #3c2410',
  boxShadow: 'inset 1px 1px 0 #ffecbe, inset -1px -1px 0 #5a3618, 0 6px 24px rgba(0,0,0,.5)', borderRadius: '4px',
  font: '13px/1.35 system-ui, sans-serif', padding: '0 0 10px', zIndex: 50, userSelect: 'none',
});
const css = document.createElement('style');
css.textContent = `
.hi-cheat h2 { margin: 0 0 6px; padding: 6px 10px; font-size: 15px; color: #ffe66e; background: linear-gradient(#6a3e8e, #4a2470); border-bottom: 2px solid #3c2410; letter-spacing: .08em; text-shadow: 1px 1px 0 #000; }
.hi-cheat h3 { margin: 10px 10px 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #3c2410; }
.hi-cheat .row { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 10px; align-items: center; }
.hi-cheat button { flex: 1; min-width: 80px; padding: 5px 8px; font: inherit; font-weight: 600; color: #2a1606; cursor: pointer;
  background: linear-gradient(#f0d29a, #d2a868); border: 1px solid #3c2410; box-shadow: inset 1px 1px 0 #ffecbe, inset -1px -1px 0 #8a5a28; border-radius: 3px; }
.hi-cheat button:hover:not(:disabled) { background: linear-gradient(#fbe2b0, #e0b878); }
.hi-cheat button:active:not(:disabled) { box-shadow: inset -1px -1px 0 #ffecbe, inset 1px 1px 0 #8a5a28; }
.hi-cheat button:disabled { opacity: .5; cursor: default; }
.hi-cheat label { display: flex; gap: 6px; align-items: center; margin: 4px 10px 0; font-weight: 600; cursor: pointer; }
.hi-cheat .help { margin: 2px 10px 0; font-size: 12px; color: #4a2c10; }
.hi-cheat .rival { display: flex; align-items: center; gap: 8px; margin: 3px 10px 0; }
.hi-cheat .rival span { flex: 1; font-weight: 600; }
.hi-cheat .rival button { flex: 0 0 auto; min-width: 0; }
.hi-cheat .close { margin: 10px 10px 0; width: calc(100% - 20px); }`;
root.appendChild(css);
panel.className = 'hi-cheat';

let state = { inGame: false };
const COLOURS = [null, ['#ffff00', 'yellow', 'gelb'], ['#ffa700', 'orange', 'orange'], ['#ff007f', 'red', 'rot'], ['#b700ff', 'purple', 'lila'],
  ['#ff73ff', 'pink', 'rosa'], ['#00e3e3', 'turquoise', 'türkis'], ['#0000ff', 'blue', 'blau'], ['#00ff77', 'green', 'grün']];
const swatch = (c) => { const k = COLOURS[c]; const e = document.createElement('i'); if (!k) return e;
  Object.assign(e.style, { display: 'inline-block', width: '14px', height: '14px', background: k[0], border: '1px solid #3c2410', marginRight: '6px', verticalAlign: '-2px' }); e.title = k[de ? 2 : 1]; return e; };
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
const btn = (text, fn, disabled = false) => el('button', { textContent: text, disabled, onclick: (e) => { e.stopPropagation(); fn(); } });
const toggle = (text, on, fn) => { const cb = el('input', { type: 'checkbox', checked: on, onchange: () => fn(cb.checked) }); return el('label', {}, cb, text); };
const help = (text) => el('div', { className: 'help', textContent: text });

function render() {
  panel.textContent = '';
  panel.append(el('h2', { textContent: T.title }));
  if (!state.inGame) {
    panel.append(help(T.notInGame), el('div', { className: 'row' }, btn(T.close, close)));
    return;
  }
  const s = state;
  panel.append(
    el('h3', { textContent: T.money }),
    el('div', { className: 'row' }, btn(T.million, () => api.command(CMD.MONEY, 1000000)), btn(T.billion, () => api.command(CMD.MONEY, 1000000000))),
    toggle(T.freezeMoney, s.freezeMoney, (v) => api.command(CMD.FREEZE_MONEY, v ? 1 : 0)), help(T.freezeMoneyHelp),
    toggle(T.keepWin, s.keepWin, (v) => { save('keepWin', v); api.command(CMD.KEEP_WIN, v ? 1 : 0); }), help(T.keepWinHelp),
    help(T.menuNote),

    el('h3', { textContent: T.buildings }),
    el('div', { className: 'row' }, btn(T.nextBuilding, () => api.command(CMD.NEXT_BUILDING), !s.buildingsLeft), btn(T.allBuildings, () => api.command(CMD.ALL_BUILDINGS), !s.buildingsLeft)),
    help(T.left(s.buildingsLeft)),

    el('h3', { textContent: T.attractions }),
    el('div', { className: 'row' }, btn(T.nextAuction, () => api.command(CMD.NEXT_AUCTION), !s.auctionsLeft), btn(T.allAttractions, () => api.command(CMD.ALL_ATTRACTIONS))),
    help(`${T.auctionsLeft(s.auctionsLeft)}. ${T.auctionHelp}`),

    el('h3', { textContent: T.time }),
    help(T.ffLabel),
    el('div', { className: 'row' }, btn(T.week, () => api.command(CMD.SKIP_DAYS, 7), !!s.ff), btn(T.month, () => api.command(CMD.SKIP_DAYS, 30), !!s.ff), btn(T.year, () => api.command(CMD.SKIP_DAYS, 365), !!s.ff)),
    ...(s.ff ? [el('div', { className: 'row' }, el('span', { textContent: T.ff(s.ff), style: 'flex:2;font-weight:600' }), btn(T.stop, () => api.command(CMD.STOP_FF))), ...(s.ffPaused ? [help(T.ffPaused)] : [])] : []),
    toggle(T.freezeTime, s.freezeTime, (v) => api.command(CMD.FREEZE_TIME, v ? 1 : 0)), help(T.freezeTimeHelp),

    el('h3', { textContent: T.rivals }),
    ...s.rivals.map((r) => el('div', { className: 'rival' }, el('span', {}, swatch(r.colour), r.name + (COLOURS[r.colour] ? ` (${COLOURS[r.colour][de ? 2 : 1]})` : '') + (r.broke ? ` – ${T.broke}` : '')), btn(T.bankrupt, () => api.command(CMD.BANKRUPT, r.p), r.broke))),
    help(T.rivalsHelp),

    btn(T.close, close),
  );
  panel.lastChild.classList.add('close');
}

// remembered between games: the "original cheat without penalty" switch
const KEY = 'hi.cheats';
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
function save(k, v) { saved[k] = v; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* */ } }

function open() { panel.hidden = false; api.command(CMD.STATE); render(); }
function close() { panel.hidden = true; }
api.onKey((e) => {
  if (e.code === 'Escape' && !panel.hidden) { if (e.type === 'keydown') close(); return true; }
  if (e.code !== 'F9') return false;
  if (e.type === 'keydown' && !e.repeat) { if (panel.hidden) open(); else close(); }
  return true;
});
api.onMessage((d) => {
  const was = state.inGame; state = d;
  if (d.inGame && !was && saved.keepWin) api.command(CMD.KEEP_WIN, 1);
  if (!panel.hidden) render();
});
api.every(2000, () => { if (!state.inGame) api.command(CMD.STATE); });
