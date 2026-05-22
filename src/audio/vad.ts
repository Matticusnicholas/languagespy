import { MicVAD } from '@ricky0123/vad-web';

export interface VadEvents {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onMisfire?: () => void;
  onError?: (err: unknown) => void;
}

export interface VadHandle {
  start: () => void;
  pause: () => void;
  destroy: () => Promise<void>;
}

const MIN_CHUNK_SAMPLES = 16000 * 0.6; // 600ms at 16kHz
const MAX_CHUNK_SAMPLES = 16000 * 15;  // 15s cap

export async function createVad(events: VadEvents): Promise<VadHandle> {
  // vite-plugin-static-copy puts the worklet + Silero model + ORT WASM files at
  // the site root; vad-web fetches them from `${baseAssetPath}<filename>`.
  const base = import.meta.env.BASE_URL;

  const vad = await MicVAD.new({
    model: 'v5',
    // Silero VAD v5 thresholds tuned for "eavesdropping at moderate distance".
    positiveSpeechThreshold: 0.55,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 4,
    redemptionFrames: 12, // ~380ms of silence ends a chunk
    preSpeechPadFrames: 4,
    baseAssetPath: base,
    onnxWASMBasePath: base,
    onSpeechStart: () => events.onSpeechStart?.(),
    onSpeechEnd: (audio) => {
      if (audio.length < MIN_CHUNK_SAMPLES) {
        events.onMisfire?.();
        return;
      }
      if (audio.length > MAX_CHUNK_SAMPLES) {
        events.onSpeechEnd?.(audio.subarray(0, MAX_CHUNK_SAMPLES));
        return;
      }
      events.onSpeechEnd?.(audio);
    },
    onVADMisfire: () => events.onMisfire?.(),
  });

  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: async () => vad.destroy(),
  };
}
