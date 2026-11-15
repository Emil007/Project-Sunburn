// Mod package format (see MODDING.md)
export interface ModSetting {
  key: string; type: 'toggle' | 'select' | 'range' | 'text' | 'file';
  label: string; label_de?: string; default?: any;
  options?: { value: any; label: string; label_de?: string }[];
  min?: number; max?: number; step?: number; accept?: string;
}
export interface ModManifest {
  id: string; name: string; version?: string; author?: string; description?: string;
  name_de?: string; description_de?: string;
  category?: 'Graphics' | 'Interface' | 'Gameplay' | 'Audio' | 'Fixes' | 'Content' | string;
  languages?: ('en' | 'de')[];          // restrict to game versions (default: both)
  settings?: ModSetting[];
  script?: string;                       // runs inside the emulator (worker) with the mod API
  ui?: string;                           // runs in the UI thread (input / overlay helpers)
  shader?: string;                       // GLSL screen filter: vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize)
  soundfont?: string;                    // .sf2/.sf3 used for MIDI music
  priority?: number;                     // load order (higher = later = wins)
  recommended?: boolean; experimental?: boolean;
  conflicts?: string[];
  files?: string[];                      // filled in by the loader: every file in the package
}
export interface ActiveMod {
  manifest: ModManifest;
  files: { path: string; data: Uint8Array }[]; // package files (relative, '/' separated)
  settings: Record<string, any>;
}
