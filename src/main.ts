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

// --- Error banner (visible, dismissible) ---
const errBanner = document.createElement('div');
errBanner.className = 'err-banner';
errBanner.hidden = true;
document.getElementById('app')!.prepend(errBanner);
function showError(msg: string) {
  errBanner.textContent = `⚠ ${msg} (tap to dismiss)`;
  errBanner.hidden = false;
}
errBanner.addEventListener('click', () => (errBanner.hidden = true));

// --- Debug log panel ---
const logPanel = document.createElement('details');
logPanel.className = 'log-panel';
logPanel.innerHTML = '<summary>Debug log</summary><pre></pre>';
document.getElementById('app')!.append(logPanel);
const logPre = logPanel.querySelector('pre')!;
const logBuf: string[] = [];
function dlog(s: string) {
  const stamp = new Date().toISOString().substr(11, 12);
  logBuf.push(`${stamp} ${s}`);
  if (logBuf.length > 200) logBuf.shift();
  logPre.textContent = logBuf.join('\n');
  // eslint-disable-next-line no-console
  console.log('[ui]', s);
}

// --- State ---
let settings: Settings = loadSettings();
let worker: Worker | null = null;
let vad: VadHandle | null = null;
let running = false;
let modelReady = false;
let nextId = 1;
const pendingChunks = new Map<number, { startedAt: number }>();
let lastProgressAt = 0;
let watchdog: number | null = null;

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
  const text = transcript.toText() + '\n\n--- DEBUG LOG ---\n' + logBuf.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
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

// --- Watchdog: detect stuck downloads ---
function bumpProgress() {
  lastProgressAt = performance.now();
}
function startWatchdog() {
  bumpProgress();
  if (watchdog !== null) return;
  watchdog = window.setInterval(() => {
    if (modelReady) return;
    const idle = performance.now() - lastProgressAt;
    if (idle > 20_000) {
      dlog(`watchdog: no progress for ${Math.round(idle / 1000)}s`);
      setStatus('error', `No download progress in ${Math.round(idle / 1000)}s — see Debug log`);
      showError(
        'Model download is stuck. Try: open Settings, switch Device to WASM, then tap Start again. If still stuck, you may have a flaky connection or the HF CDN is being slow.',
      );
    }
  }, 5000);
}
function stopWatchdog() {
  if (watchdog !== null) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

// --- Worker lifecycle ---
function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./workers/whisper.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker = w;

  w.addEventListener('error', (e) => {
    dlog(`worker error event: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    showError(`Worker crashed: ${e.message}`);
    setStatus('error', 'Worker crashed — see banner');
  });
  w.addEventListener('messageerror', (e) => {
    dlog(`worker messageerror: ${String(e.data)}`);
  });

  w.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'log') {
      dlog(`worker: ${msg.msg}`);
    } else if (msg.type === 'progress') {
      bumpProgress();
      const file = msg.file ? ` ${String(msg.file).split('/').pop()}` : '';
      const pct = typeof msg.progress === 'number' ? ` ${Math.round(msg.progress * 100)}%` : '';
      const size =
        typeof msg.loaded === 'number' && typeof msg.total === 'number'
          ? ` (${(msg.loaded / 1e6).toFixed(1)}/${(msg.total / 1e6).toFixed(1)}MB)`
          : '';
      const label = `${msg.status}${file}${pct}${size}`;
      dlog(`progress: ${label}`);
      setStatus('loading', label);
    } else if (msg.type === 'ready') {
      stopWatchdog();
      modelReady = true;
      dlog(`model ready on ${msg.device}`);
      if (running) setStatus('listening', 'Listening');
      else setStatus('idle', `Ready (${msg.device})`);
    } else if (msg.type === 'result') {
      pendingChunks.delete(msg.id);
      if (pendingChunks.size === 0 && running) setStatus('listening', 'Listening');
      setLangBadge(msg.language);
      if (msg.ignored || !msg.text) return;
      if (settings.showText) {
        transcript.add({ time: new Date(), language: msg.language, text: msg.text });
      }
      if (settings.speakTts) speak(msg.text);
    } else if (msg.type === 'error') {
      stopWatchdog();
      dlog(`error: ${msg.error}`);
      showError(msg.error);
      setStatus('error', msg.error.slice(0, 60));
    }
  });

  return w;
}

// --- Start / Stop ---
async function start() {
  errBanner.hidden = true;
  startBtn.disabled = true;
  try {
    const w = ensureWorker();
    if (!modelReady) {
      setStatus('loading', 'Initializing…');
      startWatchdog();
      w.postMessage({
        type: 'load',
        modelId: settings.modelId,
        device: settings.device,
      });
    }

    if (!vad) {
      vad = await createVad({
        onSpeechStart: () => {},
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
        onMisfire: () => {},
        onError: (err) => {
          dlog(`vad error: ${String(err)}`);
          showError(`VAD error: ${String(err)}`);
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
    const m = err instanceof Error ? err.message : String(err);
    dlog(`start failed: ${m}`);
    showError(m);
    setStatus('error', m);
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

dlog(`UA: ${navigator.userAgent}`);
dlog(`webgpu available: ${'gpu' in navigator}`);
dlog(`settings: ${JSON.stringify(settings)}`);

if (settings.device === 'webgpu' && !('gpu' in navigator)) {
  setStatus('idle', 'WebGPU not available — open Settings, choose WASM.');
} else {
  setStatus('idle', 'Idle');
}
