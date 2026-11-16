// Electron shell: serves the web build over app:// with cross-origin isolation headers.
const { app, BrowserWindow, protocol, Menu, shell, net, session } = require('electron');
const os = require('os');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.sf2': 'application/octet-stream', '.md': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8' };
const root = path.join(__dirname, 'web');

// keep the profile (imported discs, saves, settings) of earlier versions named "Holiday Island"
app.setPath('userData', path.join(app.getPath('appData'), 'Holiday Island'));

const ISO = { 'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const UA = () => session.defaultSession.getUserAgent().replace(/ (Electron|project-sunburn|Project Sunburn)\/[^ ]+/gi, '');
const fail = (msg) => new Response(String(msg), { status: 599, headers: ISO });

// Disc downloads: the launcher can't read other sites itself (CORS), so the app fetches for it.
// Only http(s) URLs, only for our own page (app:// is not reachable from the web).
async function proxyFetch(u) {
  const target = u.searchParams.get('u'), referer = u.searchParams.get('r');
  if (!target || !/^https?:\/\//i.test(target)) return fail('bad url');
  try {
    const headers = { 'user-agent': UA(), accept: '*/*' }; if (referer) headers.referer = referer;
    const r = await net.fetch(target, { headers, redirect: 'follow' });
    const h = { ...ISO, 'x-final-url': r.url || target };
    for (const k of ['content-type', 'content-length', 'content-disposition']) { const v = r.headers.get(k); if (v) h[k] = v; }
    return new Response(r.body, { status: r.status, headers: h });
  } catch (e) { return fail(e && e.message || e); }
}

// Pages that need a click or a browser check: show the page in a window and hand the download the
// player starts there to the launcher.
let browsing = null;
function browseDownload(u) {
  const target = u.searchParams.get('u');
  if (!target || !/^https?:\/\//i.test(target)) return fail('bad url');
  if (browsing) browsing.close();
  return new Promise((resolve) => {
    const win = new BrowserWindow({ width: 1100, height: 850, title: 'Download the disc image – Project Sunburn', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:downloads' } });
    browsing = win; let done = false;
    const ses = win.webContents.session;
    win.webContents.setWindowOpenHandler(({ url }) => { win.loadURL(url); return { action: 'deny' }; });   // keep pop-ups in this window
    const onDl = (_e, item) => {
      const name = item.getFilename();
      const file = path.join(os.tmpdir(), `sunburn-${Date.now()}-${name.replace(/[^\w.\- ()]/g, '_')}`);
      item.setSavePath(file);
      item.on('updated', () => { const t = item.getTotalBytes(), r = item.getReceivedBytes(); if (!win.isDestroyed()) win.setTitle(`Downloading ${name} – ${(r / 1048576).toFixed(0)}${t ? ' / ' + (t / 1048576).toFixed(0) : ''} MB`); });
      item.once('done', async (_e2, state) => {
        ses.removeListener('will-download', onDl); done = true;
        if (!win.isDestroyed()) win.close();
        if (state !== 'completed') { resolve(fail('download ' + state)); return; }
        const st = await fs.promises.stat(file);
        const stream = fs.createReadStream(file); stream.on('close', () => fs.promises.unlink(file).catch(() => {}));
        resolve(new Response(Readable.toWeb(stream), { status: 200, headers: { ...ISO, 'content-type': 'application/octet-stream', 'content-length': String(st.size), 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'x-final-url': item.getURL() } }));
      });
    };
    ses.on('will-download', onDl);
    win.on('closed', () => { if (browsing === win) browsing = null; if (!done) { ses.removeListener('will-download', onDl); resolve(new Response('cancelled', { status: 499, headers: ISO })); } });
    win.loadURL(target);
  });
}

// ---- start options (RecompLauncher and other front-ends, see recomplauncher.json) ----
//   --disc <image>      play this disc image (.iso, .mds/.mdf, .cue/.bin); added to the library once
//   --play              start the game right away (default with --disc)
//   --launcher          show the launcher even with --disc
//   --fullscreen / --windowed
//   --set key=value     a launcher setting for this start (scale, aspect, video, music, sfx, musicSrc, ui)
//   --mod id=on|off     switch a mod on or off
//   --modset id.key=value  a mod setting, e.g. display-filter.style=crt
// RECOMPLAUNCHER_MODE=bigpicture starts in full screen.
function parseArgs(argv) {
  const o = { disc: null, play: false, launcher: false, fullscreen: process.env.RECOMPLAUNCHER_MODE === 'bigpicture', set: {}, mods: {}, modset: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--disc' || a === '--iso') o.disc = next();
    else if (a.startsWith('--disc=')) o.disc = a.slice(7);
    else if (a === '--play') o.play = true;
    else if (a === '--launcher') o.launcher = true;
    else if (a === '--fullscreen') o.fullscreen = true;
    else if (a === '--windowed') o.fullscreen = false;
    else if (a === '--set') { const [k, ...v] = String(next() || '').split('='); if (k) o.set[k] = v.join('='); }
    else if (a === '--modset') { const [k, ...v] = String(next() || '').split('='); if (k && k.includes('.')) o.modset[k] = v.join('='); }
    else if (a === '--mod') { const [k, v] = String(next() || '').split('='); if (k) o.mods[k] = v !== 'off' && v !== '0' && v !== 'false'; }
    else if (!a.startsWith('-') && /\.(iso|mds|mdf|cue|bin|img)$/i.test(a) && !o.disc) o.disc = a;   // a disc image dropped on the program
  }
  if (o.disc) { o.disc = path.resolve(o.disc); if (!o.launcher) o.play = true; }
  return o;
}
const launch = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));

// the disc image and the files that belong to it (an .mds with its .mdf, a .cue with its tracks)
function discFiles(main) {
  const dir = path.dirname(main), base = path.basename(main), stem = base.replace(/\.[^.]+$/, '').toLowerCase();
  const names = new Set([base]);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  for (const e of entries) if (e.replace(/\.[^.]+$/, '').toLowerCase() === stem && /\.(iso|mds|mdf|cue|bin|img)$/i.test(e)) names.add(e);
  if (/\.cue$/i.test(base)) {
    try { for (const m of fs.readFileSync(main, 'latin1').matchAll(/FILE\s+"([^"]+)"/gi)) { const n = path.basename(m[1]); if (entries.includes(n)) names.add(n); } } catch { /* */ }
  }
  return [...names].map((n) => { try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { name: n, size: st.size } : null; } catch { return null; } }).filter(Boolean);
}

// saves are mirrored to Documents/Project Sunburn/Saves/<en|de>/ so backups (and RecompLauncher's
// cloud saves) see real files
const savesRoot = () => path.join(app.getPath('documents'), 'Project Sunburn', 'Saves');
function safeSavePath(lang, p) {
  if (lang !== 'en' && lang !== 'de') return null;
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..');
  if (!parts.length) return null;
  return path.join(savesRoot(), lang, ...parts);
}
async function savesRoute(req, u) {
  const lang = u.searchParams.get('lang');
  if (req.method === 'GET' && !u.searchParams.get('path')) {
    const base = path.join(savesRoot(), lang === 'de' ? 'de' : 'en'); const out = [];
    const walk = (d, rel) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const r = rel ? rel + '\\' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else { const st = fs.statSync(path.join(d, e.name)); if (st.size < 8 << 20) out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } } };
    walk(base, '');
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', ...ISO } });
  }
  const f = safeSavePath(lang, u.searchParams.get('path'));
  if (!f) return fail('bad path');
  if (req.method === 'GET') { try { return new Response(await fs.promises.readFile(f), { headers: ISO }); } catch { return new Response('not found', { status: 404, headers: ISO }); } }
  if (req.method === 'DELETE') { try { await fs.promises.unlink(f); } catch { /* */ } return new Response('ok', { headers: ISO }); }
  if (req.method === 'PUT') { await fs.promises.mkdir(path.dirname(f), { recursive: true }); await fs.promises.writeFile(f, Buffer.from(await req.arrayBuffer())); return new Response('ok', { headers: ISO }); }
  return fail('bad method');
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/__launch') {
      const files = launch.disc ? discFiles(launch.disc) : [];
      return new Response(JSON.stringify({ disc: files.length ? { files } : null, play: launch.play, set: launch.set, mods: launch.mods, modset: launch.modset, recomplauncher: !!process.env.RECOMPLAUNCHER }), { headers: { 'content-type': 'application/json', ...ISO } });
    }
    if (u.pathname === '/__launchfile') {
      // only the files of the disc named on the command line
      const name = u.searchParams.get('name'); const files = launch.disc ? discFiles(launch.disc) : [];
      if (!files.some((f) => f.name === name)) return new Response('not found', { status: 404, headers: ISO });
      const f = path.join(path.dirname(launch.disc), name);
      return new Response(Readable.toWeb(fs.createReadStream(f)), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(fs.statSync(f).size), ...ISO } });
    }
    if (u.pathname === '/__saves') return savesRoute(req, u);
    if (u.pathname === '/__fetch') return proxyFetch(u);
    if (u.pathname === '/__browse') return browseDownload(u);
    let p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) return new Response('forbidden', { status: 403 });
    try { if ((await fs.promises.stat(p)).isDirectory()) p = path.join(p, 'index.html'); } catch { return new Response('not found', { status: 404 }); }
    const data = await fs.promises.readFile(p);
    return new Response(data, { headers: { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  });
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280, height: 980, minWidth: 660, minHeight: 520, backgroundColor: '#04263f', title: 'Holiday Island – Project Sunburn', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    else if (url.startsWith('app://')) return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 900, autoHideMenuBar: true, backgroundColor: '#ffffff' } };  // MODDING.md
    return { action: 'deny' };
  });
  // developer tools for mod authors: Ctrl+Shift+I or F12
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  if (launch.fullscreen) win.setFullScreen(true);
  win.loadURL('app://holiday/index.html');
});
app.on('window-all-closed', () => app.quit());
