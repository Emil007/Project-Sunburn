// Launcher UI for the mod manager.
import { catalogue, modState, applyPreset, setEnabled, settingValue, setSetting, storeSettingFile, installMod, removeMod, isLangOk, enabledMods, ModEntry } from './mods';
import type { ModSetting } from '../mods/types';

interface Ctx { t: (k: string) => string; ui: () => 'en' | 'de'; lang: () => string; modal: (title: string, text: string, type: number) => Promise<number>; }
let ctx: Ctx | null = null;
const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, any> = {}, ...kids: (Node | string | null)[]) => {
  const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) if (k !== null) e.append(k); return e;
};
const CATS = ['Graphics', 'Interface', 'Gameplay', 'Audio', 'Fixes', 'Content'];
let bound = false;

export function renderMods(c?: Ctx) {
  if (c) ctx = c; if (!ctx) return;
  const { t } = ctx; const de = ctx.ui() === 'de'; const lang = ctx.lang();
  const L = (o: any, k: string) => (de && o[k + '_de']) || o[k] || '';
  if (!bound) {
    bound = true;
    $('modPresets').querySelectorAll('button').forEach((b) => (b as HTMLButtonElement).onclick = () => { applyPreset((b as HTMLElement).dataset.p as any); renderMods(); });
    const inst = async (files: File[]) => {
      const st = $('modStatus'); st.hidden = false; st.className = 'status'; st.textContent = '…';
      try { const id = await installMod(files); setEnabled(id, true); st.textContent = `${ctx!.t('modInstalled')}: ${catalogue.get(id)?.manifest.name || id}`; }
      catch (e: any) { st.className = 'status err'; st.textContent = `${ctx!.t('modErr')}: ${e.message || e}`; }
      renderMods();
    };
    const zip = $('modZip') as HTMLInputElement; zip.onchange = () => { if (zip.files?.length) void inst([...zip.files]); zip.value = ''; };
    const dir = $('modDir') as HTMLInputElement; dir.onchange = () => { if (dir.files?.length) void inst([...dir.files]); dir.value = ''; };
  }
  // preset highlight
  const rec = [...catalogue.values()].filter((e) => e.manifest.recommended && !e.manifest.hidden && !e.manifest.setting).map((e) => e.manifest.id).sort().join();
  const on = Object.keys(modState.enabled).filter((k) => modState.enabled[k] && catalogue.has(k) && !catalogue.get(k)!.manifest.hidden && !catalogue.get(k)!.manifest.setting).sort().join();
  $('modPresets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', ((b as HTMLElement).dataset.p === 'original' && !on) || ((b as HTMLElement).dataset.p === 'recommended' && on === rec)));
  $('modsCount').textContent = String(enabledMods(lang).filter((e) => !e.manifest.hidden && !e.manifest.setting).length);

  const list = $('modList'); list.innerHTML = '';
  const groups = new Map<string, ModEntry[]>();
  for (const e of catalogue.values()) { if (e.manifest.hidden || e.manifest.setting) continue; const c = CATS.includes(e.manifest.category || '') ? e.manifest.category! : 'Other'; (groups.get(c) || groups.set(c, []).get(c)!).push(e); }
  for (const cat of [...CATS, 'Other']) {
    const items = groups.get(cat); if (!items?.length) continue;
    list.append(el('div', { className: 'modcat', textContent: t('cat' + cat) }));
    items.sort((a, b) => L(a.manifest, 'name').localeCompare(L(b.manifest, 'name')));
    for (const e of items) list.append(modRow(e, lang, L));
  }
}

function modRow(e: ModEntry, lang: string, L: (o: any, k: string) => string) {
  const { t } = ctx!; const m = e.manifest; const enabled = !!modState.enabled[m.id]; const ok = isLangOk(m, lang);
  const sw = el('label', { className: 'switch' }, el('input', { type: 'checkbox', checked: enabled, disabled: !ok, onchange: (ev: Event) => { setEnabled(m.id, (ev.target as HTMLInputElement).checked); renderMods(); } }), el('i'));
  const pills: (Node | null)[] = [];
  if (m.experimental) pills.push(el('span', { className: 'tagpill exp', textContent: t('modExperimental') }));
  if (!e.builtin) pills.push(el('span', { className: 'tagpill', textContent: t('modUser') + (m.version ? ' · v' + m.version : '') }));
  if (m.languages?.length && m.languages.length < 2) pills.push(el('span', { className: 'tagpill', textContent: t('modOnly').replace('{l}', m.languages.map((x) => x.toUpperCase()).join('/')) }));
  const meta = el('div', { className: 'meta' }, el('b', { textContent: L(m, 'name') }), ...pills,
    el('div', { className: 'desc', textContent: L(m, 'description') + (m.author && !e.builtin ? ` — ${m.author}` : '') }));
  const head = el('div', { className: 'mod-head' }, sw, meta);
  if (!e.builtin) head.append(el('button', { className: 'btn small ghost danger', textContent: t('modRemove'), onclick: async () => { if (await ctx!.modal(L(m, 'name'), t('modRemoveQ'), 4) === 6) { await removeMod(m.id); renderMods(); } } }));
  const row = el('div', { className: 'mod' + (enabled ? '' : ' off') + (ok ? '' : ' na') }, head);
  if (enabled && m.settings?.length) {
    const box = el('div', { className: 'mod-settings' });
    const fields: [ModSetting, HTMLElement][] = [];
    // settings with "when" are only shown while the settings they depend on have those values
    const refresh = () => { for (const [s, f] of fields) f.hidden = !!s.when && Object.entries(s.when).some(([k, want]) => { const dep = m.settings!.find((x) => x.key === k); return !dep || String(settingValue(m.id, dep)) !== String(want); }); };
    for (const s of m.settings) { const f = settingField(m.id, s, L, refresh); fields.push([s, f]); box.append(f); }
    refresh();
    row.append(box);
  }
  return row;
}

function settingField(id: string, s: ModSetting, L: (o: any, k: string) => string, changed: () => void) {
  const { t } = ctx!; const v = settingValue(id, s); const label = L(s, 'label');
  if (s.type === 'toggle') return el('label', { className: 'field chk' }, el('input', { type: 'checkbox', checked: !!v, onchange: (e: Event) => { setSetting(id, s.key, (e.target as HTMLInputElement).checked); changed(); } }), label);
  const f = el('div', { className: 'field' });
  const out = el('output');
  f.append(el('label', {}, el('span', { textContent: label }), out));
  if (s.type === 'select') {
    const sel = el('select', { onchange: (e: Event) => { setSetting(id, s.key, (e.target as HTMLSelectElement).value); changed(); } });
    for (const o of s.options || []) sel.append(el('option', { value: String(o.value), textContent: L(o, 'label'), selected: String(o.value) === String(v) }));
    f.append(sel);
  } else if (s.type === 'range') {
    out.textContent = String(v);
    f.append(el('input', { type: 'range', min: String(s.min ?? 0), max: String(s.max ?? 100), step: String(s.step ?? 1), value: String(v), oninput: (e: Event) => { const x = +(e.target as HTMLInputElement).value; out.textContent = String(x); setSetting(id, s.key, x); } }));
  } else if (s.type === 'text') {
    f.append(el('input', { type: 'text', value: String(v ?? ''), onchange: (e: Event) => setSetting(id, s.key, (e.target as HTMLInputElement).value) }));
  } else if (s.type === 'file') {
    out.textContent = v ? String(v) : t('modNoFile');
    const inp = el('input', { type: 'file', accept: s.accept || '', onchange: async () => { const fl = inp.files?.[0]; if (!fl) return; await storeSettingFile(id, s.key, fl); out.textContent = fl.name; } }) as HTMLInputElement;
    f.append(el('label', { className: 'btn small' }, inp, el('span', { textContent: t('modChooseFile') })));
  }
  return f;
}
