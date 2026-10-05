/**
 * Recognises a barcode scanner working as a keyboard: printable characters typed in quick
 * succession and ended by Enter or Tab. A person cannot type this fast, so a burst that
 * arrives while no input has focus is a scan that would otherwise vanish, or worse, its
 * Enter would press whichever button happens to be focused.
 */
export type BurstKey = { key: string; time: number; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean };
export type BurstResult =
  /** Not part of a burst; leave the event alone. */
  | { kind: "none" }
  /** A character of a burst that may still be in progress. */
  | { kind: "collecting" }
  /** The burst ended with Enter or Tab: this is the scanned text. */
  | { kind: "scan"; value: string }
  /**
   * The burst ended with Enter or Tab but cannot be trusted: it held a modifier key
   * combination or grew past the limit. Acting on part of a barcode is worse than refusing
   * it, so the caller must tell the operator to scan again.
   */
  | { kind: "rejected" };

/** Longest pause between characters that still counts as one scan. Scanners send a character every few milliseconds. */
export const BURST_MAX_GAP_MS = 100;
/** Shortest text worth treating as a scan; shorter runs are key presses, not barcodes. */
export const BURST_MIN_LENGTH = 3;
/** Longest text accepted. A longer burst is refused, never truncated. */
export const BURST_MAX_LENGTH = 512;

/**
 * A scanner sends Shift (and Caps Lock) events around uppercase letters. They carry no
 * text and must neither end a burst nor count as part of one.
 */
const NEUTRAL_KEYS = new Set(["Shift", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock"]);
/** Modifier keys that, inside a burst, mean the text cannot be read reliably. */
const POISONING_KEYS = new Set(["Control", "Alt", "AltGraph", "Meta", "OS"]);

export class ScanBurstDetector {
  private buffer = "";
  private last = 0;
  private poisoned = false;

  push(event: BurstKey): BurstResult {
    if (NEUTRAL_KEYS.has(event.key)) return { kind: "none" };
    // A held key repeats far faster than a person types; it is never part of a scan.
    if (event.repeat) {
      this.reset();
      return { kind: "none" };
    }
    if (event.ctrlKey || event.altKey || event.metaKey || POISONING_KEYS.has(event.key)) {
      // A modifier inside a burst (some layouts send AltGr characters this way) means the
      // text can no longer be read reliably. Remember that until the burst ends.
      if (this.buffer.length > 0 || this.poisoned) {
        this.poisoned = true;
        this.last = event.time;
      }
      return { kind: "none" };
    }
    const gap = event.time - this.last;
    if (event.key.length === 1) {
      if ((this.buffer || this.poisoned) && gap > BURST_MAX_GAP_MS) this.reset();
      if (this.buffer.length < BURST_MAX_LENGTH) this.buffer += event.key;
      else this.poisoned = true;
      this.last = event.time;
      return { kind: "collecting" };
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const value = this.buffer;
      const inBurst = (value.length > 0 || this.poisoned) && gap <= BURST_MAX_GAP_MS;
      const poisoned = this.poisoned;
      this.reset();
      if (!inBurst || (!poisoned && value.length < BURST_MIN_LENGTH)) return { kind: "none" };
      return poisoned ? { kind: "rejected" } : { kind: "scan", value };
    }
    // Navigation, Escape, function keys and the like end whatever was being collected.
    this.reset();
    return { kind: "none" };
  }

  /**
   * True when a character arriving at `time` would carry on a burst already in progress
   * (two or more characters, no pause). Space is the one printable key that presses a
   * focused button, so it is only held back when it is part of such a burst.
   */
  continuesBurst(time: number) {
    return this.buffer.length >= 2 && time - this.last <= BURST_MAX_GAP_MS;
  }

  /** True while characters are buffered. */
  get pending() {
    return this.buffer.length > 0 || this.poisoned;
  }

  reset() {
    this.buffer = "";
    this.poisoned = false;
  }
}
