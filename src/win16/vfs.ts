// Virtual file system with DOS drive letters. Paths are normalized to upper case.
export interface FSProvider {
  read(path: string): Uint8Array | null;           // path relative, '\' separated, upper-case, no leading '\'
  write?(path: string, data: Uint8Array): void;
  remove?(path: string): boolean;
  mkdir?(path: string): void;
  list(dir: string): { name: string; dir: boolean; size: number }[] | null;
  isDir(path: string): boolean;
  readonly: boolean;
}

export class MemFS implements FSProvider {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['']);
  readonly = false;
  onWrite?: (path: string, data: Uint8Array | null) => void;
  constructor(ro = false) { this.readonly = ro; }
  add(path: string, data: Uint8Array) {
    path = path.toUpperCase().replace(/\//g, '\\').replace(/^\\+/, '');
    this.files.set(path, data);
    const parts = path.split('\\'); let d = '';
    for (let i = 0; i < parts.length - 1; i++) { d = d ? d + '\\' + parts[i] : parts[i]; this.dirs.add(d); }
  }
  read(p: string) { return this.files.get(p) ?? null; }
  write(p: string, data: Uint8Array) { this.add(p, data); this.onWrite?.(p, data); }
  remove(p: string) { const r = this.files.delete(p); if (r) this.onWrite?.(p, null); return r; }
  mkdir(p: string) { this.dirs.add(p); }
  isDir(p: string) { return this.dirs.has(p); }
  list(dir: string) {
    if (!this.dirs.has(dir)) return null;
    const out: { name: string; dir: boolean; size: number }[] = [];
    const pre = dir ? dir + '\\' : '';
    for (const d of this.dirs) if (d.startsWith(pre) && d !== dir && !d.slice(pre.length).includes('\\')) out.push({ name: d.slice(pre.length), dir: true, size: 0 });
    for (const [f, v] of this.files) if (f.startsWith(pre) && !f.slice(pre.length).includes('\\')) out.push({ name: f.slice(pre.length), dir: false, size: v.length });
    return out;
  }
}

export class VFS {
  drives = new Map<string, FSProvider>();
  curDrive = 'C';
  curDir = new Map<string, string>(); // drive -> dir (no leading slash)
  mount(letter: string, fs: FSProvider) { this.drives.set(letter.toUpperCase(), fs); }
  // returns [drive, relpath]
  resolve(p: string): [string, string] {
    p = p.replace(/\//g, '\\').toUpperCase().trim();
    let drive = this.curDrive;
    if (/^[A-Z]:/.test(p)) { drive = p[0]; p = p.slice(2); }
    let parts: string[];
    if (p.startsWith('\\')) parts = [];
    else parts = (this.curDir.get(drive) || '').split('\\').filter(Boolean);
    for (let s of p.split('\\')) {
      // DOS 8.3 semantics: blanks used as padding inside a name ("GFELD       .BMP") are ignored
      s = s.replace(/ +\./g, '.').replace(/ +$/, '');
      if (!s || s === '.') continue;
      if (s === '..') parts.pop(); else parts.push(s);
    }
    return [drive, parts.join('\\')];
  }
  fs(drive: string) { return this.drives.get(drive); }
  read(p: string): Uint8Array | null {
    const [d, r] = this.resolve(p); const f = this.fs(d); if (!f) return null;
    return f.read(r);
  }
  exists(p: string) { const [d, r] = this.resolve(p); const f = this.fs(d); return !!f && (this.read(p) !== null || f.isDir(r)); }
  isDir(p: string) { const [d, r] = this.resolve(p); const f = this.fs(d); return !!f && f.isDir(r); }
  write(p: string, data: Uint8Array): boolean {
    const [d, r] = this.resolve(p); const f = this.fs(d); if (!f || f.readonly || !f.write) return false; f.write(r, data); return true;
  }
  full(p: string) { const [d, r] = this.resolve(p); return `${d}:\\${r}`; }
}

export function wildcardMatch(pattern: string, name: string): boolean {
  // DOS style: split name/ext
  const sp = (s: string) => { const i = s.lastIndexOf('.'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
  const [pn, pe] = sp(pattern.toUpperCase()); const [nn, ne] = sp(name.toUpperCase());
  const m = (p: string, s: string) => {
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.?') + '$');
    return re.test(s);
  };
  if (pattern === '*.*' || pattern === '*') return true;
  return m(pn, nn) && m(pe || '', ne);
}
