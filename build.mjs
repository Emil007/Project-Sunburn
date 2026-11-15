// Build: bundles the web app (main + worker) into dist/web
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const out = 'dist/web';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, minify: process.argv.includes('--min'), sourcemap: true, target: 'es2022', loader: { '.json': 'json' }, logLevel: 'warning' };
await esbuild.build({ ...common, entryPoints: ['src/platform/main.ts'], outfile: `${out}/main.js`, format: 'esm' });
await esbuild.build({ ...common, entryPoints: ['src/platform/worker.ts'], outfile: `${out}/worker.js`, format: 'iife' });
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
for (const f of fs.readdirSync('web', { recursive: true })) {
  const p = path.join('web', f); if (fs.statSync(p).isDirectory()) continue;
  copy(p, path.join(out, f));
}
// catalogue of the built-in mods (manifest + file list)
const index = [];
for (const id of fs.readdirSync('web/mods').sort()) {
  const dir = path.join('web/mods', id); if (!fs.statSync(dir).isDirectory() || id.startsWith('_')) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
  manifest.files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).map((f) => f.split(path.sep).join('/'));
  index.push(manifest);
}
fs.writeFileSync(`${out}/mods/index.json`, JSON.stringify(index));
copy('node_modules/spessasynth_lib/dist/spessasynth_processor.min.js', `${out}/spessasynth_processor.min.js`);
fs.copyFileSync('MODDING.md', `${out}/MODDING.md`);
console.log('built', out);
