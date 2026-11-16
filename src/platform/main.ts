// UI thread: launcher, disc library (OPFS), renderer (WebGL2), audio, MIDI, input.
import { downloadDisc, clearDownloads, setDownloadProxy } from './download';
import { CTRL, CTRL_INTS, EV_BASE, EV_CAP, EV_SIZE, EVT, FRAME_MAX, CURSOR_MAX, WorkerMsg } from './proto';
import { STRINGS } from './i18n';
import { zipSync, unzipSync } from 'fflate';
import { WorkletSynthesizer, Sequencer } from 'spessasynth_lib';

import { hiLog, saveLog, logText } from './log';
import { loadCatalogue, buildActive, fileText, fileData, setEnabled, setSetting, catalogue, modState } from './mods';
import { renderMods } from './modsui';
import type { ActiveMod } from '../mods/types';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Lang = 'en' | 'de';

// ---------------- settings ----------------
const defaults = { scale: 'pixel', aspect: '4:3', video: 'hi', music: 70, sfx: 85, musicSrc: 'sf2', dlProxy: '', lang: '' as Lang | '', ui: (navigator.language || 'en').startsWith('de') ? 'de' : 'en' };
type Settings = typeof defaults;
const settings: Settings = { ...defaults, ...(() => { try { return JSON.parse(localStorage.getItem('hi.settings') || '{}'); } catch { return {}; } })() };
if (settings.scale !== 'fit' && settings.scale !== 'pixel') settings.scale = 'pixel'; // filters moved to mods
// 1.3: the picture is never scaled down any more by default; old installs had "fit" as default
if (!(settings as any).v || (settings as any).v < 2) { settings.scale = 'pixel'; (settings as any).v = 2; }
const saveSettings = () => { try { localStorage.setItem('hi.settings', JSON.stringify(settings)); } catch { /* ignore */ } };

const t = (k: string) => (STRINGS[settings.ui as 'en' | 'de'] as any)[k] ?? (STRINGS.en as any)[k] ?? k;
function applyI18n() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => { const v = t(el.dataset.i18n!); if (v) el.textContent = v; });
  $('uiLang').textContent = settings.ui === 'de' ? 'English' : 'Deutsch';
  $<HTMLInputElement>('urlInput').placeholder = t('urlPlaceholder');
  document.documentElement.lang = settings.ui;
}

// ---------------- disc library (OPFS with in-memory fallback) ----------------
interface DiscSet { lang: Lang; label: string; files: { name: string; file: File }[]; size: number; }
const library = new Map<Lang, DiscSet>();
let opfs: FileSystemDirectoryHandle | null = null;
async function opfsRoot() {
  if (opfs) return opfs;
  try { opfs = await navigator.storage.getDirectory(); await navigator.storage.persist?.(); } catch { opfs = null; }
  return opfs;
}
async function loadLibrary() {
  const root = await opfsRoot(); if (!root) return;
  try {
    const discs = await root.getDirectoryHandle('discs', { create: true });
    for (const lang of ['en', 'de'] as Lang[]) {
      let dir: FileSystemDirectoryHandle; try { dir = await discs.getDirectoryHandle(lang); } catch { continue; }
      const files: { name: string; file: File }[] = []; let size = 0; let label = '';
      for await (const [name, h] of (dir as any).entries()) {
        if (h.kind !== 'file') continue;
        if (name === 'label.txt') { label = await (await h.getFile()).text(); continue; }
        const f: File = await h.getFile(); files.push({ name, file: f }); size += f.size;
      }
      if (files.length) library.set(lang, { lang, label, files, size });
    }
  } catch (e) { console.warn('library load failed', e); }
}
async function storeDisc(set: DiscSet, progress: (p: number) => void) {
  const root = await opfsRoot(); if (!root) { library.set(set.lang, set); return; }
  const discs = await root.getDirectoryHandle('discs', { create: true });
  try { await discs.removeEntry(set.lang, { recursive: true }); } catch { /* none */ }
  const dir = await discs.getDirectoryHandle(set.lang, { create: true });
  let done = 0; const total = set.files.reduce((a, f) => a + f.file.size, 0) || 1;
  const stored: { name: string; file: File }[] = [];
  for (const f of set.files) {
    const src = (f.file as any).__handle;   // downloaded into OPFS already: move instead of copying
    if (src?.move) {
      try { await src.move(dir, f.name); stored.push({ name: f.name, file: await (await dir.getFileHandle(f.name)).getFile() }); done += f.file.size; progress(done / total); continue; }
      catch { /* copy below */ }
    }
    const h = await dir.getFileHandle(f.name, { create: true });
    const ws = await (h as any).createWritable();
    const reader = f.file.stream().getReader();
    for (;;) { const { done: d, value } = await reader.read(); if (d) break; await ws.write(value); done += value.length; progress(done / total); }
    await ws.close();
    stored.push({ name: f.name, file: await h.getFile() });
  }
  const lh = await dir.getFileHandle('label.txt', { create: true }); const lw = await (lh as any).createWritable(); await lw.write(set.label); await lw.close();
  library.set(set.lang, { ...set, files: stored });
}
async function removeDisc(lang: Lang) {
  const root = await opfsRoot();
  if (root) { try { const discs = await root.getDirectoryHandle('discs'); await discs.removeEntry(lang, { recursive: true }); } catch { /* */ } }
  library.delete(lang);
}
async function loadSaves(lang: Lang) {
  const out: { path: string; data: Uint8Array }[] = [];
  const root = await opfsRoot(); if (!root) return out;
  try {
    const saves = await root.getDirectoryHandle('saves', { create: true }); const dir = await saves.getDirectoryHandle(lang, { create: true });
    for await (const [name, h] of (dir as any).entries()) if (h.kind === 'file') out.push({ path: decodeURIComponent(name), data: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  } catch { /* */ }
  return out;
}
const persistQueue: Promise<void>[] = [];
// ---- desktop app: saves are mirrored to Documents/Project Sunburn/Saves/<lang> (see electron/main.cjs) ----
const isDesktop = location.protocol === 'app:';
const docSave = (lang: Lang, p: string) => `/__saves?lang=${lang}&path=${encodeURIComponent(p)}`;
async function mirrorSave(lang: Lang, path: string, data: Uint8Array | null) {
  if (!isDesktop) return;
  try { await fetch(docSave(lang, path), data ? { method: 'PUT', body: data as BodyInit } : { method: 'DELETE' }); } catch (e) { hiLog('warn', 'saves folder: ' + e); }
}
// before a game starts: saves that are newer in the Documents folder (restored by a backup tool,
// copied from another PC) come in; saves only in the app go out
async function syncSaveFolder(lang: Lang) {
  if (!isDesktop) return;
  try {
    const docs: { path: string; size: number; mtime: number }[] = await (await fetch(`/__saves?lang=${lang}`)).json();
    const mine = new Map((await loadSaveInfo(lang)).map((f) => [f.path.toUpperCase(), f]));
    let inN = 0, outN = 0;
    for (const d of docs) {
      const m = mine.get(d.path.toUpperCase());
      if (m && m.size === d.size && m.mtime >= d.mtime - 2000) continue;
      if (m && m.mtime > d.mtime) continue;
      const r = await fetch(docSave(lang, d.path)); if (!r.ok) continue;
      await persistSave(lang, m?.path || d.path, new Uint8Array(await r.arrayBuffer()), false); inN++;
    }
    const docNames = new Set(docs.map((d) => d.path.toUpperCase()));
    for (const f of await loadSaves(lang)) if (!docNames.has(f.path.toUpperCase())) { await mirrorSave(lang, f.path, f.data); outN++; }
    if (inN || outN) hiLog('info', `saves folder: ${inN} in, ${outN} out`);
  } catch (e) { hiLog('warn', 'saves folder sync failed: ' + e); }
}
async function loadSaveInfo(lang: Lang) {
  const out: { path: string; size: number; mtime: number }[] = [];
  const root = await opfsRoot(); if (!root) return out;
  try {
    const dir = await (await root.getDirectoryHandle('saves', { create: true })).getDirectoryHandle(lang, { create: true });
    for await (const [name, h] of (dir as any).entries()) if (h.kind === 'file') { const f: File = await h.getFile(); out.push({ path: decodeURIComponent(name), size: f.size, mtime: f.lastModified }); }
  } catch { /* */ }
  return out;
}
async function persistSave(lang: Lang, path: string, data: Uint8Array | null, mirror = true) {
  if (mirror) void mirrorSave(lang, path, data);
  // only persist user data, not the generated install
  const root = await opfsRoot(); if (!root) return;
  const saves = await root.getDirectoryHandle('saves', { create: true }); const dir = await saves.getDirectoryHandle(lang, { create: true });
  const name = encodeURIComponent(path);
  if (!data) { try { await dir.removeEntry(name); } catch { /* */ } return; }
  const h = await dir.getFileHandle(name, { create: true }); const ws = await (h as any).createWritable(); await ws.write(data); await ws.close();
}

// ---------------- probing (worker) ----------------
function probe(files: { name: string; file: File }[]): Promise<{ ok: boolean; lang?: Lang; label?: string; error?: string }> {
  return new Promise((res) => {
    const w = new Worker('worker.js'); w.onmessage = (e) => { if (e.data.t === 'probe') { w.terminate(); res(e.data); } };
    w.onerror = (e) => { w.terminate(); res({ ok: false, error: e.message }); };
    w.postMessage({ t: 'probe', files });
  });
}
function groupFiles(fl: File[]): { name: string; file: File }[][] {
  // group into disc sets by base name
  const files = fl.map(f => ({ name: f.name, file: f }));
  const sets: { name: string; file: File }[][] = [];
  const used = new Set<string>();
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.mds')) { const base = n.slice(0, -4); const mdf = files.find(x => x.name.toLowerCase() === base + '.mdf'); const s = [f]; used.add(f.name); if (mdf) { s.push(mdf); used.add(mdf.name); } sets.push(s); }
    else if (n.endsWith('.cue')) {
      const s = [f]; used.add(f.name);
      for (const b of files) if (/\.(bin|img)$/i.test(b.name) && !used.has(b.name)) { s.push(b); used.add(b.name); }
      sets.push(s);
    }
  }
  for (const f of files) if (!used.has(f.name) && /\.(iso|img|bin)$/i.test(f.name)) { sets.push([f]); used.add(f.name); }
  for (const f of files) if (!used.has(f.name) && f.name.toLowerCase().endsWith('.mdf')) { sets.push([f]); used.add(f.name); }
  return sets;
}
async function importFiles(fl: File[]) {
  const st = $('importStatus'); st.hidden = false; st.className = 'status';
  const sets = groupFiles(fl);
  if (!sets.length) { st.className = 'status err'; st.textContent = t('noImage'); return; }
  for (const s of sets) {
    st.textContent = t('checking') + ' ' + s.map(x => x.name).join(' + ');
    const r = await probe(s);
    if (!r.ok || !r.lang) { st.className = 'status err'; st.textContent = `${s[0].name}: ${r.error || t('notHI')}`; continue; }
    st.innerHTML = `${t('importing')} <b>${r.lang === 'de' ? 'Deutsch' : 'English'}</b>…<div class="progress"><i></i></div>`;
    const bar = st.querySelector('i') as HTMLElement;
    try {
      await storeDisc({ lang: r.lang, label: r.label || '', files: s, size: s.reduce((a, f) => a + f.file.size, 0) }, (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; });
      st.textContent = `✓ ${r.lang === 'de' ? 'Deutsch' : 'English'} ${t('added')}`;
      settings.lang = r.lang; saveSettings();
    } catch (e: any) {
      library.set(r.lang, { lang: r.lang, label: r.label || '', files: s, size: 0 });
      st.className = 'status err'; st.textContent = t('storeFailed') + ' ' + (e?.message || e);
    }
  }
  renderLibrary();
}

// ---------------- savegame export / import ----------------
// Saves are the game's own files (HOLIDAY\MAPS\*.MAP, ...), the same format in the English and the
// German release and in the original game. A zip moves them between versions, devices, the web and the
// desktop app, or to a real Windows 3.1 install.
// the saved islands (MAPS\*.MAP): date, player, rename, delete, download one
async function manageSaves(lang: Lang) {
  const files = (await loadSaves(lang)).filter((f) => /(^|\\)MAPS\\[^\\]+\.MAP$/i.test(f.path));
  const info = new Map((await loadSaveInfo(lang)).map((f) => [f.path, f]));
  const box = document.createElement('div'); box.className = 'savelist';
  const player = (d: Uint8Array) => { const n = d[0x46]; if (!n || n > 30) return ''; let s = ''; for (let i = 0; i < n; i++) { const c = d[0x47 + i]; if (c < 32) return ''; s += String.fromCharCode(c); } return s; };
  const close = () => { $('modal').hidden = true; };
  if (!files.length) box.textContent = t('savesNone');
  files.sort((a, b) => (info.get(b.path)?.mtime || 0) - (info.get(a.path)?.mtime || 0));
  for (const f of files) {
    const name = f.path.replace(/^.*\\/, '').replace(/\.MAP$/i, ''); const folder = f.path.slice(0, f.path.length - name.length - 4);
    const when = info.get(f.path)?.mtime ? new Date(info.get(f.path)!.mtime).toLocaleString(settings.ui === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const row = document.createElement('div'); row.className = 'saverow';
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = `<b></b><span></span>`; meta.querySelector('b')!.textContent = name; meta.querySelector('span')!.textContent = [player(f.data), when, `${Math.round(f.data.length / 1024)} KB`].filter(Boolean).join(' · ');
    const btn = (label: string, fn: () => void, cls = 'btn ghost small') => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; return b; };
    row.append(meta,
      btn(t('savesDownload'), () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([f.data as BlobPart])); a.download = name + '.MAP'; document.body.append(a); a.click(); a.remove(); }),
      btn(t('savesRename'), async () => {
        const nn = (prompt(t('savesRenameQ'), name) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 8);
        if (!nn || nn === name.toUpperCase()) return;
        if (files.some((x) => x.path.toUpperCase() === `${folder}${nn}.MAP`.toUpperCase()) && !confirm(t('savesReplaceQ'))) return;
        await persistSave(lang, `${folder}${nn}.MAP`, f.data); await persistSave(lang, f.path, null); close(); void manageSaves(lang);
      }),
      btn(t('remove'), async () => { if (!confirm(t('savesDeleteQ').replace('{n}', name))) return; await persistSave(lang, f.path, null); row.remove(); }, 'btn danger small'));
    box.appendChild(row);
  }
  const p = showModal(t('savesTitle'), '', 0);
  $('modalText').appendChild(box);
  await p;
}
async function exportSaves(lang: Lang) {
  const files = await loadSaves(lang);
  if (!files.length) { await showModal(t('savesTitle'), t('savesNone'), 0); return; }
  const z: Record<string, Uint8Array> = {};
  for (const f of files) z[f.path.replace(/\\/g, '/')] = f.data;
  const blob = new Blob([zipSync(z, { level: 6 }) as BlobPart], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `ProjectSunburn-saves-${lang}-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  hiLog('info', `exported ${files.length} save files (${lang})`);
}
async function importSaves(lang: Lang, picked: File[]) {
  const out: { path: string; data: Uint8Array }[] = [];
  const add = (p: string, d: Uint8Array) => {
    const parts = p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..');
    if (!parts.length) return;
    const name = parts[parts.length - 1].toUpperCase();
    if (/\.MAP$/.test(name) && !/^HOLIDAY$/i.test(parts[0])) { out.push({ path: 'HOLIDAY\\MAPS\\' + name, data: d }); return; }  // loose savegame
    if (/^HOLIDAY$/i.test(parts[0])) out.push({ path: parts.map((x) => x.toUpperCase()).join('\\'), data: d });
  };
  for (const f of picked) {
    const d = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) { for (const [p, v] of Object.entries(unzipSync(d))) if (!p.endsWith('/')) add(p, v); }
    else add(f.name, d);
  }
  if (!out.length) { await showModal(t('savesTitle'), t('savesNoneFound'), 0); return; }
  for (const f of out) await persistSave(lang, f.path, f.data);
  hiLog('info', `imported ${out.length} save files into ${lang}: ${out.map((f) => f.path).join(', ')}`);
  await showModal(t('savesTitle'), t('savesImported').replace('{n}', String(out.length)).replace('{v}', lang === 'de' ? t('verDe') : t('verEn')), 0);
}

// ---------------- download from a link ----------------
let dlAbort: AbortController | null = null;
async function importUrl(url: string) {
  const st = $('importStatus'); st.hidden = false; st.className = 'status';
  const go = $<HTMLButtonElement>('urlGo');
  if (dlAbort) { dlAbort.abort(); return; }
  dlAbort = new AbortController(); go.textContent = t('urlCancel');
  st.innerHTML = `<span></span><div class="progress"><i></i></div>`;
  const txt = st.querySelector('span')!, bar = st.querySelector('i') as HTMLElement, pb = st.querySelector('.progress') as HTMLElement;
  hiLog('info', `download from ${url}`);
  try {
    const files = await downloadDisc(url, (s, p) => {
      if (s === 'browse') { txt.textContent = t('dlBrowse'); pb.hidden = true; return; }
      pb.hidden = false;
      txt.textContent = s.startsWith('…') ? `${t('dlResolving')} ${s}` : `${t('dlDownloading')} ${s}`;
      bar.style.width = p === undefined ? '100%' : (p * 100).toFixed(1) + '%'; bar.classList.toggle('indet', p === undefined);
    }, dlAbort.signal);
    hiLog('info', `downloaded ${files.map((f) => `${f.name} (${f.size})`).join(', ')}`);
    await importFiles(files);
  } catch (e: any) {
    st.className = 'status err';
    const m = String(e?.message || e);
    hiLog('warn', `download failed: ${m}`);
    if (e?.name === 'AbortError' || m === 'cancelled') st.textContent = t('dlCancelled');
    else if (m === 'blocked') { st.textContent = t('dlBlocked'); const b = document.createElement('a'); b.className = 'btn secondary'; b.href = e.page || url; b.target = '_blank'; b.rel = 'noopener'; b.textContent = t('dlOpenPage'); st.append(document.createElement('br'), b); }
    else if (m === 'proxy') st.textContent = t('dlProxyFail');
    else if (m === 'noLink') st.textContent = t('dlNoLink');
    else if (m === 'noImage' || m === 'noImageInZip') st.textContent = t('dlNoImage');
    else if (m === 'badUrl') st.textContent = t('dlBadUrl');
    else if (m.startsWith('archiveFormat:')) st.textContent = '.' + m.slice(14) + ' ' + t('dlArchive');
    else st.textContent = `${t('dlFailed')} ${m}`;
  } finally {
    dlAbort = null; go.textContent = t('urlGo');
    void clearDownloads();
  }
}

function renderLibrary() {
  const list = $('discList'); list.innerHTML = '';
  for (const lang of ['en', 'de'] as Lang[]) {
    const d = library.get(lang); if (!d) continue;
    const el = document.createElement('div'); el.className = 'disc';
    el.innerHTML = `<div class="flag">${lang === 'de' ? '🇩🇪' : '🇬🇧'}</div><div class="meta"><b>${lang === 'de' ? 'Holiday Island (Deutsch)' : 'Holiday Island (English)'}</b><span>${d.files.map(f => f.name).join(', ')} · ${(d.size / 1048576).toFixed(0)} MB</span></div>`;
    const ex = document.createElement('button'); ex.className = 'btn ghost small'; ex.textContent = t('savesExport'); ex.title = t('savesHelp');
    ex.onclick = () => void exportSaves(lang);
    const im = document.createElement('label'); im.className = 'btn ghost small'; im.title = t('savesHelp');
    const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.zip,.map,.MAP'; inp.hidden = true;
    inp.onchange = () => { if (inp.files?.length) void importSaves(lang, [...inp.files]); inp.value = ''; };
    im.append(inp, document.createTextNode(t('savesImport')));
    const mg = document.createElement('button'); mg.className = 'btn ghost small'; mg.textContent = t('savesManage');
    mg.onclick = () => void manageSaves(lang);
    el.append(mg, ex, im);
    const rm = document.createElement('button'); rm.className = 'btn danger'; rm.textContent = t('remove');
    rm.onclick = async () => { if (confirm(t('removeConfirm'))) { await removeDisc(lang); renderLibrary(); } };
    el.appendChild(rm); list.appendChild(el);
  }
  const seg = $('langSeg'); seg.innerHTML = '';
  if (!settings.lang || !library.has(settings.lang as Lang)) settings.lang = library.has('en') ? 'en' : library.has('de') ? 'de' : '';
  for (const lang of ['en', 'de'] as Lang[]) {
    const b = document.createElement('button'); b.textContent = lang === 'de' ? 'Deutsch' : 'English';
    b.disabled = !library.has(lang); b.className = settings.lang === lang ? 'on' : '';
    b.onclick = () => { settings.lang = lang; saveSettings(); renderLibrary(); };
    seg.appendChild(b);
  }
  ($('playBtn') as HTMLButtonElement).disabled = !settings.lang;
  renderMods();
  void updateBackdrop();
}

// draw the game's own title picture (from the player's disc) behind the launcher
let backdropLang = '';
async function updateBackdrop() {
  const lang = settings.lang as Lang; const d = lang && library.get(lang);
  if (!d || backdropLang === lang) return; backdropLang = lang;
  const w = new Worker('worker.js');
  w.onmessage = (e) => {
    if (e.data.t !== 'title') return; w.terminate();
    const { rgba, width, height } = e.data; if (!rgba) return;
    const c = $('backdrop') as HTMLCanvasElement; c.width = width; c.height = height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), 0, 0);
  };
  w.postMessage({ t: 'title', files: d.files });
}

// ---------------- audio ----------------
class AudioEngine {
  ctx: AudioContext; master: GainNode; sfx: GainNode; music: GainNode; midiGain: GainNode; gameSfx: GainNode;
  buffers = new Map<number, AudioBuffer>(); chans = new Map<number, AudioBufferSourceNode>();
  synth: WorkletSynthesizer | null = null; seq: Sequencer | null = null; synthReady: Promise<void> | null = null;
  cdBuffers = new Map<number, AudioBuffer>(); cdSrc: AudioBufferSourceNode | null = null;
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain(); this.sfx.connect(this.master);
    this.gameSfx = this.ctx.createGain(); this.gameSfx.connect(this.sfx);
    this.music = this.ctx.createGain(); this.music.connect(this.master);
    this.midiGain = this.ctx.createGain(); this.midiGain.connect(this.music);
    this.applyVolumes();
  }
  applyVolumes() { this.sfx.gain.value = (settings.sfx / 100) ** 1.5; this.music.gain.value = (settings.music / 100) ** 1.5; }
  async initSynth(onStatus: (s: string) => void, custom?: Uint8Array | null) {
    if (settings.musicSrc !== 'sf2') return;
    this.synthReady = (async () => {
      onStatus(t('loadingSf'));
      await this.ctx.audioWorklet.addModule('spessasynth_processor.min.js');
      const sf = custom ? custom.slice().buffer : await (await fetch('soundfont/GeneralUser-GS.sf2')).arrayBuffer();
      this.synth = new WorkletSynthesizer(this.ctx);
      this.synth.connect(this.midiGain);
      await this.synth.soundBankManager.addSoundBank(sf, 'main');
      await this.synth.isReady;
      this.seq = new Sequencer(this.synth);
      this.seq.loopCount = 0;
    })().catch((e) => { console.error('synth init failed', e); this.synth = null; });
    return this.synthReady;
  }
  pcm(id: number, data: Float32Array, rate: number) {
    const b = this.ctx.createBuffer(1, Math.max(1, data.length), rate); b.copyToChannel(data as Float32Array<ArrayBuffer>, 0); this.buffers.set(id, b);
  }
  play(ch: number, id: number, loop: boolean, vol: number) {
    this.stop(ch); const b = this.buffers.get(id); if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.loop = loop;
    const g = this.ctx.createGain(); g.gain.value = vol; s.connect(g); g.connect(this.gameSfx);
    s.onended = () => { if (this.chans.get(ch) === s) this.chans.delete(ch); };
    s.start(); this.chans.set(ch, s);
  }
  stop(ch: number) { const s = this.chans.get(ch); if (s) { try { s.stop(); } catch { /* */ } this.chans.delete(ch); } }
  async midi(op: string, data?: Uint8Array, v?: number) {
    if (op === 'vol') { this.midiGain.gain.value = Math.max(0, Math.min(1, v ?? 1)); return; }
    if (this.synthReady) await this.synthReady;
    if (!this.seq || !this.synth) return;
    switch (op) {
      case 'play': this.seq.loadNewSongList([{ binary: data!.slice().buffer, fileName: 'song.mid' } as any]); this.seq.loopCount = 0; this.seq.play(); break;
      case 'stop': this.seq.pause(); this.synth.stopAll(true); break;
      case 'pause': this.seq.pause(); break;
      case 'resume': this.seq.play(); break;
      case 'vol': this.midiGain.gain.value = Math.max(0, Math.min(1, v ?? 1)); break;
    }
  }
  cdTrack(idx: number, pcm: Int16Array) {
    const n = pcm.length / 2; const b = this.ctx.createBuffer(2, n, 44100);
    const l = b.getChannelData(0), r = b.getChannelData(1);
    for (let i = 0; i < n; i++) { l[i] = pcm[i * 2] / 32768; r[i] = pcm[i * 2 + 1] / 32768; }
    this.cdBuffers.set(idx, b);
  }
  cdPlay(idx: number, offsetMs: number, durMs: number) {
    this.cdStop(); const b = this.cdBuffers.get(idx); if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.music); s.start(0, offsetMs / 1000, durMs / 1000); this.cdSrc = s;
  }
  cdStop() { if (this.cdSrc) { try { this.cdSrc.stop(); } catch { /* */ } this.cdSrc = null; } }
  stopAll() { for (const ch of [...this.chans.keys()]) this.stop(ch); this.cdStop(); try { this.seq?.pause(); this.synth?.stopAll(true); } catch { /* */ } }
}

// ---------------- renderer ----------------
const VS = `#version 300 es
in vec2 p; out vec2 uv; uniform vec4 rect; // x,y,w,h in clip space
void main(){ uv = vec2(p.x, 1.0-p.y); gl_Position = vec4(rect.x + p.x*rect.z, rect.y + p.y*rect.w, 0., 1.); }`;
// Vanilla output is plain nearest-neighbour. A screen-filter mod supplies
//   vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize)
// and gets its numeric settings as uniforms named u_<key>.
const fsSource = (filter: string | null) => `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D tex; uniform vec2 texSize; uniform vec2 outSize; uniform int mode;
${filter ? '#line 1\n' + filter.replace(/\bfilter(\s*\()/g, 'modFilter$1') : ''}
void main(){ ${filter ? 'if (mode == 2) o = texture(tex, uv); else o = modFilter(tex, uv, texSize, outSize);' : 'o = texture(tex, uv);'} }`;
class Renderer {
  gl: WebGL2RenderingContext; prog: WebGLProgram; copy: WebGLProgram; tex: WebGLTexture; ctex: WebGLTexture; buf = new Uint8Array(0);
  w = 640; h = 480; vp = { x: 0, y: 0, w: 640, h: 480, scale: 1 };
  cursor = { w: 0, h: 0, hx: 0, hy: 0, vis: true };
  filterUniforms: Record<string, number> = {}; hasFilter = false; filterName = '';
  // the filtered picture is cached in a framebuffer and only re-rendered when the game image changes
  private fbo: WebGLFramebuffer | null = null; private fboTex: WebGLTexture | null = null; private fboW = 0; private fboH = 0; private dirty = true;
  stats = { draws: 0, filterRuns: 0, filterMs: 0, uploads: 0 };
  constructor(public canvas: HTMLCanvasElement, filter: { src: string; uniforms: Record<string, number>; name: string } | null = null) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, desynchronized: true, preserveDrawingBuffer: false })!;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
    const link = (fs: string) => { const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link'); return p; };
    this.copy = link(fsSource(null));
    let p = this.copy;
    if (filter) {
      try { p = link(fsSource(filter.src)); this.hasFilter = true; this.filterUniforms = filter.uniforms; this.filterName = filter.name; }
      catch (e) { hiLog('error', `screen filter of mod "${filter.name}" failed to compile: ${e}`); }
    }
    this.prog = p;
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of new Set([this.copy, this.prog])) { const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    const mk = () => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    this.tex = mk(); this.ctex = mk();
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    hiLog('info', `WebGL: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}; filter: ${this.hasFilter ? this.filterName : 'none'}`);
  }
  // visible part of the game screen in game pixels (smaller than the screen when the window is too small)
  visible = { x: 0, y: 0, w: 640, h: 480 };
  resize() {
    const dpr = window.devicePixelRatio || 1; const c = this.canvas;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this.dirty = true; }
    let vw: number, vh: number;
    if (settings.scale === 'fit' && settings.aspect === 'stretch') { vw = W; vh = H; }
    else if (settings.scale === 'fit') {
      const s = Math.min(W / this.w, H / this.h);
      vw = Math.round(this.w * s); vh = Math.round(this.h * s);
    } else {
      // pixel exact: whole multiples only and never smaller than the natural size (one game pixel per
      // CSS pixel, rounded to whole device pixels). A window that is too small shows the middle of
      // the screen instead of shrinking the picture - resizing changes how much you see, not its size.
      const s = Math.max(Math.round(dpr), Math.floor(Math.min(W / this.w, H / this.h)), 1);
      vw = this.w * s; vh = this.h * s;
    }
    const vp = { x: Math.floor((W - vw) / 2), y: Math.floor((H - vh) / 2), w: vw, h: vh, scale: vw / this.w };
    if (vp.x !== this.vp.x || vp.y !== this.vp.y || vp.w !== this.vp.w || vp.h !== this.vp.h) this.dirty = true;
    this.vp = vp;
    const sx = vw / this.w, sy = vh / this.h;
    const l = Math.max(0, Math.ceil(-vp.x / sx)), t = Math.max(0, Math.ceil(-vp.y / sy));
    const r = Math.min(this.w, Math.floor((W - vp.x) / sx)), b = Math.min(this.h, Math.floor((H - vp.y) / sy));
    this.visible = { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
  }
  upload(src: Uint8Array, w: number, h: number) {
    const gl = this.gl; const n = w * h * 4; this.stats.uploads++;
    if (this.buf.length !== n) this.buf = new Uint8Array(n);
    this.buf.set(src.subarray(0, n));
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (w !== this.w || h !== this.h || !(this as any).allocated) { this.w = w; this.h = h; (this as any).allocated = true; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.buf); this.resize(); }
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    this.dirty = true;
  }
  uploadCursor(src: Uint8Array, w: number, h: number, hx: number, hy: number) {
    const gl = this.gl; const tmp = new Uint8Array(64 * 64 * 4); tmp.set(src.subarray(0, 64 * 64 * 4));
    gl.bindTexture(gl.TEXTURE_2D, this.ctex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.cursor = { w, h, hx, hy, vis: true };
  }
  private quad(prog: WebGLProgram, tex: WebGLTexture, filt: number, x: number, y: number, w: number, h: number, outW: number, outH: number, texW: number, texH: number, mode: number, flipY = false) {
    const gl = this.gl; gl.useProgram(prog);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    // flipY: framebuffer textures are stored bottom-up
    const r = [x / outW * 2 - 1, 1 - (y + h) / outH * 2, w / outW * 2, h / outH * 2];
    if (flipY) { r[1] = 1 - y / outH * 2; r[3] = -r[3]; }
    gl.uniform4fv(U('rect'), r); gl.uniform2f(U('texSize'), texW, texH); gl.uniform2f(U('outSize'), w, h); gl.uniform1i(U('mode'), mode);
    if (prog === this.prog && this.hasFilter) for (const k in this.filterUniforms) gl.uniform1f(U(k), this.filterUniforms[k]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  draw(mx: number, my: number, showCursor: boolean) {
    const gl = this.gl; const c = this.canvas; this.resize(); this.stats.draws++;
    const v = this.vp;
    if (this.hasFilter) {
      if (this.fboW !== c.width || this.fboH !== c.height || !this.fbo) {
        if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); }
        this.fboTex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.fbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        this.fboW = c.width; this.fboH = c.height; this.dirty = true;
      }
      if (this.dirty) {
        const t0 = performance.now();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, c.width, c.height);
        gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        this.quad(this.prog, this.tex, gl.LINEAR, v.x, v.y, v.w, v.h, c.width, c.height, this.w, this.h, 1);
        gl.enable(gl.BLEND); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.dirty = false; this.stats.filterRuns++; this.stats.filterMs += performance.now() - t0;
      }
      gl.viewport(0, 0, c.width, c.height);
      this.quad(this.copy, this.fboTex!, gl.NEAREST, 0, 0, c.width, c.height, c.width, c.height, c.width, c.height, 2, true);
    } else {
      gl.viewport(0, 0, c.width, c.height); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.quad(this.copy, this.tex, gl.NEAREST, v.x, v.y, v.w, v.h, c.width, c.height, this.w, this.h, 2);
    }
    if (showCursor && this.cursor.w) {
      // separate x/y scale: with "fill window" the picture is stretched unevenly
      const sx = v.w / this.w, sy = v.h / this.h; const cx = v.x + (mx - this.cursor.hx) * sx, cy = v.y + (my - this.cursor.hy) * sy;
      this.quad(this.copy, this.ctex, gl.NEAREST, cx, cy, 64 * sx, 64 * sy, c.width, c.height, 64, 64, 2);
    }
  }
  toGame(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const x = ((clientX - r.left) * dpr - this.vp.x) / (this.vp.w / this.w), y = ((clientY - r.top) * dpr - this.vp.y) / (this.vp.h / this.h);
    const v = this.visible;
    return [Math.max(v.x, Math.min(v.x + v.w - 1, Math.floor(x))), Math.max(v.y, Math.min(v.y + v.h - 1, Math.floor(y)))];
  }
}

// ---------------- keyboard map ----------------
const VK: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226 };
function vkOf(e: KeyboardEvent): number {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(c)) return 96 + (c.charCodeAt(6) - 48);
  if (/^F([1-9]|1[0-2])$/.test(c)) return 111 + parseInt(c.slice(1));
  return VK[c] ?? 0;
}
function charOf(e: KeyboardEvent): number {
  if (e.key.length === 1) { const c = e.key.charCodeAt(0); return c < 256 ? c : 0; }
  return ({ Enter: 13, Backspace: 8, Escape: 27, Tab: 9 } as Record<string, number>)[e.key] ?? 0;
}

// ---------------- game session ----------------
// Desktop size for mods that size the game's desktop to the player's screen: as big as the window can
// get (the whole monitor), in game pixels at the natural scale. A smaller window shows part of it.
function hostSize() {
  // devicePixelRatio includes the browser zoom, screen.* does not; innerWidth is in zoomed CSS pixels.
  // Estimate the zoom from outer/inner width (snapped to the browser's zoom steps) to get the monitor
  // size in device pixels.
  const dpr = window.devicePixelRatio || 1, k = Math.max(1, Math.round(dpr));
  const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const ratio = window.outerWidth && window.innerWidth ? window.outerWidth / window.innerWidth : 1;
  const zoom = steps.reduce((a, b) => Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a, 1);
  const sys = dpr / zoom; // OS scaling
  const w = Math.max((screen.width || 0) * sys, window.innerWidth * dpr), h = Math.max((screen.height || 0) * sys, window.innerHeight * dpr);
  hiLog('info', `host size: screen ${screen.width}x${screen.height}, window ${window.innerWidth}x${window.innerHeight}, dpr ${dpr.toFixed(2)}, zoom ~${zoom}`);
  return { w: Math.round(w / k), h: Math.round(h / k) };
}
let session: { stop: () => void } | null = null;
async function startGame() {
  const lang = settings.lang as Lang; const disc = library.get(lang); if (!disc) return;
  $('launcher').hidden = true; $('backdrop').hidden = true; const game = $('game'); game.hidden = false;
  const loading = $('loading'); loading.hidden = false; $('loadingText').textContent = t('starting');
  const canvas = $<HTMLCanvasElement>('screen');
  if (!crossOriginIsolated) { showModal(t('errTitle'), t('noIsolation'), 0).then(() => location.reload()); return; }
  let mods: ActiveMod[] = [];
  try { mods = await buildActive(lang); } catch (e) { hiLog('error', 'loading mods failed', e); }
  hiLog('info', `start: disc ${lang}, settings ${JSON.stringify(settings)}, canvas ${canvas.clientWidth}x${canvas.clientHeight} @${devicePixelRatio}`);
  for (const m of mods) hiLog('info', `mod ${m.manifest.id} ${m.manifest.version || ''} ${JSON.stringify(m.settings)}`);
  // "shader" may name its file through settings: "{style}.glsl" with the setting style = "crt" -> crt.glsl
  const shaderFile = (m: ActiveMod) => m.manifest.shader?.replace(/\{(\w+)\}/g, (_, k) => String(m.settings[k] ?? ''));
  const shaderMod = [...mods].reverse().find((m) => m.manifest.shader && fileText(m, shaderFile(m)!));
  const filter = shaderMod ? { name: `${shaderMod.manifest.id}:${shaderFile(shaderMod)}`, src: fileText(shaderMod, shaderFile(shaderMod)!)!, uniforms: Object.fromEntries((shaderMod.manifest.settings || []).filter((x) => x.type !== 'text' && x.type !== 'file').map((x) => ['u_' + x.key, Number(typeof shaderMod.settings[x.key] === 'boolean' ? +shaderMod.settings[x.key] : shaderMod.settings[x.key]) || 0])) } : null;
  let customSf: Uint8Array | null = null;
  for (const m of mods) { const d = (m.manifest.soundfont && fileData(m, m.manifest.soundfont)) || m.files.find((f) => f.path.startsWith('@setting/') && /\.sf[23]$/i.test(String(m.settings[f.path.slice(9)])))?.data; if (d) customSf = d; }
  let renderer: Renderer;
  try { renderer = new Renderer(canvas, filter); (window as any).__hi.renderer = renderer; } catch (e: any) { await showModal(t('errTitle'), String(e.message), 0); backToLauncher(); return; }
  const audio = new AudioEngine(); await audio.ctx.resume(); (window as any).__hi.audio = audio;
  const synthP = audio.initSynth((s) => { $('loadingText').textContent = s; }, customSf);
  const ctrlSab = new SharedArrayBuffer(CTRL_INTS * 4), frameSab = new SharedArrayBuffer(FRAME_MAX), cursorSab = new SharedArrayBuffer(CURSOR_MAX);
  const ctrl = new Int32Array(ctrlSab), frame = new Uint8Array(frameSab), cursorBuf = new Uint8Array(cursorSab);
  await syncSaveFolder(lang);
  const saves = await loadSaves(lang);
  await synthP;
  $('loadingText').textContent = t('starting');
  const worker = new Worker('worker.js');
  let apiNames: string[] = [];
  let alive = true; let mx = 0, my = 0; let lastFrame = 0, lastCursor = 0; let lastMove = performance.now();
  const pushEv = (type: number, x = 0, y = 0, b = 0, vk = 0, ch = 0) => {
    const wpos = Atomics.load(ctrl, CTRL.EVWRITE); const o = EV_BASE + (wpos % EV_CAP) * EV_SIZE;
    ctrl[o] = type; ctrl[o + 1] = x; ctrl[o + 2] = y; ctrl[o + 3] = b; ctrl[o + 4] = vk; ctrl[o + 5] = ch;
    Atomics.store(ctrl, CTRL.EVWRITE, (wpos + 1) | 0); Atomics.add(ctrl, CTRL.EVSEQ, 1); Atomics.notify(ctrl, CTRL.EVSEQ);
  };
  const cdTimeline: number[] = []; // ms start of each audio track index
  let cdTracks: { num: number; audio: boolean; sectors: number }[] = [];
  worker.onmessage = async (e: MessageEvent<WorkerMsg | any>) => {
    const m = e.data;
    switch (m.t) {
      case 'ready': loading.hidden = true; cdTracks = m.tracks; canvas.focus(); if (matchMedia('(pointer: coarse)').matches) toast(t('touchHelp')); break;
      case 'pcm': audio.pcm(m.id, m.data, m.rate); break;
      case 'play': audio.play(m.ch, m.id, m.loop, m.vol); break;
      case 'stop': audio.stop(m.ch); break;
      case 'mastervol': audio.gameSfx.gain.value = Math.max(0, Math.min(1, m.v)); break;
      case 'midi': void audio.midi(m.op, m.data, m.v); break;
      case 'cdtrack': audio.cdTrack(m.idx, m.pcm); break;
      case 'cd': if (m.op === 'play') audio.cdPlay(m.idx, m.offset, m.dur); else audio.cdStop(); break;
      case 'msgbox': { hiLog('game', `message box "${m.caption}": ${m.text}`); const r = await showModal(m.caption, m.text, m.type); Atomics.store(ctrl, CTRL.MSGBOX, r); Atomics.notify(ctrl, CTRL.MSGBOX); break; }
      case 'apinames': apiNames = m.names; break;
      case 'persist': persistQueue.push(persistSave(lang, m.path, m.data).catch(() => {})); break;
      case 'title': document.title = (m.s || 'Holiday Island') + ' – Project Sunburn'; break;
      case 'log': hiLog(m.level || 'game', m.s); break;
      case 'modstatus': uiMods.forEach((u) => { if (u.id === m.data.mod) u.message?.(m.data.data); }); break;
      case 'exit': stop(); break;
      case 'crash': hiLog('error', 'CRASH', m.msg, m.detail); await showModal(t('crashTitle'), `${m.msg}\n\n${m.detail.split('\n').slice(0, 3).join('\n')}`, 0); stop(); break;
    }
  };
  void cdTimeline; void cdTracks;
  worker.postMessage({ t: 'start', ctrlSab, frameSab, cursorSab, files: disc.files, saves, videoHi: settings.video !== 'lo', soundHi: true, screenW: 640, screenH: 480, mods, host: hostSize(), debugInput: !!(window as any).__hiDebugInput });

  // input
  let inside = false;
  const onMove = (e: PointerEvent) => { if (e.pointerType === 'touch') return onTouch(e, 'move'); [mx, my] = renderer.toGame(e.clientX, e.clientY); inside = true; lastMove = performance.now(); if (mouseHook('move', mx, my, 0)) return; pushEv(EVT.mousemove, mx, my); };
  const onLeave = () => { inside = false; };
  // UI-thread mod scripts (ui.js)
  const timers: number[] = []; const wheelHooks: ((dy: number, dx: number, shift: boolean) => boolean)[] = [];
  const mouseHooks: ((type: 'down' | 'move' | 'up', x: number, y: number, button: number) => boolean | void)[] = [];
  const keyHooks: ((e: KeyboardEvent) => boolean | void)[] = [];
  const mouseHook = (type: 'down' | 'move' | 'up', x: number, y: number, b: number) => { let handled = false; for (const h of mouseHooks) { try { if (h(type, x, y, b)) handled = true; } catch (err) { console.error(err); } } return handled; };
  const uiMods: { id: string; message?: (d: any) => void }[] = [];
  for (const m of mods) {
    const src = m.manifest.ui && fileText(m, m.manifest.ui); if (!src) continue;
    const handle: { id: string; message?: (d: any) => void } = { id: m.manifest.id };
    const api = {
      id: m.manifest.id, lang, settings: m.settings,
      log: (...a: any[]) => console.log(`[${m.manifest.id}]`, ...a),
      onWheel: (fn: (dy: number, dx: number, shift: boolean) => boolean) => { wheelHooks.push(fn); },
      onMouse: (fn: (type: 'down' | 'move' | 'up', x: number, y: number, button: number) => boolean | void) => { mouseHooks.push(fn); },
      tapKey: (vk: number) => { pushEv(EVT.keydown, 0, 0, 0, vk, 0); pushEv(EVT.keyup, 0, 0, 0, vk, 0); },
      key: (vk: number, down: boolean) => pushEv(down ? EVT.keydown : EVT.keyup, 0, 0, 0, vk, 0),
      // pointer control for gamepad/touch helpers: move the game cursor, press/release buttons
      moveTo: (x: number, y: number) => { mx = Math.max(0, Math.min(renderer.w - 1, Math.round(x))); my = Math.max(0, Math.min(renderer.h - 1, Math.round(y))); inside = true; pushEv(EVT.mousemove, mx, my); },
      button: (button: number, down: boolean) => pushEv(down ? EVT.mousedown : EVT.mouseup, mx, my, button),
      openMenu: () => { if ($('drawer').hidden) openDrawer(audio); else $('drawerClose').click(); },
      toggleFullscreen: () => toggleFullscreen(),
      menuOpen: () => !$('drawer').hidden || !$('modal').hidden,
      click: (x: number, y: number, button = 0) => { pushEv(EVT.mousemove, x, y); pushEv(EVT.mousedown, x, y, button); pushEv(EVT.mouseup, x, y, button); pushEv(EVT.mousemove, mx, my); },
      every: (ms: number, fn: () => void) => { timers.push(window.setInterval(() => { try { fn(); } catch (e) { console.error(e); } }, Math.max(16, ms))); },
      mouse: () => ({ x: mx, y: my, inside }),
      screen: () => ({ w: renderer.w, h: renderer.h }),
      visible: () => ({ ...renderer.visible }),
      file: (p: string) => fileData(m, p), text: (p: string) => fileText(m, p),
      onMessage: (fn: (d: any) => void) => { handle.message = fn; },
      // a command for this mod's script.js (api.onCommand there): two whole numbers
      command: (cmd: number, arg = 0) => pushEv(EVT.modcmd, mods.indexOf(m), cmd | 0, arg | 0),
      // see keys before the game; return true to keep a key from the game
      onKey: (fn: (e: KeyboardEvent) => boolean | void) => { keyHooks.push(fn); },
      overlay: () => { const d = document.createElement('div'); d.className = 'mod-overlay'; game.appendChild(d); return d; },
    };
    try { new Function('api', src)(api); uiMods.push(handle); } catch (e) { console.error(`ui script of mod "${m.manifest.id}" failed:`, e); }
  }
  const onWheel = (e: WheelEvent) => { e.preventDefault(); for (const h of wheelHooks) { try { if (h(Math.sign(e.deltaY), Math.sign(e.deltaX), e.shiftKey)) return; } catch (err) { console.error(err); } } };
  const onDown = (e: PointerEvent) => { if (e.pointerType === 'touch') return onTouch(e, 'down'); e.preventDefault(); canvas.focus(); canvas.setPointerCapture?.(e.pointerId); [mx, my] = renderer.toGame(e.clientX, e.clientY); hiLog('input', `pointerdown b${e.button} client ${e.clientX.toFixed(0)},${e.clientY.toFixed(0)} -> game ${mx},${my} (view ${JSON.stringify(renderer.vp)}, game ${renderer.w}x${renderer.h})`); if (mouseHook('down', mx, my, e.button)) { hiLog('input', 'taken by a mod'); return; } pushEv(EVT.mousedown, mx, my, e.button); };
  const onUp = (e: PointerEvent) => { if (e.pointerType === 'touch') return onTouch(e, 'up'); [mx, my] = renderer.toGame(e.clientX, e.clientY); if (mouseHook('up', mx, my, e.button)) { hiLog('input', `pointerup b${e.button} taken by a mod`); return; } pushEv(EVT.mouseup, mx, my, e.button); };
  // ---- touch: tap = click, drag = drag with the left button, long press = right click,
  //      two fingers = scroll the island (grab), the game cursor jumps to the finger ----
  const touches = new Map<number, { x: number; y: number }>();
  let tp: { id: number; x0: number; y0: number; gx: number; gy: number; mode: 'pending' | 'drag' | 'done'; timer: number } | null = null;
  let two: { ax: number; ay: number } | null = null;
  const centroid = () => { let x = 0, y = 0; for (const t of touches.values()) { x += t.x; y += t.y; } return [x / touches.size, y / touches.size]; };
  const tap = (vk: number) => { pushEv(EVT.keydown, 0, 0, 0, vk, 0); pushEv(EVT.keyup, 0, 0, 0, vk, 0); };
  const onTouch = (e: PointerEvent, type: 'down' | 'move' | 'up') => {
    e.preventDefault();
    if (type === 'down') { canvas.setPointerCapture?.(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); }
    else if (type === 'move') { if (!touches.has(e.pointerId)) return; touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); }
    else touches.delete(e.pointerId);
    if (type === 'down' && touches.size === 3) {           // three-finger tap: menu
      if (tp) { clearTimeout(tp.timer); tp.mode = 'done'; } two = null; touches.clear(); openDrawer(audio); return;
    }
    if (type === 'down' && touches.size === 2) {           // second finger: cancel the pending tap, start scrolling
      if (tp) { clearTimeout(tp.timer); if (tp.mode === 'drag') pushEv(EVT.mouseup, mx, my, 0); tp.mode = 'done'; }
      const [cx, cy] = centroid(); const [gx, gy] = renderer.toGame(cx, cy); two = { ax: gx, ay: gy }; return;
    }
    if (two) {
      if (touches.size >= 2 && type === 'move') {
        const [cx, cy] = centroid(); const [gx, gy] = renderer.toGame(cx, cy);
        while (gx - two.ax >= 64) { tap(37); two.ax += 64; } while (two.ax - gx >= 64) { tap(39); two.ax -= 64; }
        while (gy - two.ay >= 32) { tap(38); two.ay += 32; } while (two.ay - gy >= 32) { tap(40); two.ay -= 32; }
      }
      if (touches.size === 0) { two = null; tp = null; }
      return;
    }
    if (type === 'down' && touches.size === 1) {
      [mx, my] = renderer.toGame(e.clientX, e.clientY); inside = true; pushEv(EVT.mousemove, mx, my);
      const cur = { id: e.pointerId, x0: e.clientX, y0: e.clientY, gx: mx, gy: my, mode: 'pending' as const, timer: 0 };
      cur.timer = window.setTimeout(() => { if (tp === cur && cur.mode === 'pending') { (cur as any).mode = 'done'; hiLog('input', `long press -> right click ${cur.gx},${cur.gy}`); pushEv(EVT.mousedown, cur.gx, cur.gy, 2); pushEv(EVT.mouseup, cur.gx, cur.gy, 2); } }, 550);
      tp = cur; hiLog('input', `touch down -> game ${mx},${my}`); return;
    }
    if (!tp || e.pointerId !== tp.id) return;
    [mx, my] = renderer.toGame(e.clientX, e.clientY);
    if (type === 'move') {
      if (tp.mode === 'pending' && Math.hypot(e.clientX - tp.x0, e.clientY - tp.y0) > 10) { clearTimeout(tp.timer); tp.mode = 'drag'; pushEv(EVT.mousedown, tp.gx, tp.gy, 0); }
      pushEv(EVT.mousemove, mx, my);
    } else if (type === 'up') {
      clearTimeout(tp.timer);
      if (tp.mode === 'pending') { pushEv(EVT.mousedown, tp.gx, tp.gy, 0); pushEv(EVT.mouseup, tp.gx, tp.gy, 0); }
      else if (tp.mode === 'drag') pushEv(EVT.mouseup, mx, my, 0);
      tp = null;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!$('modal').hidden || !$('drawer').hidden) return;
    if (e.code === 'F12') return; // developer tools
    for (const h of keyHooks) { try { if (h(e)) { e.preventDefault(); return; } } catch (err) { console.error(err); } }
    if (e.code === 'F11' && e.type === 'keydown') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.code === 'F10' && e.type === 'keydown') { e.preventDefault(); openDrawer(audio); return; }
    const vk = vkOf(e); if (!vk) return;
    e.preventDefault();
    pushEv(e.type === 'keydown' ? EVT.keydown : EVT.keyup, 0, 0, 0, vk, e.type === 'keydown' ? charOf(e) : 0);
  };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey);
  quitHandler = async () => { $('drawerClose').click(); if (await showModal(t('quitTitle'), t('quitText'), 4) === 6) stop(); };

  let rafCount = 0, statT = performance.now(), lastRaf = performance.now(), maxGap = 0;
  const frameLoop = () => {
    if (!alive) return;
    const nowT = performance.now(); rafCount++; maxGap = Math.max(maxGap, nowT - lastRaf); lastRaf = nowT;
    if (nowT - statT > 5000) {
      const st = renderer.stats;
      hiLog('debug', `ui: ${(rafCount * 1000 / (nowT - statT)).toFixed(0)} fps, longest frame gap ${maxGap.toFixed(0)}ms, game frames ${st.uploads}, filter runs ${st.filterRuns} avg ${(st.filterMs / Math.max(1, st.filterRuns)).toFixed(1)}ms`);
      rafCount = 0; statT = nowT; maxGap = 0; st.uploads = 0; st.filterRuns = 0; st.filterMs = 0;
    }
    const fs = Atomics.load(ctrl, CTRL.FRAMESEQ);
    if (fs !== lastFrame) { lastFrame = fs; renderer.upload(frame, ctrl[CTRL.FRAMEW] || 640, ctrl[CTRL.FRAMEH] || 480); }
    const cs = Atomics.load(ctrl, CTRL.CURSORSEQ);
    if (cs !== lastCursor) { lastCursor = cs; renderer.uploadCursor(cursorBuf, ctrl[CTRL.CURSORW], ctrl[CTRL.CURSORH], ctrl[CTRL.CURSORHX], ctrl[CTRL.CURSORHY]); }
    renderer.resize();
    if ((renderer as any).allocated) { const v = renderer.visible; if (v.x !== ctrl[CTRL.VIEWX] || v.y !== ctrl[CTRL.VIEWY] || v.w !== ctrl[CTRL.VIEWW] || v.h !== ctrl[CTRL.VIEWH]) {
      ctrl[CTRL.VIEWX] = v.x; ctrl[CTRL.VIEWY] = v.y; ctrl[CTRL.VIEWW] = v.w; ctrl[CTRL.VIEWH] = v.h; Atomics.add(ctrl, CTRL.VIEWSEQ, 1);
      hiLog('info', `visible area ${v.w}x${v.h}+${v.x}+${v.y} of ${renderer.w}x${renderer.h}`);
    } }
    renderer.draw(mx, my, ctrl[CTRL.CURSORVIS] !== 0);
    requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);

  // watchdog: the worker bumps a heartbeat between slices of game code and while it waits. If it stops,
  // the emulator is stuck inside one of its own functions (or the worker died): say where, in the log.
  let heart = -1, heartT = performance.now(), hung = false, dumps = 0;
  const watchdog = setInterval(() => {
    if (!alive) return;
    const h = Atomics.load(ctrl, CTRL.HEART), now = performance.now();
    const waiting = Atomics.load(ctrl, CTRL.MSGBOX) === -1 || Atomics.load(ctrl, CTRL.PAUSE) !== 0 || heart < 0 && h === 0;
    if (h !== heart || waiting) { if (hung && h !== heart) hiLog('warn', 'emulator responds again'); heart = h; heartT = now; hung = false; dumps = 0; return; }
    // while hung, ask the worker three times (1 s apart) where the game code is running
    if (hung && dumps < 4) {
      if (dumps === 3 && Atomics.load(ctrl, CTRL.DUMPREQ)) hiLog('error', 'no hang dump: the emulator is stuck in its own code, not in game code');
      if (dumps < 3) Atomics.store(ctrl, CTRL.DUMPREQ, 1);
      dumps++;
    }
    if (!hung && now - heartT > 8000) {
      hung = true;
      const api = ctrl[CTRL.APINOW], hex = (v: number) => (v & 0xffff).toString(16);
      hiLog('error', `emulator not responding for ${((now - heartT) / 1000).toFixed(0)}s: ${api ? `inside ${apiNames[api - 1] || '#' + api} called from ${hex(ctrl[CTRL.APICS])}:${hex(ctrl[CTRL.APIIP])}` : 'not inside an API'}, game code last at ${hex(ctrl[CTRL.GAMECS])}:${hex(ctrl[CTRL.GAMEIP])}`);
      toast(t('hangToast'), 15000);
    }
  }, 1000);
  timers.push(watchdog as unknown as number);
  worker.onerror = (e) => { hiLog('error', `emulator worker error: ${e.message || e} ${e.filename || ''}:${e.lineno || ''}`); };
  worker.onmessageerror = () => hiLog('error', 'emulator worker message error');

  const stop = () => {
    if (!alive) return; alive = false; quitHandler = null;
    worker.terminate(); audio.stopAll(); void audio.ctx.close();
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('wheel', onWheel); timers.forEach((x) => clearInterval(x)); game.querySelectorAll('.mod-overlay').forEach((d) => d.remove());
    window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey);
    Promise.all(persistQueue).finally(() => backToLauncher());
  };
  session = { stop };
}
function toast(text: string, ms = 7000) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = text; document.body.appendChild(d);
  setTimeout(() => d.classList.add('out'), ms); setTimeout(() => d.remove(), ms + 600);
}
function backToLauncher() {
  if (document.fullscreenElement) void document.exitFullscreen();
  $('game').hidden = true; $('launcher').hidden = false; $('backdrop').hidden = false; session = null; document.title = 'Holiday Island – Project Sunburn';
}
function toggleFullscreen() { if (document.fullscreenElement) void document.exitFullscreen(); else void $('game').requestFullscreen?.(); }

// ---------------- dialogs ----------------
function showModal(title: string, text: string, type: number): Promise<number> {
  return new Promise((res) => {
    $('modalTitle').textContent = title || 'Holiday Island'; $('modalText').textContent = text;
    const bs = $('modalButtons'); bs.innerHTML = '';
    const sets: [string, number][][] = [[['OK', 1]], [['OK', 1], [t('cancel'), 2]], [[t('abort'), 3], [t('retry'), 4], [t('ignore'), 5]], [[t('yes'), 6], [t('no'), 7], [t('cancel'), 2]], [[t('yes'), 6], [t('no'), 7]], [[t('retry'), 4], [t('cancel'), 2]]];
    const set = sets[type & 0xf] || sets[0];
    set.forEach(([label, id], i) => { const b = document.createElement('button'); b.className = 'btn' + (i === 0 ? ' primary' : ''); b.textContent = label; b.onclick = () => { $('modal').hidden = true; res(id); ($('screen') as HTMLElement).focus(); }; bs.appendChild(b); });
    $('modal').hidden = false; (bs.firstChild as HTMLElement)?.focus();
  });
}
let quitHandler: (() => void) | null = null;
function openDrawer(audio?: AudioEngine) {
  $('drawerLog').onclick = () => saveLog();
  $('drawerQuit').hidden = !quitHandler; $('drawerQuit').onclick = () => quitHandler?.(); $('drawerFull').onclick = () => toggleFullscreen();
  const body = $('drawerBody'); body.innerHTML = '';
  const grid = $('settingsCard').querySelector('.grid')!;
  // move settings grid into drawer temporarily
  body.appendChild(grid);
  $('drawer').hidden = false;
  const onInput = () => audio?.applyVolumes();
  body.addEventListener('input', onInput);
  $('drawerClose').onclick = () => { $('drawer').hidden = true; $('settingsCard').appendChild(grid); body.removeEventListener('input', onInput); ($('screen') as HTMLElement).focus(); };
}

// ---------------- bootstrap ----------------
function bindSettings() {
  const sel = (id: string, key: keyof Settings) => { const el = $<HTMLSelectElement>(id); el.value = String(settings[key]); el.onchange = () => { (settings as any)[key] = el.value; saveSettings(); }; };
  sel('optScale', 'scale'); sel('optAspect', 'aspect'); sel('optVideo', 'video'); sel('optMusicSrc', 'musicSrc');
  const rng = (id: string, out: string, key: 'music' | 'sfx') => { const el = $<HTMLInputElement>(id); el.value = String(settings[key]); $(out).textContent = settings[key] + '%'; el.oninput = () => { settings[key] = +el.value; $(out).textContent = el.value + '%'; saveSettings(); }; };
  rng('optMusic', 'musicOut', 'music'); rng('optSfx', 'sfxOut', 'sfx');
  const px = $<HTMLInputElement>('optProxy'); px.value = settings.dlProxy || ''; setDownloadProxy(px.value);
  px.onchange = () => { settings.dlProxy = px.value.trim(); setDownloadProxy(settings.dlProxy); saveSettings(); };
  $('proxyField').hidden = /Electron/.test(navigator.userAgent);   // the desktop app needs no proxy
}
// settings that are carried out by built-in mods (manifest "setting": true)
function bindModSettings() {
  const on = (id: string) => !!modState.enabled[id];
  const f = $<HTMLSelectElement>('optFilter'), crt = $<HTMLInputElement>('optCrt');
  const style = () => String(modState.settings['display-filter']?.style || 'sharp');
  f.value = on('display-filter') ? style() : 'off';
  crt.value = String(modState.settings['display-filter']?.strength ?? 45); $('crtOut').textContent = crt.value + '%';
  const showCrt = () => { $('crtField').hidden = f.value !== 'crt'; };
  f.onchange = () => { if (f.value === 'off') setEnabled('display-filter', false); else { setEnabled('display-filter', true); setSetting('display-filter', 'style', f.value); } showCrt(); };
  crt.oninput = () => { setSetting('display-filter', 'strength', +crt.value); $('crtOut').textContent = crt.value + '%'; };
  showCrt();
  const fc = $<HTMLSelectElement>('optFilmColours'); fc.value = on('truecolor-video') ? 'true' : '256'; fc.onchange = () => setEnabled('truecolor-video', fc.value === 'true');
  const fx = $<HTMLInputElement>('optFixes'); fx.checked = on('bugfixes'); fx.onchange = () => setEnabled('bugfixes', fx.checked);
}
async function main() {
  applyI18n(); bindSettings();
  $('uiLang').onclick = (e) => { e.preventDefault(); settings.ui = settings.ui === 'de' ? 'en' : 'de'; saveSettings(); applyI18n(); renderLibrary(); renderMods(); };
  $('urlForm').onsubmit = (e) => { e.preventDefault(); const v = $<HTMLInputElement>('urlInput').value; if (v.trim() || dlAbort) void importUrl(v); };
  const pick = $<HTMLInputElement>('filePick'); pick.onchange = () => { if (pick.files?.length) void importFiles([...pick.files]); pick.value = ''; };
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); const fl = [...(e.dataTransfer?.files || [])]; if (fl.length) void importFiles(fl); });
  $('playBtn').onclick = () => void startGame();
  $('saveLog').onclick = (e) => { e.preventDefault(); saveLog(); };
  // web app install (Chrome/Edge/Android); Safari: "Add to Home Screen" from the share menu
  let installEv: any = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEv = e; $('installWrap').hidden = false; });
  $('installApp').onclick = async (e) => { e.preventDefault(); if (!installEv) return; installEv.prompt(); await installEv.userChoice; installEv = null; $('installWrap').hidden = true; };
  await loadLibrary(); renderLibrary();
  await loadCatalogue(); bindModSettings(); renderMods({ t, ui: () => settings.ui as 'en' | 'de', lang: () => (settings.lang || 'en') as string, modal: showModal });
  (window as any).__hi = { settings, library, importFiles, startGame, logText };
  await applyLaunchOptions();
}
// desktop app started with options (RecompLauncher, a shortcut, a disc image dropped on the program)
async function applyLaunchOptions() {
  if (!isDesktop) return;
  let o: { disc: { files: { name: string; size: number }[] } | null; play: boolean; set: Record<string, string>; mods: Record<string, boolean>; modset?: Record<string, string> };
  try { o = await (await fetch('/__launch')).json(); } catch { return; }
  const known: Record<string, (v: string) => any> = { scale: String, aspect: String, video: String, musicSrc: String, ui: String, music: Number, sfx: Number };
  let changed = false;
  for (const [k, v] of Object.entries(o.set || {})) if (known[k]) { (settings as any)[k] = known[k](v); changed = true; }
  if (changed) { saveSettings(); hiLog('info', 'settings from the command line: ' + JSON.stringify(o.set)); }
  for (const [id, on] of Object.entries(o.mods || {})) if (catalogue.has(id)) setEnabled(id, on);
  for (const [k, v] of Object.entries(o.modset || {})) {
    const [id, key] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)]; const s = catalogue.get(id)?.manifest.settings?.find((x) => x.key === key); if (!s) continue;
    setSetting(id, key, s.type === 'toggle' ? v === 'on' || v === 'true' || v === '1' : s.type === 'range' ? Number(v) : v);
  }
  if (!o.disc) return;
  // the same disc already in the library? (same file names and sizes)
  const sig = (fs: { name: string; size: number }[]) => fs.map((f) => `${f.name.toLowerCase()}:${f.size}`).sort().join('|');
  const want = sig(o.disc.files);
  let lang = [...library.values()].find((d) => sig(d.files.map((f) => ({ name: f.name, size: f.file.size }))) === want)?.lang;
  if (!lang) {
    const st = $('importStatus'); st.hidden = false; st.className = 'status'; st.textContent = t('checking') + ' ' + o.disc.files.map((f) => f.name).join(' + ');
    const fl: File[] = [];
    for (const f of o.disc.files) fl.push(new File([await (await fetch(`/__launchfile?name=${encodeURIComponent(f.name)}`)).blob()], f.name));
    const before = new Set(library.keys());
    await importFiles(fl);
    lang = [...library.keys()].find((k) => !before.has(k)) || ([...library.values()].find((d) => sig(d.files.map((f) => ({ name: f.name, size: f.file.size }))) === want)?.lang);
  }
  if (!lang) { hiLog('warn', 'the disc from the command line is not a Holiday Island CD'); return; }
  settings.lang = lang; saveSettings(); renderLibrary();
  if (o.play) await startGame();
}
void main();
