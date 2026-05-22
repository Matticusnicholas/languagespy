// Simple TTS queue over Web Speech API. Falls silent if unavailable
// (some Android Chrome profiles disable speechSynthesis without a voice).

let queue: string[] = [];
let speaking = false;
let enVoice: SpeechSynthesisVoice | null = null;

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  // Prefer a high-quality en-US voice if available.
  enVoice =
    voices.find((v) => /en[-_]US/i.test(v.lang) && /Google|Samantha|Microsoft/i.test(v.name)) ??
    voices.find((v) => /^en[-_]/i.test(v.lang)) ??
    voices[0] ??
    null;
}

if ('speechSynthesis' in window) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

function drain() {
  if (speaking) return;
  const next = queue.shift();
  if (!next) return;
  if (!('speechSynthesis' in window)) return;

  const u = new SpeechSynthesisUtterance(next);
  if (enVoice) u.voice = enVoice;
  u.lang = enVoice?.lang ?? 'en-US';
  u.rate = 1.05;
  u.pitch = 1;
  u.volume = 1;
  u.onend = () => {
    speaking = false;
    drain();
  };
  u.onerror = () => {
    speaking = false;
    drain();
  };
  speaking = true;
  window.speechSynthesis.speak(u);
}

export function speak(text: string) {
  if (!text) return;
  queue.push(text);
  drain();
}

export function cancelSpeech() {
  queue = [];
  speaking = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
