import assert from "node:assert/strict";
import test from "node:test";
import { createRetryableInitializer } from "../lib/retryable-initializer.ts";

test("shares one initialization attempt and reuses its result", async () => {
  let attempts = 0;
  const initialize = createRetryableInitializer(async () => {
    attempts += 1;
    await Promise.resolve();
    return { ready: true };
  });

  const first = initialize();
  const second = initialize();
  assert.equal(first, second);
  assert.equal(await first, await second);
  assert.equal(await initialize(), await first);
  assert.equal(attempts, 1);
});

test("clears a rejected attempt so the next call can retry", async () => {
  let attempts = 0;
  const initialize = createRetryableInitializer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return "ready";
  });

  await assert.rejects(initialize(), /temporary failure/);
  assert.equal(await initialize(), "ready");
  assert.equal(attempts, 2);
});
