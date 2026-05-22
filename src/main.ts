import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { createVad, type VadHandle } from './audio/vad';
import { Transcript } from './ui/transcript';
import {
  loadSettings,
  saveSettings,
  parseIgnoreLangs,
  type Settings,
} from './ui/settings';
import { speak, cancelSpeech } from './tts/speak';

registerSW({ immediate: true });

// --- DOM ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>('startBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const statusDot = $<HTMLSpanElement>('statusDot');
const statusText = $<HTMLSpanElement>('statusText');
const langBadge = $<HTMLSpanElement>('langBadge');
const showTextInput = $<HTMLInputElement>('showText');
const speakTtsInput = $<HTMLInputElement>('speakTts');
const modelSizeSelect = $<HTMLSelectElement>('modelSize');
const ignoreLangsInput = $<HTMLInputElement>('ignoreLangs');
const deviceSelect = $<HTMLSelectElement>('device');
const clearBtn = $<HTMLButtonElement>('clearBtn');
const downloadBtn = $<HTMLButtonElement>('downloadBtn');
const transcriptList = $<HTMLUListElement>('transcript');

const transcript = new Transcript(transcriptList);

// --- State ---
let settings: Settings = loadSettings();
let worker: Worker | null = null;
let vad: VadHandle | null = null;
let running = false;
let modelReady = false;
let nextId = 1;
const pendingChunks = new Map<number, { startedAt: number }>();

// --- Settings UI sync ---
function reflectSettingsToUI() {
  showTextInput.checked = settings.showText;
  speakTtsInput.checked = settings.speakTts;
  modelSizeSelect.value = settings.modelId;
  ignoreLangsInput.value = settings.ignoreLangs.join(',');
  deviceSelect.value = settings.device;
}

function pullSettingsFromUI(): Settings {
  return {
    showText: showTextInput.checked,
    speakTts: speakTtsInput.checked,
    modelId: modelSizeSelect.value,
    ignoreLangs: parseIgnoreLangs(ignoreLangsInput.value),
    device: deviceSelect.value as 'webgpu' | 'wasm',
  };
}

reflectSettingsToUI();

[showTextInput, speakTtsInput, modelSizeSelect, ignoreLangsInput, deviceSelect].forEach(
  (el) => {
    el.addEventListener('change', () => {
      const prev = settings;
      settings = pullSettingsFromUI();
      saveSettings(settings);
      // If model or device changed mid-session, reload the worker.
      if (
        worker &&
        (prev.modelId !== settings.modelId || prev.device !== settings.device)
      ) {
        setStatus('loading', 'Reloading model…');
        modelReady = false;
        worker.postMessage({
          type: 'load',
          modelId: settings.modelId,
          device: settings.device,
        });
      }
    });
  },
);

settingsBtn.addEventListener('click', () => settingsDialog.showModal());
clearBtn.addEventListener('click', () => transcript.clear());
downloadBtn.addEventListener('click', () => {
  const blob = new Blob([transcript.toText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `languagespy-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- Status helper ---
type StatusKind = 'idle' | 'listening' | 'busy' | 'loading' | 'error';
function setStatus(kind: StatusKind, text: string) {
  statusDot.className = `dot ${kind}`;
  statusText.textContent = text;
}

function setLangBadge(lang: string | null) {
  if (!lang) {
    langBadge.hidden = true;
    return;
  }
  langBadge.hidden = false;
  langBadge.textContent = lang;
}

// --- Worker lifecycle ---
function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./workers/whisper.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'loading') {
      const pct = Math.round((msg.progress ?? 0) * 100);
      const file = msg.file ? ` ${msg.file.split('/').pop()}` : '';
      setStatus('loading', `Downloading model…${file} ${pct}%`);
    } else if (msg.type === 'ready') {
      modelReady = true;
      if (running) {
        setStatus('listening', 'Listening');
      } else {
        setStatus('idle', 'Ready');
      }
    } else if (msg.type === 'result') {
      const pending = pendingChunks.get(msg.id);
      pendingChunks.delete(msg.id);
      if (pendingChunks.size === 0 && running) {
        setStatus('listening', 'Listening');
      }
      setLangBadge(msg.language);
      if (msg.ignored || !msg.text) return;
      // Show / speak based on user prefs.
      if (settings.showText) {
        transcript.add({ time: new Date(), language: msg.language, text: msg.text });
      }
      if (settings.speakTts) {
        speak(msg.text);
      }
      void pending; // currently unused, but useful if we add latency logging later
    } else if (msg.type === 'error') {
      console.error('[worker error]', msg.error);
      setStatus('error', `Worker error: ${msg.error}`);
    }
  });
  return worker;
}

// --- Start / Stop ---
async function start() {
  startBtn.disabled = true;
  try {
    const w = ensureWorker();
    if (!modelReady) {
      setStatus('loading', 'Loading model…');
      w.postMessage({
        type: 'load',
        modelId: settings.modelId,
        device: settings.device,
      });
      // Wait for ready (handled in message listener — but we also need to await VAD perms)
    }

    // VAD also asks for mic permission. Spin it up in parallel with model load.
    if (!vad) {
      vad = await createVad({
        onSpeechStart: () => {
          // Mostly used for indicator flash; not strictly needed.
        },
        onSpeechEnd: (audio) => {
          if (!modelReady || !worker) return;
          const id = nextId++;
          pendingChunks.set(id, { startedAt: performance.now() });
          if (running) setStatus('busy', 'Transcribing…');
          worker.postMessage({
            type: 'transcribe',
            id,
            audio,
            ignoreLangs: settings.ignoreLangs,
          });
        },
        onMisfire: () => {
          // ignore — too short / noise
        },
        onError: (err) => {
          console.error('[vad error]', err);
          setStatus('error', 'VAD error — check mic permission');
        },
      });
    }

    vad.start();
    running = true;
    startBtn.textContent = 'Stop';
    startBtn.classList.add('stop');
    if (modelReady) setStatus('listening', 'Listening');
  } catch (err) {
    console.error(err);
    setStatus('error', err instanceof Error ? err.message : String(err));
  } finally {
    startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  vad?.pause();
  cancelSpeech();
  startBtn.textContent = 'Start Listening';
  startBtn.classList.remove('stop');
  setStatus('idle', 'Idle');
}

startBtn.addEventListener('click', () => {
  if (running) stop();
  else void start();
});

// Show a one-time warning if WebGPU isn't available and device pref is webgpu.
(async () => {
  if (settings.device === 'webgpu' && !('gpu' in navigator)) {
    setStatus(
      'idle',
      'WebGPU not available — switch to WASM in settings (slower but works).',
    );
  } else {
    setStatus('idle', 'Idle');
  }
})();
