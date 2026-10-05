import assert from "node:assert/strict";
import test from "node:test";
import { INVENTORY_REFRESH_MS, publishInventoryUpdate, subscribeInventoryUpdates } from "../lib/live-inventory.ts";

function environment(t, withChannel = true) {
  const prior = { window: globalThis.window, document: globalThis.document, BroadcastChannel: globalThis.BroadcastChannel };
  const timers = new Map();
  const channels = new Set();
  const window = Object.assign(new EventTarget(), {
    setInterval(callback, interval) { assert.equal(interval, 2000); const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  class Channel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const other of channels) if (other !== this && other.name === this.name) other.onmessage?.({ data }); }
    close() { channels.delete(this); }
  }
  globalThis.window = window;
  globalThis.document = document;
  globalThis.BroadcastChannel = withChannel ? Channel : undefined;
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { window, document, channels, timers, tick: () => { for (const timer of timers.values()) timer(); } };
}

test("live inventory refreshes every two seconds and resumes immediately after visibility or connectivity changes", (t) => {
  const { window, document, tick } = environment(t);
  assert.equal(INVENTORY_REFRESH_MS, 2000);
  let updates = 0;
  const stop = subscribeInventoryUpdates(() => updates++);
  tick();
  assert.equal(updates, 1);
  document.visibilityState = "hidden";
  tick(); window.dispatchEvent(new Event("focus"));
  assert.equal(updates, 1, "hidden supervisors do not keep polling");
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  assert.equal(updates, 3, "returning supervisors do not wait for the next interval");
  stop();
});

test("confirmed receipts notify other tabs without sending inventory data, and subscriptions clean up", (t) => {
  const { channels, timers, tick, window } = environment(t);
  let updates = 0;
  const stop = subscribeInventoryUpdates(() => updates++);
  publishInventoryUpdate();
  assert.ok(updates >= 1, "the current view is invalidated immediately");
  const subscriber = [...channels][0];
  const before = updates;
  subscriber.onmessage({ data: "inventory-changed" });
  assert.equal(updates, before + 1, "another tab invalidates this view");
  subscriber.onmessage({ data: { serial: "untrusted-payload" } });
  assert.equal(updates, before + 1, "channel payloads are never rendered as inventory");
  stop();
  tick(); window.dispatchEvent(new Event("online"));
  assert.equal(updates, before + 1);
  assert.equal(timers.size, 0);
  assert.equal(channels.size, 0);
});

test("browsers without BroadcastChannel still receive local and periodic updates", (t) => {
  const { tick } = environment(t, false);
  let updates = 0;
  const stop = subscribeInventoryUpdates(() => updates++);
  assert.doesNotThrow(publishInventoryUpdate);
  tick();
  assert.equal(updates, 2);
  stop();
});
