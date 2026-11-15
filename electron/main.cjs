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

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
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
  win.loadURL('app://holiday/index.html');
});
app.on('window-all-closed', () => app.quit());
