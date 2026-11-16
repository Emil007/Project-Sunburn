# Modding Holiday Island (Project Sunburn)

Every change this port makes to the 1996 game is a **mod**. With all mods switched off you get
the original game as it shipped. Bigger view, screen filters, comfort features and bug fixes are
all mods, and you can write your own in the same format.

A mod is a folder (or a `.zip` of that folder) with a `mod.json` and the files it needs. Players add
it in the launcher (**Mods → Add mod (.zip)… / Add mod folder…**), switch it on and change its
settings there. Installed mods stay in the browser's private storage (or the desktop app's
profile) and never touch the game disc.

```
my-mod/
├── mod.json        manifest (required)
├── script.js       runs inside the emulator: patch code, replace files, hook Windows calls
├── ui.js           runs in the page: input helpers, overlays
├── filter.glsl     screen filter
├── music.sf2       SoundFont for the MIDI music
├── cd/…            files that replace or add files on the game CD   (drive D:)
└── hd/…            files that replace or add files in the installation (C:\HOLIDAY)
```

Every part is optional. A mod can be nothing but a few replacement bitmaps.

The built-in mods are in `mods/` in the source tree. They're the best examples.

---

## mod.json

```json
{
  "id": "sepia-island",
  "name": "Sepia island",
  "name_de": "Sepia-Insel",
  "version": "1.0",
  "author": "you",
  "category": "Graphics",
  "description": "Old-photo look.",
  "description_de": "Alter-Foto-Look.",
  "languages": ["en", "de"],
  "shader": "sepia.glsl",
  "script": "script.js",
  "ui": "ui.js",
  "soundfont": "music.sf2",
  "priority": 0,
  "conflicts": ["display-filter"],
  "experimental": false,
  "settings": [
    { "key": "amount", "type": "range", "label": "Strength", "label_de": "Stärke", "min": 0, "max": 100, "default": 80 }
  ]
}
```

| field | meaning |
|---|---|
| `id` | unique, lowercase `a-z 0-9 . _ -`. Installing a mod with an existing id replaces it. Built-in ids are reserved. |
| `name`, `description` (+ `_de`) | shown in the launcher. German text is optional. |
| `category` | `Graphics`, `Interface`, `Gameplay`, `Audio`, `Fixes`, `Content` (anything else is listed under *Other*). |
| `languages` | which game versions the mod works with: `"en"` (English CD) and/or `"de"` (German CD). Leave it out if it works with both. |
| `script`, `ui`, `shader`, `soundfont` | file names inside the package (see below). |
| `priority` | load order. Higher loads later and wins: last file override, last screen filter, last SoundFont. |
| `conflicts` | ids of mods that can't run together with this one. Switching one on switches the others off. |
| `experimental`, `recommended` | badges in the launcher. *Recommended* mods are on in the "Recommended" preset. |

### Settings

Settings are shown under the mod's switch and passed to all of its parts.

| type | value | extra fields |
|---|---|---|
| `toggle` | `true`/`false` | |
| `select` | the chosen option's `value` | `options: [{ "value": "a", "label": "A", "label_de": "A" }]` |
| `range` | number | `min`, `max`, `step` |
| `text` | string | |
| `file` | the chosen file's name. The file itself is `@setting/<key>` in the mod's files. | `accept`, e.g. `".sf2,.sf3"` |

All of them take `label`, optional `label_de` and `default`. Add `"when": { "style": "crt" }` to
show a setting only while other settings of the mod have those values.

Settings take effect when the game starts.

---

## Replacing game files: `cd/` and `hd/`

Anything under `cd/` overlays the CD (drive `D:`), anything under `hd/` the installation
(`C:\HOLIDAY`). Paths are case-insensitive:

```
cd/GRAFIK/BUTTON.BMP        → D:\GRAFIK\BUTTON.BMP   (toolbar)
cd/TEXTE/…                  → texts
cd/SOUND/…  cd/MUSIK/…      → sounds, MIDI music
hd/…                        → files the installer copies to the hard disk
```

The game was made for 256-colour Windows 3.1, so keep the file format of the original. Bitmaps
should be **8-bit palettised BMPs** with the same palette as the file they replace; the game
remaps them to its palette. Sizes may differ where the game takes the size from the file, which
works for most window backgrounds but not for sprite sheets.

Use a script (`api.onFile`) if the replacement has to be computed, for example built from
the original file.

---

## Screen filters (`shader`)

A filter is one GLSL ES 3.00 function that turns the game's screen texture into the output pixel:

```glsl
uniform float u_amount;            // setting "amount" → uniform u_amount
vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  vec3 c = texture(tex, uv).rgb;
  vec3 s = vec3(dot(c, vec3(.393, .769, .189)), dot(c, vec3(.349, .686, .168)), dot(c, vec3(.272, .534, .131)));
  return vec4(mix(c, s, u_amount / 100.0), 1.0);
}
```

* `uv` – 0..1 position in the game screen; `texSize` – game resolution (640×480 or what a mod set);
  `outSize` – size of the picture on the player's display in device pixels.
* The texture is sampled with linear filtering. Snap to `(floor(uv*texSize)+.5)/texSize` for
  nearest-neighbour.
* Range, toggle and numeric select settings arrive as `uniform float u_<key>` (toggles: 0/1).
* Only one filter runs at a time: the enabled one with the highest `priority`. Declare the other
  filters in `conflicts` so the launcher switches them off.
* One mod can offer several filters: write the file name with a setting in braces, e.g.
  `"shader": "{style}.glsl"` and a select setting `style` with the values `sharp`, `crt`, …
  (the built-in *Screen filter* mod works this way).
* If the shader doesn't compile, the game runs without a filter and the error is in the browser
  console (F12).

---

## Emulator scripts (`script`)

`script.js` runs once when the game starts, inside the emulator's worker, **before the game's code
is loaded**. It gets one object, `api`:

```js
api.id, api.lang                    // mod id; 'en' or 'de' (the inserted disc)
api.settings                        // { key: value } of this mod
api.host                            // { w, h } size of the player's window in CSS pixels
api.log('text')                     // browser console, prefixed with the mod id
api.file('path'), api.text('path')  // bytes / text of a file in the mod package
api.setScreenSize(w, h)             // Windows desktop size (640×480 … 3840×2160)
api.compositor({ shadows, fadeMs, dim, trueColorVideo })   // window effects
api.toUI(data)                      // message to this mod's ui.js (api.onMessage)

api.onFile((drive, path, read) => bytes | null)   // serve or replace any file read by the game
api.onLoad((ctx) => { … })          // the EXE is in memory: patch code/data, edit forms
api.onStart(() => { … })            // right before the game's first instruction
api.onTick((ms) => { … })           // ~ every few ms of game time
api.wrapApi('USER.MessageBox', (args, orig) => orig(args))   // hook a Windows API function
api.mem      // { r8, r16, w8, w16, lin, ds(), seg(n) } – 16-bit memory (selector:offset)
api.win16    // the whole emulator (advanced; internal, may change)
api.windows()  // [{ h, cls, x, y, w, h_, visible, setPos(x,y,w,h) }] all game windows
api.postKey(vk)  // send a key press to the game
api.call(sel, off, args)  // call a far function of the game, e.g. api.call(seg.sel, 0x2bae, [[ptr32, 4]])
                          // args: [value, 2 or 4] pairs in Pascal order (pushed first to last); returns DX:AX as one number
api.disk     // { list(dir), read(path), remove(path) } the game's C: drive (saves); changes are persisted
api.setSpeed(f, ms)  // the player's speed factor 0.25 … 100 for the timers with interval ms (0: all timers under 500 ms)
api.holdSpeed(f, ms) // hold the speed for a while (0 = stopped); holdSpeed(null) lets go and the player's speed is back
api.onDraw((px, w, h) => { … })  // draw on top of each presented frame (Uint32Array RGBA, w×h)
api.onInput((e) => consumed)     // see input before the game: { type, x, y, button, vk }; return true to swallow it
api.redraw()     // present a new frame now (e.g. after your onDraw output changed)
api.getSpeed()   // the player's speed factor (set with api.setSpeed); api.speedNow is what runs now, api.speedHeld whether a mod holds it
api.onCommand((cmd, arg) => { … })  // commands from this mod's ui.js (api.command)
api.mem.u8      // all of the emulator's memory as a Uint8Array (api.mem.lin(sel, off) gives the index)
```

`onFile` paths are upper-case and drive-relative, e.g. `drive === 'D'`, `path === 'GRAFIK\\BUTTON.BMP'`.
Return `null` to pass. `read()` returns the file as it would be served without you: the original, or what a mod loaded before yours made of it. Hooks of several mods chain, so a mod can recolour a bitmap that another mod widened.

`wrapApi` names are `MODULE.Function` as Windows 3.1 exports them (`USER`, `GDI`, `KERNEL`,
`MMSYSTEM`, `WAVEMIX`, …). `args` are the 16-bit stack arguments in Pascal order; far pointers come as
one 32-bit `seg:off` value. Example from **skip-intros**: completing `MCI_PLAY` of a video
immediately.

### Patching the game (`onLoad`)

```js
api.onLoad((ctx) => {
  const hits = ctx.find('c7 06 bc 12 70 02');        // byte signature, ?? = wildcard, optional segment
  for (const h of hits) ctx.patch(h.seg, h.off + 4, '70 02', '00 05');   // expect (or null), replacement
  const b = ctx.read(h.seg, h.off, 6);                // Uint8Array
  const code = ctx.allocCode('b8 01 00 cb');          // {sel, off} of new far code (mov ax,1; retf)
  const data = ctx.allocData(256);                    // {sel, off, lin} zeroed memory
  const ds = api.mem.ds();                            // the game's data segment selector
  ctx.editForm('TGeldmenuform', (f) => {              // Delphi form resources (DFM)
    f.component('Button1')?.set('Caption', 'Pay!');
  });
  const dat = ctx.readFile('D:\\DATA\\DARSTELL.DAT');
});
```

Rules that keep mods working for everyone:

* **Find code by signature, not by address.** The English and German EXEs differ. Include
  enough bytes to be unique and check the hit count. If it isn't what you expect, log and leave
  everything alone. **large-view** is a big worked example.
* Don't change what's stored in savegames, so saves stay loadable without the mod. Keep the
  original data and point the code at your own copy (`allocData`).
* `patch` with an `expect` string refuses to write if the bytes differ (e.g. another mod got there
  first).

### Forms

`ctx.editForm(name, fn)` gives you the parsed DFM: `f.components()` lists every component with
`name`, `cls`, `get(prop)`, `set(prop, value)`. Values are numbers, strings, booleans, identifiers
(`'bsNone'`), sets (`['akLeft']`) and binary data (`Uint8Array`, e.g. `Picture.Data`). The game
often moves controls in code after loading the form, so check what you see in the game.

---

## Page scripts (`ui`)

`ui.js` runs in the web page (not in the emulator):

```js
api.settings, api.lang, api.log(...)
api.onWheel((dy, dx, shift) => handled)   // mouse wheel over the game; return true to consume
api.onMouse((type, x, y, button) => handled)  // 'down' | 'move' | 'up' in game coordinates; return true to keep it from the game
api.tapKey(vk), api.key(vk, down)         // keyboard input to the game (Windows virtual-key codes)
api.click(x, y, button)                   // mouse click at game coordinates
api.every(ms, fn)                         // repeating timer while the game runs
api.mouse()                               // { x, y, inside } in game coordinates
api.screen()                              // { w, h } game resolution
api.visible()                             // { x, y, w, h } part of the screen inside the window
api.file(path), api.text(path)            // files of the mod package
api.onMessage((data) => …)                // data sent by the mod's script.js via api.toUI
api.command(cmd, arg)                     // two whole numbers for the mod's script.js (api.onCommand)
api.onKey((e) => handled)                 // keyboard events before the game; return true to keep them from the game
api.overlay()                             // a <div> over the game (pointer-events: none) for your own HTML
api.window({ title, width, side })      // a window in the game's style, moved by its title bar: { body, show(), hide(), toggle(), shown, title(s) }
```

---

## SoundFonts

Set `"soundfont": "music.sf2"` (`.sf2` or `.sf3`) and the MIDI music plays with it instead of the
bundled GeneralUser GS. **custom-soundfont** does the same with a file the player picks.

---

## Packaging and testing

1. Put the files in a folder with `mod.json` at the top and zip it (the zip may also contain the
   folder itself).
2. In the launcher: **Mods → Add mod (.zip)…**, switch it on, start the game.
3. Open the developer tools (F12 in the browser; Ctrl+Shift+I in the desktop app) to see
   `api.log` output and errors.
4. To update a mod, add it again with the same `id`.

The engine also has a command-line harness for automated tests (`src/test/harness.ts`):
`node build/harness.js --disc game.iso --mods my-mod={"amount":50} --ms 60000 --shotEvery 5000 --out shots`.
For that, the mod has to be in the source tree's `web/mods/<id>`.
