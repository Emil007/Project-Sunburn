// Copies the web build into electron/web (without source maps) for electron-builder.
import fs from 'fs';
import path from 'path';
const src = 'dist/web', dst = 'electron/web';
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith('.map') });
fs.copyFileSync('MODDING.md', path.join(dst, 'MODDING.md'));
console.log('prepared', dst);
