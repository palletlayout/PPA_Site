export const INVENTORY_REFRESH_MS = 2_000;
const CHANNEL = "ppa-inventory";
const CHANGED = "inventory-changed";

/** An invalidation carries no receipt data; each viewer reads through the authorized API. */
export function publishInventoryUpdate() {
  window.dispatchEvent(new Event(CHANGED));
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(CHANGED);
    channel.close();
  } catch {
    // Other devices and browsers without BroadcastChannel use the periodic read.
  }
}

export function subscribeInventoryUpdates(refresh: () => void) {
  const update = () => { if (document.visibilityState === "visible") refresh(); };
  const interval = window.setInterval(update, INVENTORY_REFRESH_MS);
  window.addEventListener(CHANGED, update);
  window.addEventListener("focus", update);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  document.addEventListener("visibilitychange", update);
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => { if (event.data === CHANGED) update(); };
  } catch { /* Periodic refresh remains available. */ }
  return () => {
    window.clearInterval(interval);
    window.removeEventListener(CHANGED, update);
    window.removeEventListener("focus", update);
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
    document.removeEventListener("visibilitychange", update);
    channel?.close();
  };
}
