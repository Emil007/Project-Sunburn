// Disc image access: ISO (2048), raw BIN/MDF (2352/2448), MDS/CUE track tables, ISO9660 filesystem.
export interface ByteSource { size: number; read(off: number, len: number): Uint8Array; }

export interface Track { num: number; audio: boolean; startSector: number; sectors: number; fileOffset: number; sectorSize: number; dataOffset: number; source: ByteSource; }

export class Disc {
  tracks: Track[] = [];
  files = new Map<string, { lba: number; size: number }>(); // upper-case path with '\' separators, no leading slash
  dirs = new Set<string>(['']);
  volumeLabel = '';
  constructor(public dataTrack: Track) {}

  readSectors(lba: number, count: number): Uint8Array {
    const t = this.dataTrack;
    const rel = lba - t.startSector;
    if (t.sectorSize === 2048) return t.source.read(t.fileOffset + rel * 2048, count * 2048);
    const raw = t.source.read(t.fileOffset + rel * t.sectorSize, count * t.sectorSize);
    const out = new Uint8Array(count * 2048);
    for (let i = 0; i < count; i++) out.set(raw.subarray(i * t.sectorSize + t.dataOffset, i * t.sectorSize + t.dataOffset + 2048), i * 2048);
    return out;
  }
  readFile(path: string): Uint8Array | null {
    const f = this.files.get(path.toUpperCase().replace(/\//g, '\\').replace(/^\\+/, ''));
    if (!f) return null;
    const n = Math.ceil(f.size / 2048);
    return this.readSectors(f.lba, n).subarray(0, f.size);
  }
  parseFS() {
    const pvd = this.readSectors(16, 1);
    if (String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') throw new Error('Not an ISO9660 data track');
    this.volumeLabel = String.fromCharCode(...pvd.subarray(40, 72)).trim();
    const root = pvd.subarray(156, 156 + 34);
    const rd32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const walk = (lba: number, size: number, prefix: string, depth: number) => {
      if (depth > 16) return;
      const data = this.readSectors(lba, Math.ceil(size / 2048));
      let p = 0;
      while (p < size) {
        const len = data[p];
        if (len === 0) { p = (Math.floor(p / 2048) + 1) * 2048; continue; }
        const elba = rd32(data, p + 2), esize = rd32(data, p + 10), flags = data[p + 25], nl = data[p + 32];
        let name = String.fromCharCode(...data.subarray(p + 33, p + 33 + nl));
        if (!(nl === 1 && (data[p + 33] === 0 || data[p + 33] === 1))) {
          name = name.replace(/;\d+$/, '').replace(/\.$/, '').toUpperCase();
          const full = prefix ? prefix + '\\' + name : name;
          if (flags & 2) { this.dirs.add(full); walk(elba, esize, full, depth + 1); }
          else this.files.set(full, { lba: elba, size: esize });
        }
        p += len;
      }
    };
    walk(rd32(root, 2), rd32(root, 10), '', 0);
  }
  // CD audio track PCM (16-bit stereo 44.1k, little endian)
  readAudio(track: Track): Uint8Array {
    if (track.sectorSize === 2352) return track.source.read(track.fileOffset, track.sectors * 2352);
    const raw = track.source.read(track.fileOffset, track.sectors * track.sectorSize);
    const out = new Uint8Array(track.sectors * 2352);
    for (let i = 0; i < track.sectors; i++) out.set(raw.subarray(i * track.sectorSize, i * track.sectorSize + 2352), i * 2352);
    return out;
  }
}

const rd16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const rd32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function detectRaw(src: ByteSource): { sectorSize: number; dataOffset: number } {
  const sync = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
  const head = src.read(0, Math.min(src.size, 2448 * 17));
  const isSync = (o: number) => sync.every((v, i) => head[o + i] === v);
  for (const ss of [2352, 2448]) {
    if (isSync(0) && isSync(ss) && head.length >= ss * 17) {
      const mode = head[15];
      return { sectorSize: ss, dataOffset: mode === 2 ? 24 : 16 };
    }
  }
  return { sectorSize: 2048, dataOffset: 0 };
}

export function openISO(src: ByteSource): Disc {
  const r = detectRaw(src);
  const ss = r.sectorSize;
  const t: Track = { num: 1, audio: false, startSector: 0, sectors: Math.floor(src.size / ss), fileOffset: 0, sectorSize: ss, dataOffset: r.dataOffset, source: src };
  const d = new Disc(t); d.tracks.push(t); d.parseFS(); return d;
}

// Alcohol 120% MDS descriptor + MDF image
export function openMDS(mds: Uint8Array, mdf: ByteSource): Disc {
  if (String.fromCharCode(...mds.subarray(0, 16)) !== 'MEDIA DESCRIPTOR') throw new Error('bad MDS');
  const sessOff = rd32(mds, 0x50);
  const nBlocks = mds[sessOff + 10];
  const trkOff = rd32(mds, sessOff + 20);
  const tracks: Track[] = [];
  for (let i = 0; i < nBlocks; i++) {
    const o = trkOff + i * 80;
    const mode = mds[o], point = mds[o + 4];
    if (point < 1 || point > 99) continue;
    const ssz = rd16(mds, o + 0x10);
    const start = rd32(mds, o + 0x24);
    const fileOff = rd32(mds, o + 0x28) + rd32(mds, o + 0x2c) * 4294967296;
    const audio = mode === 0xa9 || mode === 0x00;
    tracks.push({ num: point, audio, startSector: start, sectors: 0, fileOffset: fileOff, sectorSize: ssz, dataOffset: mode === 0xaa ? 16 : 24, source: mdf });
  }
  tracks.sort((a, b) => a.num - b.num);
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const endOff = i + 1 < tracks.length ? tracks[i + 1].fileOffset : mdf.size;
    t.sectors = Math.floor((endOff - t.fileOffset) / t.sectorSize);
  }
  const data = tracks.find(t => !t.audio);
  if (!data) throw new Error('no data track');
  data.startSector = 0;
  const d = new Disc(data); d.tracks = tracks; d.parseFS(); return d;
}

// CUE sheet + BIN files (single or multi-file)
export function openCUE(cue: string, open: (name: string) => ByteSource | null): Disc {
  const tracks: Track[] = [];
  let cur: ByteSource | null = null; let curFile = '';
  let pending: Partial<Track> | null = null;
  const lines = cue.split(/\r?\n/);
  let fileStartSector = 0; let lastFile = '';
  for (const ln of lines) {
    const m = ln.trim().match(/^(\S+)\s+(.*)$/); if (!m) continue;
    const cmd = m[1].toUpperCase(), rest = m[2];
    if (cmd === 'FILE') { const fm = rest.match(/^"([^"]+)"/) || rest.match(/^(\S+)/); curFile = fm ? fm[1] : ''; cur = open(curFile); }
    else if (cmd === 'TRACK') {
      const [num, type] = rest.split(/\s+/);
      const t = type.toUpperCase();
      const ss = t === 'AUDIO' ? 2352 : t.includes('2048') ? 2048 : t.includes('2336') ? 2336 : 2352;
      pending = { num: parseInt(num), audio: t === 'AUDIO', sectorSize: ss, dataOffset: t.startsWith('MODE2') ? 24 : 16, source: cur!, };
      (pending as any).file = curFile;
    } else if (cmd === 'INDEX' && pending) {
      const [idx, msf] = rest.split(/\s+/);
      if (idx === '01') {
        const [mm, ss, ff] = msf.split(':').map(Number); const sec = (mm * 60 + ss) * 75 + ff;
        if ((pending as any).file !== lastFile) { fileStartSector = 0; lastFile = (pending as any).file; }
        const t = pending as Track; t.fileOffset = sec * t.sectorSize; t.startSector = sec; tracks.push(t); pending = null;
      }
    }
  }
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]; const n = tracks[i + 1];
    const end = n && n.source === t.source ? n.fileOffset : t.source.size;
    t.sectors = Math.floor((end - t.fileOffset) / t.sectorSize);
  }
  const data = tracks.find(t => !t.audio); if (!data) throw new Error('no data track');
  // data offset auto-detect for 2352 tracks
  if (data.sectorSize !== 2048) { const h = data.source.read(data.fileOffset + 15, 1); data.dataOffset = h[0] === 2 ? 24 : 16; }
  data.startSector = 0;
  const d = new Disc(data); d.tracks = tracks; d.parseFS(); return d;
}

export function bytesSource(b: Uint8Array): ByteSource { return { size: b.length, read: (o, l) => b.subarray(o, Math.min(b.length, o + l)) }; }

// An installed game folder (or a .zip of one) instead of a CD image: e.g. the 6 MB "RIP" release, which
// is a copy of an English installation with the films replaced by a tiny placeholder and empty speech
// files. Paths are relative to the folder that holds HOLIDAY.EXE.
export class FolderDisc extends Disc {
  private blobs = new Map<string, () => Uint8Array>();
  constructor() {
    const t: Track = { num: 1, audio: false, startSector: 0, sectors: 0, fileOffset: 0, sectorSize: 2048, dataOffset: 0, source: { size: 0, read: () => new Uint8Array(0) } };
    super(t); this.tracks = [t]; this.volumeLabel = 'HOLIDAY';
  }
  add(path: string, size: number, read: () => Uint8Array) {
    const p = path.toUpperCase().replace(/\//g, '\\').replace(/^\\+/, '');
    this.files.set(p, { lba: 0, size }); this.blobs.set(p, read);
    const parts = p.split('\\'); for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('\\'));
  }
  override readFile(path: string): Uint8Array | null {
    const r = this.blobs.get(path.toUpperCase().replace(/\//g, '\\').replace(/^\\+/, ''));
    return r ? r() : null;
  }
}

/** Build a FolderDisc from a file list. The game folder is the one holding HOLIDAY.EXE, at any depth
 *  (a zip usually wraps it in a folder of its own). Returns null when there is no HOLIDAY.EXE. */
export function openFolder(entries: { path: string; size: number; read: () => Uint8Array }[]): FolderDisc | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
  const exe = entries.map(e => norm(e.path)).filter(p => /(^|\/)holiday\.exe$/i.test(p)).sort((a, b) => a.length - b.length)[0];
  if (exe === undefined) return null;
  const base = exe.slice(0, exe.length - 'holiday.exe'.length).toLowerCase();
  const d = new FolderDisc();
  for (const e of entries) {
    const p = norm(e.path); if (!p.toLowerCase().startsWith(base) || p.endsWith('/')) continue;
    d.add(p.slice(base.length), e.size, e.read);
  }
  return d;
}
