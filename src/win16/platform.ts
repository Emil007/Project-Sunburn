// Platform abstraction: implemented by browser worker host and node test harness.
export interface InputEvent {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'keydown' | 'keyup' | 'quit' | 'dblclick';
  x?: number; y?: number; button?: number; vk?: number; char?: number; time?: number;
}
export interface CursorImage { w: number; h: number; hx: number; hy: number; rgba: Uint8Array; id: number; }
export interface AudioOut {
  // simple sample-based mixer: channel per id
  playPCM(channel: number, pcm: Float32Array, rate: number, loop: boolean, volume: number): void;
  stopChannel(channel: number): void;
  isPlaying(channel: number): boolean;
  setMasterVolume(v: number): void;
}
export interface MidiOut {
  play(smf: Uint8Array, loop: boolean): void;
  stop(): void;
  pause(): void;
  resume(): void;
  isPlaying(): boolean;
  positionMs(): number;
  lengthMs(smf: Uint8Array): number;
  setVolume(v: number): void;
}
export interface CDAudioOut {
  playTrack(track: number, fromMs: number, toMs: number | null): void;
  stop(): void;
  isPlaying(): boolean;
  positionMs(): number;
  trackLengths(): number[]; // ms per track (index 0 = track 1)
}
export interface Platform {
  now(): number;                                // ms
  wait(ms: number): void;                       // block until event or timeout
  pollEvents(): InputEvent[];
  present(rgba: Uint8Array, w: number, h: number, palette: Uint8Array, cursor: CursorImage | null, mx: number, my: number): void;
  setCursor(c: CursorImage | null): void;
  messageBox(text: string, caption: string, type: number): number;
  log(s: string): void;
  audio: AudioOut;
  midi: MidiOut;
  cd: CDAudioOut | null;
  persist?(path: string, data: Uint8Array | null): void;   // save-game persistence hook
  setTitle?(s: string): void;
}
