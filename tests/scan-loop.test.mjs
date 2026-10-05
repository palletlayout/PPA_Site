import assert from "node:assert/strict";
import test from "node:test";
import { BURST_MAX_GAP_MS, BURST_MAX_LENGTH, BURST_MIN_LENGTH, ScanBurstDetector } from "../lib/scan-burst.ts";
import { decideDrain, SCAN_QUEUE_LIMIT, ScanQueue, settleScanInput } from "../lib/scan-queue.ts";
import { playLabelCompleteBeep, playScanBeep, playScanErrorTone, SCAN_ERROR_SOUND, SPEECH_TIMEOUT_MS, speakScanPrompt } from "../lib/scan-audio.ts";
import { SCAN_FEEDBACK } from "../lib/scan-feedback.ts";

/** Feed `text` as a wedge scanner would: one key every `gap` ms, then an optional terminator. */
function type(detector, text, { start = 1000, gap = 5, end = "Enter" } = {}) {
  let time = start;
  let result = { kind: "none" };
  for (const key of text) { result = detector.push({ key, time }); time += gap; }
  if (end) result = detector.push({ key: end, time });
  return result;
}

test("a scanner burst ending in Enter or Tab is recognised as one scan", () => {
  assert.deepEqual(type(new ScanBurstDetector(), "1SABC-123"), { kind: "scan", value: "1SABC-123" });
  assert.deepEqual(type(new ScanBurstDetector(), "Z101AHTE31014603", { end: "Tab" }), { kind: "scan", value: "Z101AHTE31014603" });
  assert.deepEqual(type(new ScanBurstDetector(), "AB 12", { gap: BURST_MAX_GAP_MS }), { kind: "scan", value: "AB 12" }, "spaces inside a barcode are kept");
});

test("ordinary typing and short runs are not scans", () => {
  assert.equal(type(new ScanBurstDetector(), "abcdef", { gap: BURST_MAX_GAP_MS + 1 }).kind, "none", "a person types slower than a scanner");
  assert.equal(type(new ScanBurstDetector(), "ab").kind, "none", `fewer than ${BURST_MIN_LENGTH} characters`);
  assert.equal(new ScanBurstDetector().push({ key: "Enter", time: 1000 }).kind, "none", "Enter alone");
  const shortcut = new ScanBurstDetector();
  assert.equal(shortcut.push({ key: "c", time: 1000, ctrlKey: true }).kind, "none", "a shortcut on its own is left alone");
  assert.equal(shortcut.pending, false);
  const paused = new ScanBurstDetector();
  paused.push({ key: "a", time: 1000 });
  paused.push({ key: "b", time: 1005 });
  paused.push({ key: "c", time: 1010 });
  assert.equal(paused.push({ key: "Enter", time: 1010 + BURST_MAX_GAP_MS + 1 }).kind, "none", "a long pause before Enter is not a scanner");
});

test("Shift and Caps Lock events around uppercase letters do not break a scan", () => {
  // A scanner types the capitals of "AB12-Cd" as Shift down, letter, and so on.
  const detector = new ScanBurstDetector();
  let time = 1000;
  const push = (key) => detector.push({ key, time: (time += 4) });
  for (const key of ["Shift", "A", "Shift", "B", "1", "2", "-", "Shift", "C", "d", "CapsLock"]) push(key);
  assert.deepEqual(push("Enter"), { kind: "scan", value: "AB12-Cd" });
  const capsOnly = new ScanBurstDetector();
  assert.equal(capsOnly.push({ key: "Shift", time: 1000 }).kind, "none");
  assert.equal(capsOnly.pending, false, "a bare Shift press starts nothing");
});

test("a modifier or AltGr key inside a burst makes the whole scan unreliable, so it is refused", () => {
  const chord = new ScanBurstDetector();
  chord.push({ key: "A", time: 1000 });
  chord.push({ key: "B", time: 1005 });
  chord.push({ key: "@", time: 1010, ctrlKey: true, altKey: true });
  chord.push({ key: "C", time: 1015 });
  chord.push({ key: "D", time: 1020 });
  chord.push({ key: "E", time: 1025 });
  assert.deepEqual(chord.push({ key: "Enter", time: 1030 }), { kind: "rejected" }, "never the truncated tail CDE");
  assert.equal(chord.pending, false, "the next scan starts clean");
  assert.equal(type(chord, "NEXT-OK", { start: 2000 }).kind, "scan");
  const altGraph = new ScanBurstDetector();
  altGraph.push({ key: "A", time: 1000 });
  altGraph.push({ key: "AltGraph", time: 1004 });
  altGraph.push({ key: "B", time: 1008 });
  altGraph.push({ key: "C", time: 1012 });
  assert.equal(altGraph.push({ key: "Tab", time: 1016 }).kind, "rejected");
});

test("a held key is never a scan, and Space is only held back inside a burst", () => {
  const held = new ScanBurstDetector();
  held.push({ key: "a", time: 1000 });
  held.push({ key: "a", time: 1030, repeat: true });
  assert.equal(held.pending, false);
  const detector = new ScanBurstDetector();
  assert.equal(detector.continuesBurst(1000), false, "nothing typed yet");
  detector.push({ key: "A", time: 1000 });
  assert.equal(detector.continuesBurst(1004), false, "one character is not yet a burst");
  detector.push({ key: "B", time: 1004 });
  assert.equal(detector.continuesBurst(1008), true, "a space now would continue a burst");
  assert.equal(detector.continuesBurst(1004 + BURST_MAX_GAP_MS + 1), false, "a person's Space after a pause is left to act on a button");
});

test("a slow start does not hide a real scan that follows, and other keys end a burst", () => {
  const detector = new ScanBurstDetector();
  detector.push({ key: "x", time: 1000 });
  assert.deepEqual(type(detector, "REAL-SCAN-1", { start: 5000 }), { kind: "scan", value: "REAL-SCAN-1" }, "a stale character is discarded");
  const interrupted = new ScanBurstDetector();
  type(interrupted, "ABCD", { end: null });
  assert.equal(interrupted.pending, true);
  assert.equal(interrupted.push({ key: "ArrowLeft", time: 1100 }).kind, "none");
  assert.equal(interrupted.pending, false);
  assert.equal(type(interrupted, "ZZZ", { start: 1200 }).kind, "scan");
  assert.equal(type(new ScanBurstDetector(), "AB", { end: null }).kind, "collecting");
});

test("an oversized burst is refused, never truncated", () => {
  const detector = new ScanBurstDetector();
  assert.deepEqual(type(detector, "A".repeat(BURST_MAX_LENGTH * 3)), { kind: "rejected" });
  assert.deepEqual(type(new ScanBurstDetector(), "A".repeat(BURST_MAX_LENGTH)), { kind: "scan", value: "A".repeat(BURST_MAX_LENGTH) }, "exactly the limit is fine");
});

test("the scan queue keeps order, refuses empty scans and reports when it is full", () => {
  const queue = new ScanQueue(3);
  assert.equal(queue.enqueue(""), false);
  assert.equal(queue.enqueue("   "), false);
  assert.deepEqual([queue.enqueue("A"), queue.enqueue("B"), queue.enqueue("C")], [true, true, true]);
  assert.equal(queue.enqueue("D"), false, "full: the caller must refuse it loudly");
  assert.equal(queue.size, 3);
  assert.equal(queue.take(), "A");
  assert.equal(queue.enqueue("D"), true);
  assert.deepEqual(queue.flush(), ["B", "C", "D"], "flush returns everything waiting, oldest first");
  assert.equal(queue.size, 0);
  assert.equal(queue.take(), undefined);
  assert.equal(new ScanQueue().enqueue("X"), true);
  assert.ok(SCAN_QUEUE_LIMIT >= 10, "room for a burst of scans during one slow request");
});

function audioContext(state = "running") {
  const tones = [];
  const context = {
    state, currentTime: 10, destination: {}, tones, resumed: 0,
    resume: async () => { context.resumed++; context.state = "running"; },
    createOscillator: () => {
      const tone = { type: "sine", frequency: { setValueAtTime(value) { tone.hz = value; } }, connect() {}, disconnect() {},
        start(at) { tone.startAt = at; }, stop(at) { tone.stopAt = at; } };
      tones.push(tone);
      return tone;
    },
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
  };
  return context;
}

test("the failure tone is immediate, low and buzzy: nothing like the rising success chime", async () => {
  const failure = audioContext();
  playScanErrorTone(failure);
  assert.equal(failure.tones.length, SCAN_ERROR_SOUND.length, "played synchronously, without waiting on any queue");
  assert.ok(failure.tones.every((tone) => tone.type === "square"), "a buzzy timbre, not the chime's sine");
  const starts = failure.tones.map((tone) => tone.startAt);
  assert.ok(starts[0] >= failure.currentTime && starts[0] - failure.currentTime < 0.05, "starts at once");
  assert.ok(failure.tones[2].hz < failure.tones[0].hz, "the last note falls in pitch, where the success chime rises");

  const success = audioContext();
  await playLabelCompleteBeep(success);
  assert.ok(Math.max(...failure.tones.map((tone) => tone.hz)) < Math.min(...success.tones.map((tone) => tone.hz)), "every failure note is below every success note");
  assert.ok(failure.tones.at(-1).stopAt - failure.tones[0].startAt > 0.5, "long enough to be noticed over a warehouse");
});

test("the failure tone still plays when audio is suspended, muted or throws", () => {
  const suspended = audioContext("suspended");
  playScanErrorTone(suspended);
  assert.equal(suspended.resumed, 1, "resumed for the tone");
  assert.equal(suspended.tones.length, SCAN_ERROR_SOUND.length);
  assert.doesNotThrow(() => playScanErrorTone(null));
  assert.doesNotThrow(() => playScanErrorTone({ createOscillator() { throw new Error("Audio unavailable"); }, currentTime: 0, state: "running" }));
  const blocked = audioContext("suspended");
  blocked.resume = async () => { throw new Error("Autoplay blocked"); };
  assert.doesNotThrow(() => playScanErrorTone(blocked));
});

test("a speech engine that never finishes cannot silence later feedback", { timeout: 5000 }, async (t) => {
  const priorUtterance = globalThis.SpeechSynthesisUtterance;
  const priorSpeech = globalThis.speechSynthesis;
  t.after(() => {
    if (priorUtterance === undefined) delete globalThis.SpeechSynthesisUtterance; else globalThis.SpeechSynthesisUtterance = priorUtterance;
    if (priorSpeech === undefined) delete globalThis.speechSynthesis; else globalThis.speechSynthesis = priorSpeech;
  });
  const spoken = [];
  let cancelled = 0;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  // Some Android WebViews without a speech engine accept the utterance and never call back.
  globalThis.speechSynthesis = { speak(utterance) { spoken.push(utterance.text); }, cancel() { cancelled++; } };
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chime = audioContext();
  const stalled = speakScanPrompt("checkScreen");
  const behind = playScanBeep(chime);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chime.tones.length, 0, "the chime waits while speech is in progress");
  t.mock.timers.tick(SPEECH_TIMEOUT_MS);
  await stalled;
  await behind;
  assert.equal(cancelled, 1, "the stalled utterance was cancelled");
  assert.equal(chime.tones.length, 1, "after the timeout the chime plays");
  assert.deepEqual(spoken, [SCAN_FEEDBACK.checkScreen]);
});

test("the new spoken prompts are fixed, short and carry no scanned values", () => {
  for (const key of ["scanNotProcessed", "doNotLoad", "networkProblem"]) {
    assert.ok(SCAN_FEEDBACK[key].length <= 40, key);
    assert.doesNotMatch(SCAN_FEEDBACK[key], /\d/, "no serials or quantities are ever spoken");
  }
  assert.equal(SCAN_FEEDBACK.doNotLoad, "Do not load");
});

test("waiting scans run only when the screen can act on them; otherwise they are refused, never silently kept", () => {
  const ready = { busy: false, waiting: 2, onScreen: true, cancelling: false, ready: true };
  assert.equal(decideDrain(ready), "process");
  assert.equal(decideDrain({ ...ready, waiting: 0 }), "idle", "nothing waiting");
  assert.equal(decideDrain({ ...ready, busy: true }), "idle", "the previous scan is still being checked");
  assert.equal(decideDrain({ ...ready, ready: false }), "discard", "the previous result needs attention: refuse loudly");
  assert.equal(decideDrain({ ...ready, cancelling: true }), "discard-silently", "Cancel wins over a waiting scan");
  assert.equal(decideDrain({ ...ready, cancelling: true, ready: false }), "discard-silently");
  assert.equal(decideDrain({ ...ready, onScreen: false }), "discard-silently", "the operator has left the screen");
  assert.equal(decideDrain({ ...ready, busy: true, cancelling: true }), "idle", "wait for the request to finish before deciding");
});

test("accepting a scan clears the input only if it still holds that scan", () => {
  assert.equal(settleScanInput("1SABC123", "1SABC123"), "", "the accepted scan is cleared");
  assert.equal(settleScanInput("1SNEXT-SC", "1SABC123"), "1SNEXT-SC", "the next scan's characters are left alone, not wiped");
  assert.equal(settleScanInput("", "1SABC123"), "");
  // The failure this prevents: appending the next scan to the old text.
  const glued = "1SABC123" + "1SNEXT456";
  assert.notEqual(settleScanInput(glued, "1SABC123"), "", "if glue ever happened it would not be silently swallowed");
});
