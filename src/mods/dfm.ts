// Delphi 1 binary form (TPF0) reader/writer, used by mods to edit form layouts.
export type DfmValue =
  | { t: 'int'; v: number } | { t: 'ext'; raw: Uint8Array } | { t: 'str'; v: string } | { t: 'ident'; v: string }
  | { t: 'bool'; v: boolean } | { t: 'nil' } | { t: 'set'; v: string[] } | { t: 'list'; v: DfmValue[] }
  | { t: 'bin'; raw: Uint8Array } | { t: 'coll'; v: { index?: DfmValue; props: [string, DfmValue][] }[] }
  | { t: 'lstr'; v: string };
export interface DfmComponent { cls: string; name: string; props: [string, DfmValue][]; children: DfmComponent[]; }

const dec = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

export function parseDfm(b: Uint8Array): DfmComponent {
  if (dec(b.subarray(0, 4)) !== 'TPF0') throw new Error('not a TPF0 form');
  let p = 4;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const u8 = () => b[p++];
  const sstr = () => { const l = u8(); const s = dec(b.subarray(p, p + l)); p += l; return s; };
  const value = (): DfmValue => {
    const t = u8();
    switch (t) {
      case 0: return { t: 'nil' };
      case 1: { const v: DfmValue[] = []; while (b[p] !== 0) v.push(value()); p++; return { t: 'list', v }; }
      case 2: { const v = dv.getInt8(p); p += 1; return { t: 'int', v }; }
      case 3: { const v = dv.getInt16(p, true); p += 2; return { t: 'int', v }; }
      case 4: { const v = dv.getInt32(p, true); p += 4; return { t: 'int', v }; }
      case 5: { const raw = b.slice(p, p + 10); p += 10; return { t: 'ext', raw }; }
      case 6: return { t: 'str', v: sstr() };
      case 7: return { t: 'ident', v: sstr() };
      case 8: return { t: 'bool', v: false };
      case 9: return { t: 'bool', v: true };
      case 10: { const l = dv.getUint32(p, true); const raw = b.slice(p + 4, p + 4 + l); p += 4 + l; return { t: 'bin', raw }; }
      case 11: { const v: string[] = []; for (;;) { const s = sstr(); if (!s) break; v.push(s); } return { t: 'set', v }; }
      case 12: { const l = dv.getUint32(p, true); const s = dec(b.subarray(p + 4, p + 4 + l)); p += 4 + l; return { t: 'lstr', v: s }; }
      case 13: return { t: 'nil' };
      case 14: {
        const v: { index?: DfmValue; props: [string, DfmValue][] }[] = [];
        while (b[p] !== 0) {
          let index: DfmValue | undefined; if (b[p] === 2 || b[p] === 3 || b[p] === 4) index = value();
          const props: [string, DfmValue][] = []; while (b[p] !== 0) props.push([sstr(), value()]); p++;
          v.push({ index, props });
        }
        p++; return { t: 'coll', v };
      }
    }
    throw new Error(`unknown DFM value type ${t} at ${p - 1}`);
  };
  const comp = (): DfmComponent => {
    const cls = sstr(), name = sstr(); const props: [string, DfmValue][] = [];
    while (b[p] !== 0) props.push([sstr(), value()]); p++;
    const children: DfmComponent[] = []; while (b[p] !== 0) children.push(comp()); p++;
    return { cls, name, props, children };
  };
  return comp();
}

export function writeDfm(root: DfmComponent): Uint8Array {
  const out: number[] = [0x54, 0x50, 0x46, 0x30];
  const sstr = (s: string) => { out.push(s.length); for (const c of s) out.push(c.charCodeAt(0) & 0xff); };
  const i16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const i32 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const value = (v: DfmValue) => {
    switch (v.t) {
      case 'nil': out.push(0); break;
      case 'list': out.push(1); v.v.forEach(value); out.push(0); break;
      case 'int': if (v.v >= -128 && v.v <= 127) out.push(2, v.v & 0xff); else if (v.v >= -32768 && v.v <= 32767) { out.push(3); i16(v.v); } else { out.push(4); i32(v.v); } break;
      case 'ext': out.push(5, ...v.raw); break;
      case 'str': out.push(6); sstr(v.v); break;
      case 'ident': out.push(7); sstr(v.v); break;
      case 'bool': out.push(v.v ? 9 : 8); break;
      case 'bin': out.push(10); i32(v.raw.length); out.push(...v.raw); break;
      case 'set': out.push(11); v.v.forEach(sstr); out.push(0); break;
      case 'lstr': out.push(12); i32(v.v.length); for (const c of v.v) out.push(c.charCodeAt(0) & 0xff); break;
      case 'coll': out.push(14); for (const it of v.v) { if (it.index) value(it.index); for (const [k, x] of it.props) { sstr(k); value(x); } out.push(0); } out.push(0); break;
    }
  };
  const comp = (c: DfmComponent) => {
    sstr(c.cls); sstr(c.name);
    for (const [k, v] of c.props) { sstr(k); value(v); }
    out.push(0);
    c.children.forEach(comp); out.push(0);
  };
  comp(root);
  return Uint8Array.from(out);
}

// friendly helpers for mods: plain JS values
export function toJs(v: DfmValue): any {
  switch (v.t) {
    case 'int': case 'str': case 'ident': case 'bool': case 'lstr': return v.v;
    case 'set': return v.v;
    case 'list': return v.v.map(toJs);
    default: return undefined;
  }
}
export function fromJs(x: any, like?: DfmValue): DfmValue {
  if (like?.t === 'ident' && typeof x === 'string') return { t: 'ident', v: x };
  if (typeof x === 'number') return { t: 'int', v: x | 0 };
  if (typeof x === 'boolean') return { t: 'bool', v: x };
  if (Array.isArray(x)) return { t: 'set', v: x.map(String) };
  if (typeof x === 'string') return /^(cl|bs|ws|fs|po|al|bv|crs?|ta)[A-Z]/.test(x) ? { t: 'ident', v: x } : { t: 'str', v: x };
  return { t: 'nil' };
}
export function findComponent(root: DfmComponent, name: string): DfmComponent | null {
  if (root.name.toLowerCase() === name.toLowerCase() || root.cls.toLowerCase() === name.toLowerCase()) return root;
  for (const c of root.children) { const r = findComponent(c, name); if (r) return r; }
  return null;
}
export function setProp(c: DfmComponent, key: string, val: any) {
  const i = c.props.findIndex(([k]) => k.toLowerCase() === key.toLowerCase());
  if (val === undefined || val === null) { if (i >= 0) c.props.splice(i, 1); return; }
  if (i >= 0) c.props[i][1] = fromJs(val, c.props[i][1]); else c.props.push([key, fromJs(val)]);
}
export function getProp(c: DfmComponent, key: string): any {
  const p = c.props.find(([k]) => k.toLowerCase() === key.toLowerCase()); return p ? toJs(p[1]) : undefined;
}
