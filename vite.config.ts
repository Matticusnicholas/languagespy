import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// GitHub Pages serves from /<repo>/. Override with VITE_BASE if your repo name differs.
const base = process.env.VITE_BASE ?? '/languagespy/';

export default defineConfig({
  base,
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', '@ricky0123/vad-web', 'onnxruntime-web'],
  },
  plugins: [
    // Copy VAD model + ONNX runtime WASM/worklet assets into /public-served paths.
    // @ricky0123/vad-web expects these at runtime.
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ricky0123/vad-web/dist/*.onnx',
          dest: '.',
        },
        {
          src: 'node_modules/@ricky0123/vad-web/dist/*.worklet.bundle.min.js',
          dest: '.',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.wasm',
          dest: '.',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/*.mjs',
          dest: '.',
        },
        // transformers.js's own ORT WASM bundle — needed by the Whisper worker.
        // We serve these from /ort/ so we can pin env.backends.onnx.wasm.wasmPaths
        // to a stable URL (the version-pinned jsdelivr fallback is skipped inside
        // workers, which causes "no available backend found").
        {
          src: 'node_modules/@huggingface/transformers/dist/*.wasm',
          dest: 'ort',
        },
        {
          src: 'node_modules/@huggingface/transformers/dist/*.mjs',
          dest: 'ort',
        },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon.svg', 'icon-maskable.svg'],
      manifest: {
        name: 'LanguageSpy',
        short_name: 'LangSpy',
        description: 'Passive foreign-language eavesdrop translator — runs entirely on-device.',
        theme_color: '#0b0f17',
        background_color: '#0b0f17',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the small app-shell files only. The big ORT WASM blobs and Whisper
        // model weights are handled by runtime caching below (huge precache manifests
        // bloat memory and hit Workbox's per-file limit).
        globPatterns: ['**/*.{js,css,html,svg}'],
        globIgnores: ['**/ort-*.wasm', '**/ort-*.mjs', '**/*.onnx', 'ort/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            // ORT WASM + Silero ONNX served from our own origin.
            urlPattern: ({ url }) =>
              /\.(wasm|onnx|mjs)$/.test(url.pathname) && url.origin === self.location.origin,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ort-runtime-cache',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Whisper model weights from the Hugging Face CDN.
            urlPattern: /^https:\/\/huggingface\.co\/.*\.(onnx|json)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'hf-model-cache',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
