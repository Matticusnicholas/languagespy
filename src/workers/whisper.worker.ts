/// <reference lib="webworker" />

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type PretrainedModelOptions,
  env,
} from '@huggingface/transformers';

declare const self: DedicatedWorkerGlobalScope;

// Forward ANY uncaught error to the main thread so it can be displayed.
const post = (m: OutMsg) => self.postMessage(m);
const log = (msg: string, extra?: unknown) => {
  console.log(`[worker] ${msg}`, extra ?? '');
  post({ type: 'log', msg: extra !== undefined ? `${msg} ${safeStr(extra)}` : msg });
};
function safeStr(x: unknown): string {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
}

self.addEventListener('error', (e) => {
  post({ type: 'error', error: `worker error: ${e.message} @ ${e.filename}:${e.lineno}` });
});
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  post({ type: 'error', error: `unhandled rejection: ${safeStr(e.reason)}` });
});

// --- ORT setup ---
env.allowLocalModels = false;
env.useBrowserCache = true;

const baseUrl = import.meta.env.BASE_URL;
const ortBase = new URL('ort/', new URL(baseUrl, self.location.href)).toString();
const wasmUrl = `${ortBase}ort-wasm-simd-threaded.jsep.wasm`;
const mjsUrl = `${ortBase}ort-wasm-simd-threaded.jsep.mjs`;
log(`baseUrl=${baseUrl} ortBase=${ortBase}`);

try {
  // Object-form pins the exact files ORT must load, bypassing its internal
  // variant selection (which previously asked for ort-wasm-simd.wasm — a
  // non-threaded variant transformers.js doesn't ship — and 404'd).
  // The .jsep variant works for both WebGPU and pure-WASM execution.
  // @ts-expect-error — runtime ORT env, no public TS surface for nested fields
  env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
  // @ts-expect-error
  env.backends.onnx.wasm.numThreads = 1;
  // @ts-expect-error
  env.backends.onnx.wasm.proxy = false;
} catch (err) {
  log('failed to set ORT env', err);
}

// --- Message protocol ---
type LoadMsg = { type: 'load'; modelId: string; device: 'webgpu' | 'wasm' };
type TranscribeMsg = {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  ignoreLangs: string[];
};
type InMsg = LoadMsg | TranscribeMsg;

type OutMsg =
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'progress'; status: string; file?: string; progress?: number; loaded?: number; total?: number }
  | { type: 'log'; msg: string }
  | { type: 'error'; error: string }
  | { type: 'result'; id: number; ignored: boolean; language: string | null; text: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let currentModelKey: string | null = null;

async function loadModel(modelId: string, device: 'webgpu' | 'wasm') {
  const key = `${modelId}|${device}`;
  if (key === currentModelKey && asr) {
    log(`reusing model ${key}`);
    post({ type: 'ready', device });
    return;
  }

  let targetDevice = device;
  if (targetDevice === 'webgpu' && !('gpu' in self.navigator)) {
    log('WebGPU not available, using WASM');
    targetDevice = 'wasm';
  }

  const buildOptions = (d: 'webgpu' | 'wasm'): PretrainedModelOptions => ({
    device: d,
    // q4 is the most broadly-supported quantization. fp16 requires shader-f16
    // which most mobile GPUs lack; fp32 is unnecessarily large.
    dtype: d === 'webgpu' ? 'q4' : 'q8',
    progress_callback: (data: any) => {
      const status: string = data?.status ?? 'unknown';
      // Forward every event — gives the UI full visibility into where it stalls.
      post({
        type: 'progress',
        status,
        file: data?.file,
        progress: typeof data?.progress === 'number' ? data.progress : undefined,
        loaded: typeof data?.loaded === 'number' ? data.loaded : undefined,
        total: typeof data?.total === 'number' ? data.total : undefined,
      });
    },
  });

  const tryLoad = async (d: 'webgpu' | 'wasm') => {
    log(`pipeline() starting model=${modelId} device=${d}`);
    const t0 = performance.now();
    const p = (await pipeline(
      'automatic-speech-recognition',
      modelId,
      buildOptions(d),
    )) as unknown as AutomaticSpeechRecognitionPipeline;
    log(`pipeline() ready device=${d} in ${Math.round(performance.now() - t0)}ms`);
    return p;
  };

  try {
    asr = await tryLoad(targetDevice);
    currentModelKey = `${modelId}|${targetDevice}`;
    post({ type: 'ready', device: targetDevice });
  } catch (err) {
    log(`load failed on ${targetDevice}`, err instanceof Error ? err.message : err);
    if (targetDevice === 'webgpu') {
      post({ type: 'progress', status: 'fallback-wasm' });
      try {
        asr = await tryLoad('wasm');
        currentModelKey = `${modelId}|wasm`;
        post({ type: 'ready', device: 'wasm' });
        return;
      } catch (wasmErr) {
        const m = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
        throw new Error(`Both WebGPU and WASM failed. Last error: ${m}`);
      }
    }
    throw err;
  }
}

self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await loadModel(msg.modelId, msg.device);
      return;
    }

    if (msg.type === 'transcribe') {
      if (!asr) throw new Error('Model not loaded');

      const out: any = await asr(msg.audio, {
        task: 'translate',
        return_timestamps: false,
        chunk_length_s: 30,
      } as any);

      const first = Array.isArray(out) ? out[0] : out;
      const detected: string | null = first?.language ?? null;
      const text: string = (first?.text ?? '').trim();
      const ignored = !!detected && msg.ignoreLangs.includes(detected.toLowerCase());

      post({ type: 'result', id: msg.id, ignored, language: detected, text });
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    post({ type: 'error', error: m });
  }
});

log('worker module loaded');

export {};
