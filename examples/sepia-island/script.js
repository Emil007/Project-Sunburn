// Runs inside the emulator before the game starts.
api.log(`sepia-island active, game language: ${api.lang}`);

// Serve a sepia-toned copy of the main window's title bar. The game uses a fixed 256-colour
// palette, so instead of changing the palette we re-point every pixel to the palette entry
// closest to its sepia tone.
api.onFile((drive, path, read) => {
  if (!/\\MENULEI3\.BMP$/.test(path)) return null;
  const orig = read();   // the original file (or what an earlier mod made of it)
  if (!orig) return null;
  const bmp = orig.slice();
  const dv = new DataView(bmp.buffer);
  const pixOff = dv.getUint32(10, true), palOff = 14 + dv.getUint32(14, true), colors = dv.getUint32(46, true) || 256;
  if (dv.getUint16(28, true) !== 8) return null;           // only 8-bit bitmaps
  const pal = [];
  for (let i = 0; i < colors; i++) pal.push([bmp[palOff + i * 4 + 2], bmp[palOff + i * 4 + 1], bmp[palOff + i * 4]]);
  const map = pal.map(([r, g, b]) => {
    const t = [r * .393 + g * .769 + b * .189, r * .349 + g * .686 + b * .168, r * .272 + g * .534 + b * .131];
    let best = 0, bd = Infinity;
    pal.forEach((p, j) => { const d = (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2; if (d < bd) { bd = d; best = j; } });
    return best;
  });
  for (let i = pixOff; i < bmp.length; i++) bmp[i] = map[bmp[i]];
  return bmp;
});
