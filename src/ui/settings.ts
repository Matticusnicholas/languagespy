export interface Settings {
  showText: boolean;
  speakTts: boolean;
  modelId: string;
  ignoreLangs: string[];
  device: 'webgpu' | 'wasm';
}

const KEY = 'languagespy:settings:v1';

export const defaultSettings: Settings = {
  showText: true,
  speakTts: true,
  modelId: 'onnx-community/whisper-tiny',
  ignoreLangs: ['en'],
  device: 'webgpu',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw);
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function parseIgnoreLangs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
