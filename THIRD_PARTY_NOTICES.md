# Third-party components

| Component | Used for | License | Where |
|---|---|---|---|
| **GeneralUser GS v2.0.3** SoundFont by S. Christian Collins | MIDI music | GeneralUser GS License v2.0 (free use and redistribution) | `web/soundfont/GeneralUser-GS.sf2`, license in `web/soundfont/LICENSE.txt` |
| **DejaVu Sans** glyphs (rendered to bitmaps by `tools/genfont.py`) | Windows system fonts | Bitstream Vera Fonts license + public-domain DejaVu changes | `src/win16/fontdata.json` |
| **spessasynth_lib** | SoundFont synthesizer (bundled into the build) | Apache-2.0 | npm dependency |
| **fflate** | Reading mod `.zip` files (bundled into the build) | MIT | npm dependency |
| **Electron**, **electron-builder** | Desktop apps (Windows, macOS, Linux) | MIT | npm dependency of `electron/` |
| **esbuild**, **TypeScript** | Build tools (not shipped) | MIT, Apache-2.0 | npm dev dependencies |

## Holiday Island

Holiday Island © 1996 Sunflowers Interactive Entertainment Software. This repository contains **no**
code, graphics, sound, music, video or text from the game. Players load the game from their own
CD image at runtime.

The bug-fix and large-view mods locate places in the game program by short byte patterns (a few
machine-code bytes each), as debuggers and trainers do. They change the game in memory while it
runs and never modify or redistribute the game files.

## DejaVu / Bitstream Vera license (summary)

Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of
Bitstream, Inc. DejaVu changes are in the public domain. Permission is granted to use, copy,
merge, publish, distribute and/or sell copies of the fonts, and to modify them, subject to the
conditions of the Bitstream Vera license (the fonts may not be sold by themselves; modified
versions must be renamed). Full text: https://dejavu-fonts.github.io/License.html
