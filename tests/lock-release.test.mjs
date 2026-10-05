import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("lock release validates the API response and converts network failures to a result", async () => {
  const [app, store] = await Promise.all([
    source("../app/cartflow-app.tsx"),
    source("../db/cart-store.ts"),
  ]);
  const releaseSection = app.slice(app.indexOf("const releaseCart"), app.indexOf("const leaveScan"));

  assert.match(releaseSection, /const result = await response\.json\(\)\.catch\(\(\) => null\)/);
  assert.match(releaseSection, /return response\.ok && result\?\.released === true/);
  assert.match(releaseSection, /catch \{\s*return false;/);
  assert.match(releaseSection, /controller\.abort\(\)/);
  assert.match(releaseSection, /keepalive: true/);
  assert.match(store, /released: Number\(release\.meta\.changes \|\| 0\) === 1/);
});

test("active scanner locks get a best-effort pagehide release", async () => {
  const [app, lockRoute] = await Promise.all([
    source("../app/cartflow-app.tsx"),
    source("../app/api/locks/route.ts"),
  ]);

  assert.match(lockRoute, /export async function POST/);
  assert.match(app, /window\.addEventListener\("pagehide", releaseOnPageHide\)/);
  assert.match(app, /navigator\.sendBeacon\("\/api\/locks", new Blob/);
  assert.match(app, /window\.removeEventListener\("pagehide", releaseOnPageHide\)/);
});

test("leaving the scanner resets local state before waiting for release", async () => {
  const app = await source("../app/cartflow-app.tsx");
  const leaveSection = app.slice(app.indexOf("const leaveScan"), app.indexOf("const navigateTo"));

  assert.ok(leaveSection.indexOf("setActiveCartKey(null)") < leaveSection.indexOf("await releasePromise"));
  assert.ok(leaveSection.indexOf('setView("overview")') < leaveSection.indexOf("await releasePromise"));
  assert.match(leaveSection, /if \(!released\) setNotice/);
});
