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

  const options: PretrainedModelOptions = {
    device,
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    progress_callback: (data: any) => {
      // Forward HF download progress so the UI can show "Downloading model…"
      self.postMessage({
        type: 'loading',
        progress: typeof data.progress === 'number' ? data.progress : 0,
        file: data.file,
        status: data.status,
      } satisfies OutMsg);
    },
  };

  asr = (await pipeline(
    'automatic-speech-recognition',
    modelId,
    options,
  )) as unknown as AutomaticSpeechRecognitionPipeline;
  currentModelKey = key;
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
