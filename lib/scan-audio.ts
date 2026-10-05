import type { DemandScanField } from "./scan-values.ts";
import { SCAN_FEEDBACK, type ScanFeedback } from "./scan-feedback.ts";

let sharedContext: AudioContext | null = null;
let feedbackQueue: Promise<void> = Promise.resolve();
const scheduledUntil = new WeakMap<AudioContext, number>();
type ScanAnnouncement = DemandScanField | "cardColor" | "duplicate";
export const SCAN_VOICE_FILES: Record<ScanAnnouncement, string> = {
  cardColor: "/audio/scans/color.wav",
  partNumber: "/audio/scans/part-number.wav", quantity: "/audio/scans/quantity.wav",
  color: "/audio/scans/color.wav", aiagSerial: "/audio/scans/serial.wav", duplicate: "/audio/scans/duplicate.wav",
};
const voices = new Map<ScanAnnouncement, Promise<AudioBuffer | null>>();

type SoundNote = { frequency: number; offset: number; duration: number; volume: number; overtones: boolean; wave?: OscillatorType };

// A quiet scan tick, then an original rising, bell-like completion chime.
export const SCAN_SOUND: readonly SoundNote[] = [
  { frequency: 1567.98, offset: 0, duration: 0.055, volume: 0.065, overtones: false },
];
export const LABEL_COMPLETE_SOUND: readonly SoundNote[] = [
  { frequency: 1318.51, offset: 0, duration: 0.15, volume: 0.13, overtones: true },
  { frequency: 1760, offset: 0.115, duration: 0.34, volume: 0.18, overtones: true },
];
// Two short buzzes and a lower, longer one: mid-range square waves that a handheld's small
// speaker reproduces, and nothing like the bright rising chime that means success.
export const SCAN_ERROR_SOUND: readonly SoundNote[] = [
  { frequency: 349.23, offset: 0, duration: 0.14, volume: 0.16, overtones: false, wave: "square" },
  { frequency: 349.23, offset: 0.19, duration: 0.14, volume: 0.16, overtones: false, wave: "square" },
  { frequency: 261.63, offset: 0.38, duration: 0.34, volume: 0.18, overtones: false, wave: "square" },
];

/** Call during the scanner's key/button gesture, before awaiting a server check. */
export function prepareScanAudio() {
  try {
    if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioContext();
    if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {});
    return sharedContext;
  } catch { return null; }
}

function scheduleNotes(context: AudioContext, notes: readonly SoundNote[], start: number) {
  for (const note of notes) {
    const at = start + note.offset;
    const partials = note.overtones ? [[1, 1], [2, 0.14], [3, 0.035]] : [[1, 1]];
    for (const [multiple, level] of partials) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const duration = multiple === 1 ? note.duration : note.duration * 0.6;
      oscillator.type = note.wave || "sine";
      oscillator.frequency.setValueAtTime(note.frequency * multiple, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(note.volume * level, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at);
      oscillator.stop(at + duration + 0.01);
    }
  }
  return start + Math.max(...notes.map((note) => note.offset + note.duration)) + 0.05;
}

function playSound(context: AudioContext | null, notes: readonly SoundNote[]) {
  if (!context) return Promise.resolve();
  return enqueueFeedback(context, () => {
    try {
      const start = Math.max(context.currentTime + 0.01, scheduledUntil.get(context) || 0);
      scheduledUntil.set(context, scheduleNotes(context, notes, start));
    } catch {
      // Audio feedback is optional; it must never interrupt scanning.
    }
  });
}

function enqueueFeedback(context: AudioContext | null, play: () => void | Promise<void>, fallback?: () => Promise<void>) {
  if (!context) return Promise.resolve();
  feedbackQueue = feedbackQueue.then(async () => {
    if (context.state === "closed") { await fallback?.(); return; }
    if (context.state === "suspended") await context.resume();
    await play();
  }).catch(async () => { await fallback?.(); }).catch(() => {});
  return feedbackQueue;
}

function loadVoice(key: ScanAnnouncement, context: AudioContext) {
  let voice = voices.get(key);
  if (!voice) {
    voice = fetch(SCAN_VOICE_FILES[key], { cache: "force-cache", signal: AbortSignal.timeout(3000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Voice prompt unavailable");
        return context.decodeAudioData(await response.arrayBuffer());
      }).catch(() => { voices.delete(key); return null; });
    voices.set(key, voice);
  }
  return voice;
}

export function preloadScanVoices() {
  const context = prepareScanAudio();
  if (context) for (const key of Object.keys(SCAN_VOICE_FILES) as ScanAnnouncement[]) void loadVoice(key, context);
}

const SCAN_PHRASES: Record<ScanAnnouncement, string> = {
  partNumber: "Part number", quantity: "Quantity", color: "Color", cardColor: "Color",
  aiagSerial: "Serial", duplicate: "Duplicate",
};

/** A speech engine that never reports completion (some handheld WebViews) must not block later feedback. */
export const SPEECH_TIMEOUT_MS = 4000;

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") { resolve(); return; }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { speechSynthesis.cancel(); } catch { /* Speech is optional. */ }
      finish();
    }, SPEECH_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1.1;
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

function queueSpeech(text: string) {
  feedbackQueue = feedbackQueue.then(async () => {
    const delay = sharedContext ? ((scheduledUntil.get(sharedContext) || 0) - sharedContext.currentTime) * 1000 : 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await speak(text);
  }).catch(() => {});
  return feedbackQueue;
}

/** Only fixed, short feedback can be spoken; full errors stay on screen. */
export function speakScanPrompt(feedback: ScanFeedback) {
  return queueSpeech(SCAN_FEEDBACK[feedback]);
}

/** Queue short local recordings so fast scans remain intelligible and the chime cannot overlap them. */
export function announceScan(key: ScanAnnouncement, context: AudioContext | null = prepareScanAudio()) {
  if (!context) return queueSpeech(SCAN_PHRASES[key]);
  const voice = loadVoice(key, context);
  return enqueueFeedback(context, async () => {
    const buffer = await voice;
    if (!buffer) { await speak(SCAN_PHRASES[key]); return; }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(context.currentTime + 0.01, scheduledUntil.get(context) || 0);
    source.onended = () => source.disconnect();
    source.start(at);
    scheduledUntil.set(context, at + buffer.duration + 0.035);
  }, () => speak(SCAN_PHRASES[key]));
}

/**
 * The failure sound plays at once. It is deliberately not queued behind speech or earlier
 * chimes: an operator must hear that a scan failed at the moment it fails.
 */
export function playScanErrorTone(context: AudioContext | null = prepareScanAudio()) {
  if (!context) return;
  try {
    if (context.state === "suspended") void context.resume().catch(() => {});
    const end = scheduleNotes(context, SCAN_ERROR_SOUND, context.currentTime + 0.01);
    // Later speech waits for the tone instead of talking over it.
    scheduledUntil.set(context, Math.max(scheduledUntil.get(context) || 0, end));
  } catch {
    // Audio feedback is optional; it must never interrupt scanning.
  }
}

export function playScanBeep(context: AudioContext | null = prepareScanAudio()) {
  return playSound(context, SCAN_SOUND);
}

export function playLabelCompleteBeep(context: AudioContext | null = prepareScanAudio()) {
  return playSound(context, LABEL_COMPLETE_SOUND);
}
