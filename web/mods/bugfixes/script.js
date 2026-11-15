// Tolerate the apostrophe mismatch between requested and installed file names.
api.onFile((drive, path) => {
  if (!path.includes("'")) return null;
  const fixed = api.win16.vfs.fs(drive)?.read(path.replace(/'/g, ''));
  return fixed || null;
});
