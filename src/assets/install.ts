// Rebuild the Holiday Island hard disk installation from the player's CD image.
import { Disc } from './disc';
import { lzhufDecode } from './lzhuf';
import { MemFS, FSProvider } from '../win16/vfs';

export type Lang = 'en' | 'de';
export interface SFEntry { path: string; size: number; off: number; csize: number; }

export function parseSunflowersArchive(d: Uint8Array): SFEntry[] {
  const p0 = d[0] === 0x53 && d[1] === 0x55 ? 0x22 : 5; // "SUNFLOWERS INSTALLATION FILE" header variant
  const out: SFEntry[] = [];
  for (let q = p0; q + 135 <= d.length; q += 135) {
    const nl = d[q + 17]; const name = String.fromCharCode(...d.subarray(q + 18, q + 18 + nl));
    if (name[1] !== ':' || name[2] !== '\\') break;
    const r32 = (o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
    out.push({ path: name, size: r32(q + 101), off: r32(q + 105), csize: r32(q + 109) });
  }
  return out;
}

export function detectLanguage(disc: Disc): Lang | null {
  if (disc.dirs.has('SPRACHE1')) return 'en';
  if (disc.dirs.has('SPRADEU1')) return 'de';
  const ar = disc.readFile('AUTORUN.INF'); if (ar && /language\s*=\s*english/i.test(new TextDecoder().decode(ar))) return 'en';
  return null;
}

export interface Installed { lang: Lang; C: MemFS; exePath: string; }

export interface InstallOptions { videoHi: boolean; soundHi: boolean; }

// Build C:\HOLIDAY from _FILES.1 (+ UPGRADE folder) and generate SETUP.DAT.
export function buildInstall(disc: Disc, opts: InstallOptions = { videoHi: true, soundHi: true }): Installed {
  const lang = detectLanguage(disc);
  if (!lang) throw new Error('This does not look like a Holiday Island CD (no speech folder found).');
  const arc = disc.readFile('_FILES.1');
  if (!arc) throw new Error('Installer archive _FILES.1 not found on the disc.');
  const C = new MemFS();
  for (const e of parseSunflowersArchive(arc)) {
    const lower = e.path.toLowerCase(); const i = lower.indexOf('holiday\\'); if (i < 0) continue;
    let rel = e.path.slice(i + 8).replace(/\//g, '\\');
    const parts = rel.split('\\');
    const first = parts[0].toLowerCase();
    if (first === 'install') continue;
    if (first === 'exe' || first === 'exe_eng' || first === 'exreleng') rel = parts.slice(1).join('\\');
    const data = lzhufDecode(arc.subarray(e.off, e.off + e.csize), e.size);
    C.add('HOLIDAY\\' + rel.toUpperCase(), data);
  }
  if (!C.read('HOLIDAY\\HOLIDAY.EXE')) throw new Error('HOLIDAY.EXE not found in installer archive.');
  // the English release copies the expansion folder to disk
  if (disc.dirs.has('UPGRADE')) for (const [p] of disc.files) if (p.startsWith('UPGRADE\\')) C.add('HOLIDAY\\' + p, disc.readFile(p)!);
  // setup.dat: CD path, speech on CD, graphics on CD, film quality, sound
  const setup = `D:\\\r\n1\r\n1\r\n${opts.videoHi ? 'H' : 'L'}\r\n${opts.soundHi ? 'H' : 'L'}\r\n`;
  C.add('HOLIDAY\\SETUP.DAT', new TextEncoder().encode(setup));
  return { lang, C, exePath: 'C:\\HOLIDAY\\HOLIDAY.EXE' };
}

// Read-only drive backed by a disc image (lazy reads)
export class DiscFS implements FSProvider {
  readonly = true;
  private cache = new Map<string, Uint8Array>();
  constructor(public disc: Disc) {}
  read(p: string) {
    if (!this.disc.files.has(p)) return null;
    let d = this.cache.get(p); if (d) return d;
    d = this.disc.readFile(p)!;
    if (d.length < 4 * 1024 * 1024) this.cache.set(p, d);
    return d;
  }
  isDir(p: string) { return this.disc.dirs.has(p); }
  list(dir: string) {
    if (!this.disc.dirs.has(dir)) return null;
    const pre = dir ? dir + '\\' : ''; const out: { name: string; dir: boolean; size: number }[] = [];
    for (const d of this.disc.dirs) if (d && d.startsWith(pre) && !d.slice(pre.length).includes('\\') && d !== dir) out.push({ name: d.slice(pre.length), dir: true, size: 0 });
    for (const [f, v] of this.disc.files) if (f.startsWith(pre) && !f.slice(pre.length).includes('\\')) out.push({ name: f.slice(pre.length), dir: false, size: v.size });
    return out;
  }
}
