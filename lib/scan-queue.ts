/**
 * Scans that arrive while the previous one is still being checked. Dropping them would
 * leave an operator believing a container was scanned when the app never saw it, so they
 * wait here in order. The queue is bounded: past the limit the caller must refuse the scan
 * loudly, never silently.
 */
export const SCAN_QUEUE_LIMIT = 20;

export class ScanQueue {
  private items: string[] = [];
  private readonly limit: number;

  constructor(limit = SCAN_QUEUE_LIMIT) {
    this.limit = limit;
  }

  /** Returns false, and keeps nothing, when the queue is full or the scan is empty. */
  enqueue(value: string) {
    if (!value.trim() || this.items.length >= this.limit) return false;
    this.items.push(value);
    return true;
  }

  /** The oldest waiting scan, or undefined when none is waiting. */
  take() {
    return this.items.shift();
  }

  /** Empties the queue and returns what was waiting, oldest first. */
  flush() {
    const waiting = this.items;
    this.items = [];
    return waiting;
  }

  get size() {
    return this.items.length;
  }
}

export type DrainDecision =
  /** Nothing to do yet: empty, or the previous scan is still being checked. */
  | "idle"
  /** Take the next waiting scan and process it. */
  | "process"
  /** Refuse everything waiting, loudly: it was made before the operator saw the previous result. */
  | "discard"
  /** Leaving the screen or cancelling: what was waiting no longer applies. */
  | "discard-silently";

/**
 * What to do with waiting scans once the current check has finished. `ready` means the
 * previous result needs no attention and the screen can still act on a scan.
 */
export function decideDrain(state: { busy: boolean; waiting: number; onScreen: boolean; cancelling: boolean; ready: boolean }): DrainDecision {
  if (state.busy || state.waiting === 0) return "idle";
  if (state.cancelling || !state.onScreen) return "discard-silently";
  return state.ready ? "process" : "discard";
}

/**
 * The input's text after a scan has been accepted. Clear it only if it still holds that
 * scan: characters of the next scan may already be arriving, and wiping or appending to
 * them would corrupt a scan instead of merely delaying it.
 */
export function settleScanInput(current: string, accepted: string) {
  return current === accepted ? "" : current;
}
