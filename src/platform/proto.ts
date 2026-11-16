// Shared memory protocol between UI thread and emulator worker
export const CTRL = {
  EVSEQ: 0, EVWRITE: 1, EVREAD: 2, FRAMESEQ: 3, MSGBOX: 4, QUIT: 5, FRAMEW: 6, FRAMEH: 7,
  CURSORSEQ: 8, CURSORW: 9, CURSORH: 10, CURSORHX: 11, CURSORHY: 12, CURSORVIS: 13, MOUSEX: 14, MOUSEY: 15,
  PAUSE: 16, SPEED: 17,
  // part of the game screen the player can currently see (window smaller than the game screen)
  VIEWSEQ: 18, VIEWX: 19, VIEWY: 20, VIEWW: 21, VIEWH: 22,
  // watchdog: heartbeat counter, API currently running (+1, 0 = none) and where it was called from
  HEART: 23, APINOW: 24, APICS: 25, APIIP: 26, GAMECS: 27, GAMEIP: 28,
  // watchdog: UI asks the (busy) worker for a state dump
  DUMPREQ: 29,
};
export const EV_BASE = 64, EV_SIZE = 8, EV_CAP = 512;
export const CTRL_INTS = EV_BASE + EV_SIZE * EV_CAP;
export const EVT = { mousemove: 1, mousedown: 2, mouseup: 3, keydown: 4, keyup: 5, quit: 6, modcmd: 7 } as const;
export const FRAME_MAX = 3840 * 2160 * 4;
export const CURSOR_MAX = 64 * 64 * 4;

export interface StartConfig {
  t: 'start';
  ctrlSab: SharedArrayBuffer; frameSab: SharedArrayBuffer; cursorSab: SharedArrayBuffer;
  files: { name: string; file: Blob }[];   // disc image files
  saves: { path: string; data: Uint8Array }[];
  videoHi: boolean; soundHi: boolean; screenW: number; screenH: number;
  mods?: import('../mods/types').ActiveMod[];  // enabled mods, in load order
  host?: { w: number; h: number };           // player's window size (CSS px)
}

export type WorkerMsg =
  | { t: 'ready'; lang: string; tracks: { num: number; audio: boolean; sectors: number }[] }
  | { t: 'pcm'; id: number; data: Float32Array; rate: number; channels: number }
  | { t: 'play'; ch: number; id: number; loop: boolean; vol: number; offset?: number }
  | { t: 'stop'; ch: number }
  | { t: 'mastervol'; v: number }
  | { t: 'midi'; op: 'play' | 'stop' | 'pause' | 'resume' | 'vol'; data?: Uint8Array; v?: number }
  | { t: 'cd'; op: 'play' | 'stop'; from?: number; to?: number | null }
  | { t: 'msgbox'; text: string; caption: string; type: number }
  | { t: 'persist'; path: string; data: Uint8Array | null }
  | { t: 'title'; s: string }
  | { t: 'log'; s: string }
  | { t: 'exit'; code: number }
  | { t: 'crash'; msg: string; detail: string }
  | { t: 'probe'; ok: boolean; lang?: string; label?: string; error?: string };
