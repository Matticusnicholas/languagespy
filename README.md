# LanguageSpy

A passive foreign-language eavesdrop translator that runs **entirely in your phone's browser**.

Tap Start → it listens via the mic → auto-detects spoken languages → ignores English →
translates everything else to English text on screen (and optionally speaks it out loud).

No audio leaves your device. No accounts. No server.

## Use case

Sitting at a massage spa, nail salon, or anywhere people are speaking another language
near you and you want to know what's being said. Open the PWA, tap Start, put the phone
face-down on the table. English passes silently; foreign speech appears as English
translations.

## How it works

- **[Whisper](https://huggingface.co/onnx-community/whisper-base)** (multilingual) runs
  in a Web Worker via [transformers.js](https://github.com/huggingface/transformers.js)
  with WebGPU acceleration.
- Whisper's built-in `translate` task outputs English regardless of source language and
  also reports the detected language — so we can drop chunks tagged as English.
- **[Silero VAD](https://github.com/ricky0123/vad)** chunks the audio into natural
  utterances so we only transcribe actual speech.
- **Web Speech API** speaks the translation through the phone's TTS engine.
- **PWA** so you can "Add to Home Screen" on Android Chrome and it works offline once
  the model is cached.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://<your-laptop-ip>:5173/languagespy/` from your phone on the same wifi
(Vite is configured with `--host` so phones can reach it).

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Source: GitHub Actions.
3. Push to `main`. The included workflow builds and deploys automatically.
4. App lives at `https://<your-username>.github.io/<repo-name>/`.

If you name your repo something other than `languagespy`, the workflow sets `VITE_BASE`
to match automatically — no config needed. For local dev with a different name, set
`VITE_BASE=/your-repo-name/` in the environment.

## Settings

- **Show transcript / Speak TTS** — toggle output modes independently.
- **Model** — Base (~75 MB, faster) vs Small (~250 MB, better accuracy on accents).
- **Ignore languages** — comma-separated codes. Default `en`. Add e.g. `en,es` to also
  ignore Spanish.
- **Compute device** — WebGPU (fast, modern Android Chrome) or WASM (slower fallback).

## Known constraints

- **Android Chrome only** (officially). iOS Safari may work for the UI but WebGPU and
  PWA install behave differently — not tested.
- Screen must stay on; Android throttles mic access in backgrounded tabs.
- First launch downloads the Whisper model (one time, cached in IndexedDB).
- GitHub Pages does not send COOP/COEP headers, so threaded WASM is unavailable.
  Performance is fine on WebGPU; on WASM expect ~2-4× real-time on a modern phone.
- Battery drain is real — expect 15–25%/hour during continuous listening.

## File layout

```
src/
  main.ts                 # UI controller
  audio/vad.ts            # Silero VAD wrapper
  workers/whisper.worker.ts  # transformers.js Whisper pipeline
  tts/speak.ts            # Web Speech API queue
  ui/transcript.ts        # transcript log
  ui/settings.ts          # localStorage settings
public/
  icon.svg, icon-maskable.svg, favicon.svg
```
