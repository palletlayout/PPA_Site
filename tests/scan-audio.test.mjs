import assert from "node:assert/strict";
import test from "node:test";
import { announceScan, playLabelCompleteBeep, playScanBeep, prepareScanAudio, SCAN_VOICE_FILES, speakScanPrompt } from "../lib/scan-audio.ts";
import { packingScanFeedback } from "../lib/scan-feedback.ts";
import { readFile } from "node:fs/promises";

function audioContext(state = "running") {
  const tones = [];
  const gains = [];
  const context = {
    state, currentTime: 10, destination: {}, tones, gains, resumed: 0,
    resume: async () => { context.resumed++; context.state = "running"; },
    createOscillator: () => {
      const tone = { frequency: { setValueAtTime(value) { tone.hz = value; } }, connect() {},
        disconnect() { tone.disconnected = true; },
        start(at) { tone.startAt = at; }, stop(at) { tone.stopAt = at; } };
      tones.push(tone);
      return tone;
    },
    createGain: () => {
      const gain = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { gain.disconnected = true; } };
      gains.push(gain);
      return gain;
    },
  };
  return context;
}

test("cart confirmation is a quiet short tick; completion is two rising bell notes", async () => {
  const single = audioContext();
  await playScanBeep(single);
  assert.equal(single.tones.length, 1);
  const complete = audioContext();
  await playLabelCompleteBeep(complete);
  const starts = [...new Set(complete.tones.map((tone) => tone.startAt))];
  assert.equal(starts.length, 2, "completion has two distinct note attacks");
  const [first, second] = starts.map((start) => complete.tones.find((tone) => tone.startAt === start));
  assert.ok(first.startAt >= complete.currentTime);
  assert.ok(first.stopAt > first.startAt);
  assert.ok(second.hz > first.hz, "ba-bing rises in pitch instead of repeating the same beep");
  assert.ok(second.startAt - first.startAt >= 0.1, "the attacks remain distinct");
  assert.ok(second.stopAt - second.startAt > first.stopAt - first.startAt, "the final note has a gentle ringing tail");
  assert.ok(single.tones[0].stopAt - single.tones[0].startAt < 0.08, "intermediate scans stay unobtrusive");
  assert.ok(complete.tones.length > starts.length, "soft overtones give the chime a bell timbre");
  assert.ok(second.stopAt - first.startAt < 0.5, "completion feedback remains brief");
  for (const tone of complete.tones) tone.onended();
  assert.ok(complete.tones.every((tone) => tone.disconnected));
  assert.ok(complete.gains.every((gain) => gain.disconnected));
});

test("suspended audio resumes before scheduling completion tones", async () => {
  const context = audioContext("suspended");
  await playLabelCompleteBeep(context);
  assert.equal(context.resumed, 1);
  assert.equal(new Set(context.tones.map((tone) => tone.startAt)).size, 2);
});

test("muted, unsupported, or rejected audio cannot interrupt scanning", async () => {
  assert.equal(prepareScanAudio(), null, "Node has no browser AudioContext");
  assert.doesNotThrow(() => playLabelCompleteBeep(null));
  assert.doesNotThrow(() => playScanBeep({ createOscillator() { throw new Error("Audio unavailable"); } }));
  const context = audioContext("suspended");
  context.resume = async () => { throw new Error("Autoplay blocked"); };
  await playLabelCompleteBeep(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.tones.length, 0);
});

test("each spoken field and duplicate has a short, bundled audio recording", async () => {
  assert.deepEqual(Object.keys(SCAN_VOICE_FILES).sort(), ["aiagSerial", "cardColor", "color", "duplicate", "partNumber", "quantity"]);
  for (const path of Object.values(SCAN_VOICE_FILES)) {
    const bytes = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.ok(bytes.length > 6000 && bytes.length < 72000, `${path} must be audible and brief`);
  }
});

test("rapid field scans and duplicates speak in order, with the chime after the final word", async (t) => {
  const requested = [];
  const sources = [];
  t.mock.method(globalThis, "fetch", async (path) => {
    requested.push(path);
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(path).buffer };
  });
  const context = Object.assign(audioContext(), {
    decodeAudioData: async (bytes) => ({ duration: 0.4, path: new TextDecoder().decode(bytes) }),
    createBufferSource: () => {
      const source = { connect() {}, disconnect() { source.disconnected = true; }, start(at) { source.startAt = at; } };
      sources.push(source); return source;
    },
  });
  const keys = ["partNumber", "duplicate", "quantity", "color", "aiagSerial"];
  const pending = keys.map((key) => announceScan(key, context));
  pending.push(playLabelCompleteBeep(context));
  await Promise.all(pending);
  assert.deepEqual(sources.map((source) => source.buffer.path), keys.map((key) => SCAN_VOICE_FILES[key]));
  assert.equal(requested.length, 5);
  for (let index = 1; index < sources.length; index++) assert.ok(sources[index].startAt >= sources[index - 1].startAt + 0.4);
  assert.ok(context.tones[0].startAt >= sources.at(-1).startAt + 0.4, "the completion chime cannot cover the last field name");
  for (const source of sources) source.onended();
  assert.ok(sources.every((source) => source.disconnected));
});

test("spoken fallback and short rejection prompts work without Web Audio or recordings", async (t) => {
  const spoken = [];
  const priorUtterance = globalThis.SpeechSynthesisUtterance;
  const priorSpeech = globalThis.speechSynthesis;
  t.after(() => { if (priorUtterance === undefined) delete globalThis.SpeechSynthesisUtterance; else globalThis.SpeechSynthesisUtterance = priorUtterance; if (priorSpeech === undefined) delete globalThis.speechSynthesis; else globalThis.speechSynthesis = priorSpeech; });
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = { speak(utterance) { spoken.push(utterance.text); queueMicrotask(() => utterance.onend()); } };
  await announceScan("partNumber", null);
  t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
  await announceScan("cardColor", audioContext());
  const blocked = audioContext("suspended");
  blocked.resume = async () => { throw new Error("Audio blocked"); };
  await announceScan("quantity", blocked);
  await Promise.all([
    speakScanPrompt("alreadyScanned"),
    speakScanPrompt(packingScanFeedback("inventory_mismatch")),
    speakScanPrompt("receiptNotConfirmed"),
    announceScan("duplicate", null),
  ]);
  assert.deepEqual(spoken, ["Part number", "Color", "Quantity", "Already scanned", "Not in picklist", "Receipt not confirmed. Check screen", "Duplicate"]);
});
