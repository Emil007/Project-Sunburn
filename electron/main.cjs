// Electron shell: serves the web build over app:// with cross-origin isolation headers.
const { app, BrowserWindow, protocol, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.sf2': 'application/octet-stream', '.md': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8' };
const root = path.join(__dirname, 'web');

// keep the profile (imported discs, saves, settings) of earlier versions named "Holiday Island"
app.setPath('userData', path.join(app.getPath('appData'), 'Holiday Island'));

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
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
