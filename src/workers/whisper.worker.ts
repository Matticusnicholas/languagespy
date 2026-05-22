/// <reference lib="webworker" />

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type PretrainedModelOptions,
  env,
} from '@huggingface/transformers';

// Always pull weights from the Hub; we cache via service worker + IDB.
env.allowLocalModels = false;
env.useBrowserCache = true;

// transformers.js sets a CDN default for wasmPaths only outside workers, so we
// pin it ourselves to the copy that vite-plugin-static-copy publishes at /ort/.
// Without this, ORT throws "no available backend found".
declare const self: DedicatedWorkerGlobalScope;

// Use the base URL from Vite to find the 'ort' directory.
const baseUrl = import.meta.env.BASE_URL;
const ortBase = new URL('ort/', new URL(baseUrl, self.location.href)).toString();

console.log(`[worker] baseUrl: ${baseUrl}`);
console.log(`[worker] ortBase: ${ortBase}`);

// @ts-expect-error — runtime ORT env, no public TS surface for nested fields
env.backends.onnx.wasm.wasmPaths = ortBase;
// @ts-expect-error — same
env.backends.onnx.wasm.numThreads = 1; 
// @ts-expect-error — same
env.backends.onnx.wasm.proxy = false; 

type LoadMsg = {
  type: 'load';
  modelId: string;
  device: 'webgpu' | 'wasm';
};

type TranscribeMsg = {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  ignoreLangs: string[];
};

type InMsg = LoadMsg | TranscribeMsg;

type OutMsg =
  | { type: 'ready' }
  | { type: 'loading'; progress: number; file?: string; status?: string }
  | { type: 'error'; error: string }
  | { type: 'result'; id: number; ignored: boolean; language: string | null; text: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let currentModelKey: string | null = null;

async function loadModel(modelId: string, device: 'webgpu' | 'wasm') {
  const key = `${modelId}|${device}`;
  if (key === currentModelKey && asr) return;

  // If WebGPU is requested but not supported, fall back immediately.
  let targetDevice = device;
  if (targetDevice === 'webgpu' && !('gpu' in navigator)) {
    console.warn('[worker] WebGPU not supported by this browser, falling back to WASM');
    targetDevice = 'wasm';
  }

  console.log(`[worker] Loading model: ${modelId} on ${targetDevice}`);

  const buildOptions = (d: 'webgpu' | 'wasm'): PretrainedModelOptions => ({
    device: d,
    dtype: d === 'webgpu' ? 'fp16' : 'q8',
    progress_callback: (data: any) => {
      if (data.status === 'progress') {
        self.postMessage({
          type: 'loading',
          progress: typeof data.progress === 'number' ? data.progress : 0,
          file: data.file,
          status: data.status,
        } satisfies OutMsg);
      } else {
        console.log(`[worker] Loading status: ${data.status} ${data.file || ''}`);
      }
    },
  });

  try {
    asr = (await pipeline(
      'automatic-speech-recognition',
      modelId,
      buildOptions(targetDevice),
    )) as unknown as AutomaticSpeechRecognitionPipeline;
    currentModelKey = `${modelId}|${targetDevice}`;
    console.log(`[worker] Model loaded successfully: ${currentModelKey}`);
  } catch (err) {
    console.error(`[worker] Failed to load model on ${targetDevice}:`, err);
    
    if (targetDevice === 'webgpu') {
      console.log('[worker] WebGPU failed, falling back to WASM...');
      self.postMessage({
        type: 'loading',
        progress: 0,
        status: 'WebGPU failed — falling back to WASM',
      } satisfies OutMsg);
      try {
        asr = (await pipeline(
          'automatic-speech-recognition',
          modelId,
          buildOptions('wasm'),
        )) as unknown as AutomaticSpeechRecognitionPipeline;
        currentModelKey = `${modelId}|wasm`;
        console.log('[worker] Model loaded successfully (WASM fallback)');
        return;
      } catch (wasmErr) {
        console.error('[worker] WASM fallback also failed:', wasmErr);
        throw wasmErr;
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
      self.postMessage({ type: 'ready' } satisfies OutMsg);
      return;
    }

    if (msg.type === 'transcribe') {
      if (!asr) throw new Error('Model not loaded');

      // Single pass: task='translate' forces English output regardless of
      // source language, and the result includes the detected language so we
      // can filter out languages the user wants to ignore (default: English).
      const out: any = await asr(msg.audio, {
        task: 'translate',
        // omit `language` -> whisper auto-detects
        return_timestamps: false,
        chunk_length_s: 30,
      } as any);

      // transformers.js returns either a single object or array depending on chunking.
      const first = Array.isArray(out) ? out[0] : out;
      const detected: string | null = first?.language ?? null;
      const text: string = (first?.text ?? '').trim();

      const ignored = !!detected && msg.ignoreLangs.includes(detected.toLowerCase());

      self.postMessage({
        type: 'result',
        id: msg.id,
        ignored,
        language: detected,
        text,
      } satisfies OutMsg);
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    } satisfies OutMsg);
  }
});

export {}; // make this a module
