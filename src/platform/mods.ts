// Mod manager (UI thread): catalogue of built-in and installed mods, enable state, settings,
// import of user mods (.zip or folder) into OPFS, and assembly of the active mod list at game start.
import { unzipSync } from 'fflate';
import type { ActiveMod, ModManifest, ModSetting } from '../mods/types';

export interface ModEntry { manifest: ModManifest; builtin: boolean; }
interface ModState { initialized: boolean; enabled: Record<string, boolean>; settings: Record<string, Record<string, any>>; seen?: string[]; }

const KEY = 'hi.mods';
export const modState: ModState = (() => {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.enabled) return { initialized: true, settings: {}, ...s }; } catch { /* */ }
  return { initialized: false, enabled: {}, settings: {} };
})();
export const saveModState = () => { try { localStorage.setItem(KEY, JSON.stringify(modState)); } catch { /* */ } };

export const catalogue = new Map<string, ModEntry>();

async function opfsDir(path: string[], create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    let d = await navigator.storage.getDirectory();
    for (const p of path) d = await d.getDirectoryHandle(p, { create });
    return d;
  } catch { return null; }
}
async function readTree(dir: FileSystemDirectoryHandle, prefix = ''): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  for await (const [name, h] of (dir as any).entries()) {
    if (h.kind === 'directory') out.push(...await readTree(h, prefix + name + '/'));
    else out.push({ path: prefix + name, file: await h.getFile() });
  }
  return out;
}

export async function loadCatalogue() {
  catalogue.clear();
  try {
    const list: ModManifest[] = await (await fetch('mods/index.json')).json();
    for (const m of list) catalogue.set(m.id, { manifest: m, builtin: true });
  } catch (e) { console.warn('no built-in mods', e); }
  const root = await opfsDir(['mods']);
  if (root) {
    for await (const [id, h] of (root as any).entries()) {
      if (h.kind !== 'directory') continue;
      try {
        const files = await readTree(h);
        const mf = files.find((f) => f.path === 'mod.json'); if (!mf) continue;
        const manifest: ModManifest = JSON.parse(await mf.file.text());
        manifest.id = id; manifest.files = files.map((f) => f.path);
        catalogue.set(id, { manifest, builtin: false });
      } catch (e) { console.warn('bad mod', id, e); }
    }
  }
  migrate();
  if (!modState.initialized) { applyPreset('recommended'); modState.initialized = true; }
  else {
    // recommended mods that arrived with an update are switched on once (unless the player chose "Original")
    const anyOn = Object.values(modState.enabled).some(Boolean);
    for (const [id, e] of catalogue) if (e.builtin && e.manifest.recommended && !(modState.seen || []).includes(id) && !(id in modState.enabled) && anyOn) modState.enabled[id] = true;
  }
  modState.seen = [...catalogue.keys()];
  saveModState();
}

// mods that were merged or moved: keep the player's choice
function migrate() {
  const en = modState.enabled; let changed = false;
  // cheats moved from mods to the F9 cheat menu
  for (const old of ['cheat-without-penalty', 'unlock-buildings']) if (old in en) { delete en[old]; delete modState.settings[old]; changed = true; }
  const styles: Record<string, string> = { 'filter-sharp': 'sharp', 'filter-smooth': 'smooth', 'filter-edge': 'edge', 'filter-crt': 'crt' };
  for (const [old, style] of Object.entries(styles)) {
    if (!(old in en)) continue;
    if (en[old]) { en['display-filter'] = true; (modState.settings['display-filter'] ||= {}).style = style; }
    else if (!('display-filter' in en)) en['display-filter'] = false;
    if (old === 'filter-crt' && modState.settings[old]?.strength !== undefined) (modState.settings['display-filter'] ||= {}).strength = modState.settings[old].strength;
    delete en[old]; delete modState.settings[old]; changed = true;
  }
  // after the filters are migrated: if any filter was on, display-filter is on
  if (changed) { modState.seen = [...new Set([...(modState.seen || []), 'display-filter'])]; saveModState(); }
}

export function applyPreset(p: 'original' | 'recommended') {
  // the presets are about the mods; settings-type mods (filter, film colours, fixes) keep their state,
  // except on the very first start, when the recommended ones are switched on
  const first = !modState.initialized; const keep: Record<string, boolean> = {};
  for (const [id, e] of catalogue) if (e.manifest.setting && id in modState.enabled) keep[id] = modState.enabled[id];
  modState.enabled = {};
  for (const [id, e] of catalogue) if (e.manifest.recommended && !e.manifest.hidden && (p === 'recommended' || (e.manifest.setting && first))) modState.enabled[id] = true;
  Object.assign(modState.enabled, keep);
  saveModState();
}

export function setEnabled(id: string, on: boolean) {
  modState.enabled[id] = on;
  if (on) {
    const m = catalogue.get(id)?.manifest;
    for (const [oid, e] of catalogue) {
      if (oid === id) continue;
      if (m?.conflicts?.includes(oid) || e.manifest.conflicts?.includes(id)) modState.enabled[oid] = false;
    }
  }
  saveModState();
}

export function settingValue(id: string, s: ModSetting) {
  const v = modState.settings[id]?.[s.key];
  return v === undefined ? (s.default ?? (s.type === 'toggle' ? false : s.type === 'range' ? (s.min ?? 0) : s.type === 'select' ? s.options?.[0]?.value : '')) : v;
}
export function setSetting(id: string, key: string, v: any) { (modState.settings[id] ||= {})[key] = v; saveModState(); }

// files picked for "file" settings are kept in OPFS: modfiles/<id>/<key>
export async function storeSettingFile(id: string, key: string, file: File) {
  const d = await opfsDir(['modfiles', id], true); if (!d) throw new Error('storage unavailable');
  const fh = await d.getFileHandle(key, { create: true }); const w = await (fh as any).createWritable(); await w.write(file); await w.close();
  setSetting(id, key, file.name);
}
async function readSettingFile(id: string, key: string): Promise<Uint8Array | null> {
  const d = await opfsDir(['modfiles', id]); if (!d) return null;
  try { return new Uint8Array(await (await (await d.getFileHandle(key)).getFile()).arrayBuffer()); } catch { return null; }
}

const isLangOk = (m: ModManifest, lang: string) => !m.languages || !m.languages.length || m.languages.includes(lang as any);
export const enabledMods = (lang: string) => [...catalogue.values()]
  .filter((e) => (modState.enabled[e.manifest.id] || (e.builtin && e.manifest.hidden)) && isLangOk(e.manifest, lang))
  .sort((a, b) => (a.manifest.priority ?? 0) - (b.manifest.priority ?? 0));
export { isLangOk };

/** Everything a game session needs from the enabled mods. */
export async function buildActive(lang: string): Promise<ActiveMod[]> {
  const out: ActiveMod[] = [];
  for (const e of enabledMods(lang)) {
    const m = e.manifest; const files: { path: string; data: Uint8Array }[] = [];
    if (e.builtin) {
      await Promise.all((m.files || []).map(async (p) => { const r = await fetch(`mods/${m.id}/${p}`); if (r.ok) files.push({ path: p, data: new Uint8Array(await r.arrayBuffer()) }); }));
    } else {
      const d = await opfsDir(['mods', m.id]);
      if (d) for (const f of await readTree(d)) files.push({ path: f.path, data: new Uint8Array(await f.file.arrayBuffer()) });
    }
    const settings: Record<string, any> = {};
    for (const s of m.settings || []) {
      settings[s.key] = settingValue(m.id, s);
      if (s.type === 'file' && settings[s.key]) {
        const data = await readSettingFile(m.id, s.key);
        if (data) files.push({ path: `@setting/${s.key}`, data }); else settings[s.key] = '';
      }
    }
    out.push({ manifest: m, files, settings });
  }
  return out;
}

/** Install a mod from a .zip or from the files of a picked folder. Returns the mod id. */
export async function installMod(input: File[]): Promise<string> {
  let files: { path: string; data: Uint8Array }[] = [];
  if (input.length === 1 && /\.zip$/i.test(input[0].name)) {
    const z = unzipSync(new Uint8Array(await input[0].arrayBuffer()));
    files = Object.entries(z).filter(([p]) => !p.endsWith('/')).map(([path, data]) => ({ path, data }));
  } else {
    files = await Promise.all(input.map(async (f) => ({ path: ((f as any).webkitRelativePath || f.name) as string, data: new Uint8Array(await f.arrayBuffer()) })));
  }
  // the package root is the folder containing mod.json
  const mf = files.filter((f) => /(^|\/)mod\.json$/i.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0];
  if (!mf) throw new Error('mod.json not found');
  const root = mf.path.slice(0, mf.path.length - 'mod.json'.length);
  const manifest: ModManifest = JSON.parse(new TextDecoder().decode(mf.data));
  const id = String(manifest.id || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!id) throw new Error('mod.json has no "id"');
  if (catalogue.get(id)?.builtin) throw new Error(`"${id}" is the id of a built-in mod`);
  if (!manifest.name) throw new Error('mod.json has no "name"');
  const parent = await opfsDir(['mods'], true); if (!parent) throw new Error('storage unavailable');
  try { await parent.removeEntry(id, { recursive: true }); } catch { /* new */ }
  const dir = await parent.getDirectoryHandle(id, { create: true });
  for (const f of files) {
    if (!f.path.startsWith(root)) continue;
    const rel = f.path.slice(root.length).split('/').filter((p) => p && p !== '..');
    if (!rel.length) continue;
    let d = dir; for (const p of rel.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(rel[rel.length - 1], { create: true }); const w = await (fh as any).createWritable(); await w.write(f.data); await w.close();
  }
  await loadCatalogue();
  return id;
}

export async function removeMod(id: string) {
  const parent = await opfsDir(['mods']); if (parent) try { await parent.removeEntry(id, { recursive: true }); } catch { /* */ }
  const mf = await opfsDir(['modfiles']); if (mf) try { await mf.removeEntry(id, { recursive: true }); } catch { /* */ }
  delete modState.enabled[id]; delete modState.settings[id]; saveModState();
  await loadCatalogue();
}

export const fileText = (m: ActiveMod, p: string) => { const f = m.files.find((x) => x.path === p); return f ? new TextDecoder().decode(f.data) : null; };
export const fileData = (m: ActiveMod, p: string) => m.files.find((x) => x.path === p)?.data || null;
