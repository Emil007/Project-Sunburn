// Download a disc image from a link the player pastes.
//
// Works with direct file links, archive.org items (via archive.org's public metadata API) and ordinary
// download pages: the page is read and the most likely download link is followed (a few levels deep).
// Zip archives are unpacked and only the disc image files are kept. Nothing about specific sites is
// hard-coded apart from archive.org's documented API.
//
// In the browser, other sites can only be read if they allow it (CORS). The desktop app fetches through
// its own process and has no such limit; for pages that need a click (or a bot check) it opens the page
// in a window and takes over the download the player starts there.
import { Unzip, UnzipInflate } from 'fflate';

export interface DlProgress { (text: string, fraction?: number): void }
export class DownloadError extends Error { constructor(msg: string, public page?: string) { super(msg); } }

const DISC_EXT = /\.(iso|bin|cue|img|mdf|mds|ccd|sub|nrg)$/i;
const ARCHIVE_EXT = /\.(zip|7z|rar|gz|tar)$/i;
const isElectron = /Electron/.test(navigator.userAgent);

// ---------- fetching ----------
let proxy = '';
/** optional proxy for the web version: a URL prefix the target URL is appended to (encoded), e.g. a
 *  Cloudflare Worker from tools/cors-proxy. It must answer with CORS headers. */
export function setDownloadProxy(p: string) { proxy = p.trim(); }
async function get(url: string, referer?: string, signal?: AbortSignal): Promise<Response> {
  if (isElectron) {
    const q = new URLSearchParams({ u: url }); if (referer) q.set('r', referer);
    const r = await fetch('/__fetch?' + q, { signal });
    if (r.status === 599) throw new DownloadError(await r.text());
    return r;
  }
  try { return await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', signal }); }
  catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    if (proxy) {
      const pu = proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + encodeURIComponent(url);
      try { return await fetch(pu, { mode: 'cors', credentials: 'omit', signal, headers: referer ? { 'x-referer': referer } : {} }); }
      catch (e2: any) { if (e2?.name === 'AbortError') throw e2; throw new DownloadError('proxy', url); }
    }
    throw new DownloadError('blocked', url);   // CORS or network: the site doesn't let web pages download from it
  }
}
const finalUrl = (r: Response, fallback: string) => r.headers.get('x-final-url') || r.url || fallback;
const isHtml = (r: Response) => /text\/html|application\/xhtml/i.test(r.headers.get('content-type') || '');

function fileName(r: Response, url: string) {
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  let n = m ? decodeURIComponent(m[1].trim()) : decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  n = n.replace(/[\\/:*?"<>|]/g, '_').trim();
  return n || 'download.bin';
}

// ---------- archive.org ----------
// archive.org serves files with CORS headers under /cors/<item>/<file>
async function archiveOrg(url: URL, signal?: AbortSignal): Promise<string[] | null> {
  if (!/(^|\.)archive\.org$/i.test(url.hostname)) return null;
  const m = /^\/(details|download|cors)\/([^/]+)(\/.*)?$/.exec(url.pathname) || /^\/\d+\/(items)\/([^/]+)(\/.*)?$/.exec(url.pathname); if (!m) return null;
  const id = m[2];
  if (m[1] !== 'details' && m[3] && m[3].length > 1) return [`https://archive.org/cors/${id}${m[3]}`];   // a file inside the item
  const r = await get(`https://archive.org/metadata/${encodeURIComponent(id)}`, undefined, signal);
  if (!r.ok) throw new DownloadError(`archive.org: ${r.status}`);
  const meta = await r.json(); const files: { name: string; size?: string }[] = meta.files || [];
  const dl = (n: string) => `https://archive.org/cors/${encodeURIComponent(id)}/${n.split('/').map(encodeURIComponent).join('/')}`;
  const pick = pickDiscFiles(files.map((f) => f.name));
  if (pick.length) return pick.map(dl);
  const zips = files.filter((f) => /\.zip$/i.test(f.name)).sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  if (zips.length) return [dl(zips[0].name)];
  throw new DownloadError('noImage');
}
/** choose the files of one disc image from a list of names */
function pickDiscFiles(names: string[]): string[] {
  const by = (re: RegExp) => names.filter((n) => re.test(n));
  const mds = by(/\.mds$/i)[0]; if (mds) { const mdf = names.find((n) => n.toLowerCase() === mds.toLowerCase().replace(/\.mds$/, '.mdf')); if (mdf) return [mds, mdf]; }
  const iso = by(/\.iso$/i); if (iso.length) return [iso[0]];
  const cue = by(/\.cue$/i)[0]; if (cue) { const bins = by(/\.(bin|img)$/i); if (bins.length) return [cue, ...bins]; }
  const img = by(/\.(bin|img|mdf)$/i); if (img.length) return [img[0]];
  return [];
}

// ---------- download pages ----------
interface Link { url: string; score: number }
function linksOf(html: string, base: string): Link[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Map<string, number>();
  const add = (href: string | null, text: string, bonus = 0) => {
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) return;
    let u: URL; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = ''; const s = u.href; if (s === base) return;
    const p = decodeURIComponent(u.pathname).toLowerCase(); const t = text.toLowerCase();
    let sc = bonus;
    if (DISC_EXT.test(p) || ARCHIVE_EXT.test(p)) sc += 100;
    if (/download|\bdl\b|get[-_]?file/.test(p) || /\/dl[./-]|\bdl\d*\./.test(s)) sc += 30;
    if (/download|herunterladen|get it|\bdl\b/.test(t)) sc += 25;
    if (/\biso\b|disc|cd[- ]?rom|image/.test(t + ' ' + p)) sc += 10;
    if (/rip\b/.test(t)) sc -= 5;
    if (/facebook|twitter|reddit|discord|patreon|login|register|signup|comment|forum|privacy|terms|dmca|\.(png|jpe?g|gif|webp|css|js)$/i.test(s)) sc -= 200;
    if (sc > 0) out.set(s, Math.max(out.get(s) || 0, sc));
  };
  doc.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href'), (a.textContent || '') + ' ' + (a.getAttribute('title') || '') + ' ' + (a.className || '')));
  doc.querySelectorAll('[data-href],[data-url],[data-link]').forEach((e) => add(e.getAttribute('data-href') || e.getAttribute('data-url') || e.getAttribute('data-link'), e.textContent || '', 5));
  doc.querySelectorAll('form[action]').forEach((f) => { if ((f.getAttribute('method') || 'get').toLowerCase() === 'get') add(f.getAttribute('action'), f.textContent || '', 0); });
  const refresh = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content'); const rm = refresh && /url=(.+)$/i.exec(refresh); if (rm) add(rm[1].replace(/['"]/g, ''), 'download', 60);
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:zip|iso|7z|rar|mdf|mds|bin|cue)\b/gi)) add(m[0], '', 20);   // links in scripts
  return [...out].map(([url, score]) => ({ url, score })).sort((a, b) => b.score - a.score);
}

/** follows a link until it reaches a file; returns the response of that file */
async function resolve(url: string, progress: DlProgress, signal?: AbortSignal): Promise<{ res: Response; url: string }[]> {
  const ia = await archiveOrg(new URL(url), signal);
  if (ia) {
    const out: { res: Response; url: string }[] = [];
    for (const u of ia) { const r = await get(u, undefined, signal); if (!r.ok) throw new DownloadError(`HTTP ${r.status}`); out.push({ res: r, url: finalUrl(r, u) }); }
    return out;
  }
  const seen = new Set<string>(); let queue: { url: string; referer?: string }[] = [{ url }]; let tries = 0;
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next: { url: string; referer?: string }[] = [];
    for (const q of queue) {
      if (seen.has(q.url) || tries++ > 12) continue; seen.add(q.url);
      progress(`… ${new URL(q.url).hostname}${new URL(q.url).pathname}`.slice(0, 120));
      let r: Response; try { r = await get(q.url, q.referer, signal); } catch (e) { if (depth === 0) throw e; continue; }
      if (!r.ok) { if (depth === 0) throw new DownloadError(`HTTP ${r.status}`, url); continue; }
      const fu = finalUrl(r, q.url);
      if (!isHtml(r)) {
        const n = fileName(r, fu);
        if (DISC_EXT.test(n) || ARCHIVE_EXT.test(n) || Number(r.headers.get('content-length') || 0) > 5e6) return [{ res: r, url: fu }];
        void r.body?.cancel(); continue;
      }
      const html = await r.text();
      for (const l of linksOf(html, fu).slice(0, 4)) next.push({ url: l.url, referer: fu });
    }
    queue = next;
  }
  throw new DownloadError('noLink', url);
}

// ---------- storage ----------
async function tempDir(): Promise<FileSystemDirectoryHandle | null> {
  try { const root = await navigator.storage.getDirectory(); return await root.getDirectoryHandle('downloads', { create: true }); } catch { return null; }
}
export async function clearDownloads() { try { const root = await navigator.storage.getDirectory(); await root.removeEntry('downloads', { recursive: true }); } catch { /* none */ } }

type Sink = { write(c: Uint8Array): Promise<void>; close(): Promise<File> };
async function sink(dir: FileSystemDirectoryHandle | null, name: string): Promise<Sink> {
  if (dir) {
    const h = await dir.getFileHandle(name, { create: true }); const ws = await (h as any).createWritable();
    return { write: (c) => ws.write(c), close: async () => { await ws.close(); const f = await h.getFile(); (f as any).__handle = h; return f; } };
  }
  const parts: Uint8Array[] = [];
  return { write: async (c) => { parts.push(c); }, close: async () => new File(parts as BlobPart[], name) };
}

async function save(res: Response, url: string, dir: FileSystemDirectoryHandle | null, progress: DlProgress, label: string): Promise<File[]> {
  const name = fileName(res, url); const total = Number(res.headers.get('content-length') || 0);
  if (/\.(7z|rar|gz|tar)$/i.test(name)) { void res.body?.cancel(); throw new DownloadError('archiveFormat:' + name.split('.').pop()); }
  const isZip = /\.zip$/i.test(name);
  const reader = res.body!.getReader(); let got = 0; let lastP = 0;
  const tick = () => { const now = performance.now(); if (now - lastP > 150) { lastP = now; progress(`${label} ${name} · ${(got / 1048576).toFixed(0)}${total ? ' / ' + (total / 1048576).toFixed(0) : ''} MB`, total ? got / total : undefined); } };
  if (!isZip) {
    const s = await sink(dir, name);
    for (;;) { const { done, value } = await reader.read(); if (done) break; await s.write(value); got += value.length; tick(); }
    return [await s.close()];
  }
  // zip: unpack on the fly, keep only disc image files
  const out: Promise<File>[] = []; let chain: Promise<unknown> = Promise.resolve(); let err: any = null;
  const uz = new Unzip((f) => {
    const base = f.name.split('/').pop() || '';
    if (!DISC_EXT.test(base) || f.name.includes('__MACOSX')) return;
    let s: Sink | null = null; let resolveF: (x: File) => void; out.push(new Promise((r) => (resolveF = r)));
    chain = chain.then(async () => { s = await sink(dir, base); });
    f.ondata = (e, chunk, final) => {
      if (e) { err = e; return; }
      chain = chain.then(async () => { await s!.write(chunk); if (final) resolveF(await s!.close()); });
    };
    try { f.start(); } catch (e) { err = e; }
  });
  uz.register(UnzipInflate);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { uz.push(new Uint8Array(0), true); break; }
    got += value.length; tick();
    uz.push(value); await chain; if (err) throw new DownloadError('zip: ' + (err.message || err));
  }
  await chain; if (err) throw new DownloadError('zip: ' + (err.message || err));
  const files = await Promise.all(out);
  if (!files.length) throw new DownloadError('noImageInZip');
  return files;
}

/** downloads the disc image behind a link; returns the image files (in OPFS where possible) */
export async function downloadDisc(input: string, progress: DlProgress, signal?: AbortSignal): Promise<File[]> {
  let url = input.trim(); if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { throw new DownloadError('badUrl'); }
  await clearDownloads(); const dir = await tempDir();
  let parts: { res: Response; url: string }[];
  try { parts = await resolve(url, progress, signal); }
  catch (e) {
    // the desktop app can still let the player click through the page in a window
    if (isElectron && e instanceof DownloadError && (e.message === 'noLink' || /^HTTP 40[39]/.test(e.message))) parts = [await browseFor(url, progress, signal)];
    else throw e;
  }
  const files: File[] = [];
  for (let i = 0; i < parts.length; i++) files.push(...await save(parts[i].res, parts[i].url, dir, progress, parts.length > 1 ? `${i + 1}/${parts.length}` : ''));
  return files;
}

/** desktop app: open the page in a window and take over the download the player starts there */
async function browseFor(url: string, progress: DlProgress, signal?: AbortSignal) {
  progress('browse');
  const r = await fetch('/__browse?' + new URLSearchParams({ u: url }), { signal });
  if (r.status !== 200) throw new DownloadError(r.status === 499 ? 'cancelled' : await r.text());
  return { res: r, url: r.headers.get('x-final-url') || url };
}
