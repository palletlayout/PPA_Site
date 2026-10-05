import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

test("the deployment build contains the PPA application", async () => {
  const appSource = await readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8");
  await Promise.all([
    access(new URL("../.next/BUILD_ID", import.meta.url)),
    access(new URL("../.next/server/app/page.js", import.meta.url)),
  ]);
  assert.match(appSource, /Reconcile each inbound inventory container against an outbound picklist demand line/);
  assert.match(appSource, /Supervisor dashboard/);
  assert.match(appSource, /PPA/);
  assert.doesNotMatch(appSource, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps the finished product surface and metadata in place", async () => {
  const [app, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(app, /Import demand/);
  assert.match(app, /Add one row/);
  assert.match(app, /action: "append"/);
  assert.match(app, /Add row to active demand/);
  assert.match(app, /Download example demand/);
  assert.match(app, /common demand headers/);
  assert.match(app, /Existing templates and production-report headings are still accepted/);
  assert.match(app, /renderMovementPanel\("offsite", loads\)/);
  assert.match(app, /renderMovementPanel\("onsite", trains\)/);
  assert.match(app, /Load or train status/);
  assert.match(app, /Picklist status/);
  assert.match(app, /Last activity \(CT\)/);
  assert.match(app, /Print checksheets/);
  assert.match(app, /fetch\("\/api\/picklists\/pdf"/);
  assert.match(app, /JSON\.stringify\(\{ scope: "section", areaType, workScope \}\)/);
  assert.match(app, /window\.setInterval\(refreshSupervisor, 12_000\)/);
  assert.match(app, /Onsite train/);
  assert.match(app, /Offsite load/);
  assert.match(app, /field: "cartBarcode"/);
  assert.match(app, /Load confirm/);
  assert.match(app, /Final physical placement/);
  assert.match(app, /fetch\("\/api\/loading\/confirm"/);
  assert.match(app, /Picklist loaded/);
  assert.match(app, /Do not load this outbound card/);
  assert.match(app, /Loaded means every picklist passed the final destination check/);
  assert.match(app, /scanSerialBarcode\(rawValue\)/);
  assert.doesNotMatch(app, /This container expects/);
  assert.match(layout, /PPA — Supervisor Control Room/);
  assert.match(packageJson, /xlsx-0\.20\.3\.tgz/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/favicon.svg", import.meta.url));
  await access(new URL("../drizzle-postgres/0000_new_butterfly.sql", import.meta.url));
});

test("both movement sections always offer one checksheet action for all work in that section", async () => {
  const app = await readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8");
  const movementPanel = app.slice(
    app.indexOf("const renderMovementPanel"),
    app.indexOf("const renderOverview"),
  );
  const partsPanel = app.slice(
    app.indexOf('<article className="panel supervisor-panel parts-panel">'),
    app.indexOf("const renderScan"),
  );

  assert.match(movementPanel, /downloadSectionPdf\(areaType\)/);
  assert.equal((movementPanel.match(/className="button button-secondary pdf-download-button"/g) || []).length, 1);
  assert.match(movementPanel, /Print checksheets/);
  assert.match(movementPanel, /state\.lines\.filter\(\(line\) => line\.areaType === areaType\)/);
  assert.doesNotMatch(movementPanel, /printableMovement|printableLine/);
  assert.doesNotMatch(movementPanel, /Capture test inventory|Print all checksheets|Download combined PDF/);
  assert.doesNotMatch(app, /printAfter|document\.createElement\("iframe"\)/);
  assert.doesNotMatch(partsPanel, /Print checksheet|Download PDF|downloadSectionPdf/);

  const compiled = ts.transpileModule(movementPanel, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const createPanel = new Function("React", "state", "allLoads", "allTrains", "pdfBusyArea", "picklistKey", "downloadSectionPdf", "supervisorFiltersActive", "workScope", `${compiled}; return renderMovementPanel;`);
  const requests = [];
  const lines = ["offsite", "onsite"].flatMap((areaType) => Array.from({ length: 6 }, (_, index) => ({ id: `${areaType}-${index}`, areaType })));
  const panel = (areaType, { busy = null, rows = lines } = {}) => createPanel(
    React, { lines: rows }, [{ number: "L000001" }, { number: "L000002" }], [{ number: "TP00001" }, { number: "TP00002" }], busy,
    (line) => line.id, (requestedArea) => requests.push(requestedArea), true, "production",
  )(areaType, []);
  const action = (tree) => tree.props.children[0].props.children[1].props.children[1];

  for (const areaType of ["offsite", "onsite"]) {
    const tree = panel(areaType);
    const html = renderToStaticMarkup(tree);
    assert.equal((html.match(/<button\b/g) || []).length, 1);
    assert.match(html, /Print checksheets/);
    assert.match(html, areaType === "offsite" ? /2 loads · 6 picklists/ : /2 trains · 6 picklists/);
    assert.equal(action(tree).props.disabled, false, "search filtering all table rows must not disable section printing");
    action(tree).props.onClick();
    assert.equal(action(panel(areaType, { rows: [] })).props.disabled, true, "empty sections keep a disabled action visible");
    assert.equal(action(panel(areaType, { busy: "offsite" })).props.disabled, true, "both sections are disabled during a download");
  }
  assert.deepEqual(requests, ["offsite", "onsite"]);
  assert.equal(action(panel("offsite", { busy: "offsite" })).props.children, "Preparing…");
  assert.equal(action(panel("onsite", { busy: "offsite" })).props.children, "Print checksheets");
});

test("section PDF requests include the active work environment without a selected movement", async () => {
  const app = await readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("const downloadSectionPdf"), app.indexOf("const beginDemandEdit"));
  assert.match(handler, /JSON\.stringify\(\{ scope: "section", areaType, workScope \}\)/);
  assert.doesNotMatch(handler, /lineId|selectedMovement|selectedPicklist|searchQuery|statusFilter/);
  assert.match(handler, /if \(pdfBusyArea\) return/);
  assert.match(handler, /setPdfBusyArea\(areaType\)/);
  assert.match(handler, /finally\s*\{\s*setPdfBusyArea\(null\)/);
});

test("supervisor queue filters render labeled controls and reset dependent searches", async () => {
  const app = await readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8");
  const toolbar = app.slice(app.indexOf('<div className="queue-toolbar">'), app.indexOf('{supervisorFiltersActive && !matchingMovements.length'));
  const compiled = ts.transpileModule(`const renderToolbar = () => (${toolbar});`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const changes = [];
  const environment = {
    React, OperationIcon: () => null, matchingMovements: [1], movements: [1, 2],
    searchQuery: "", movementTypeFilter: "all", plantFilter: "", zoneFilter: "", statusFilter: "all",
    supervisorPlants: ["01", "02"], supervisorZones: ["N", "S"], supervisorFiltersActive: false,
    picklistSearch: "", demandSearch: "", updateSupervisorFilters: (value) => changes.push(value),
    resetSupervisorFilters: () => changes.push("reset"),
  };
  const tree = new Function(...Object.keys(environment), `${compiled}; return renderToolbar();`)(...Object.values(environment));
  const html = renderToStaticMarkup(tree);
  assert.match(html, /1 of 2 movements/);
  assert.match(html, /role="search" aria-label="Filter supervisor work queue"/);
  for (const label of ["Find work", "Movement", "Plant", "Delivery zone", "Movement status", "Clear filters"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/<select/g) || []).length, 4);
  const controls = tree.props.children[1].props.children;
  controls[0].props.children[2].props.onChange({ target: { value: "serial-987" } });
  controls[1].props.children[1].props.onChange({ target: { value: "onsite" } });
  controls[2].props.children[1].props.onChange({ target: { value: "02" } });
  assert.deepEqual(changes, [{ query: "serial-987" }, { areaType: "onsite", zone: "" }, { plant: "02", zone: "" }]);
  assert.equal(controls[5].props.disabled, true);
  assert.match(app, /Find picklists/);
  assert.match(app, /Find demand lines/);
  assert.match(app, /supervisorImport\.current !== importKey\) resetSupervisorFilters\(\)/);
  assert.match(app, /setWorkScope\(scope\); resetSupervisorFilters\(\)/);
  const reset = app.slice(app.indexOf("const resetSupervisorFilters"), app.indexOf("const [resetSearch"));
  for (const setter of ["setSelectedMovementKey", "setSelectedPicklistKey", "setPicklistSearch", "setDemandSearch"]) assert.ok(reset.includes(setter));
  assert.doesNotMatch(reset, /setScanPlant|setScanArea|setActiveCartKey|setPackingMovementKey/);
});

test("loading confirmation is a server-authoritative two-scan gate", async () => {
  const [app, route, store, styles] = await Promise.all([
    readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/loading/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/cart-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /loadStep === "movement"/);
  assert.match(app, /movementValue: loadMovementValue/);
  assert.match(app, /cartBarcode/);
  assert.match(route, /confirmCartLoading/);
  assert.match(store, /not_packed/);
  assert.match(store, /wrong_movement/);
  assert.match(store, /load_confirmations/);
  assert.match(styles, /\.load-confirm-layout/);
  assert.match(styles, /\.load-decision-success/);
  assert.match(styles, /\.status-loaded/);
});

test("active carts renew frequently and recover after handheld sleep", async () => {
  const app = await readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.setInterval\(\(\) => void renewLock\(\), 60_000\)/);
  assert.match(app, /window\.addEventListener\("focus", handleResume\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", handleResume\)/);
  assert.doesNotMatch(app, /Your cart lock expired/);
  assert.match(app, /Auto-renewing picklist leases/);
});

test("phone-sized screens keep compact scanning and full navigation", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../app/cartflow-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /window\.matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(app, /if \(phoneViewport\.matches && canOperate\) setView\("scan"\)/);
  assert.doesNotMatch(app, /compactScanner && nextView !== "scan"/);
  assert.match(app, /setView\(destination\)/);
  assert.doesNotMatch(app, /["'](?:putaway|capture)["']|WarehousePutaway|RawCapture|Capture data/, "removed screens must not be reachable from desktop or mobile navigation");
  const navigationSource = app.match(/<nav className="handheld-bottom"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navigationSource, "handheld navigation remains available");
  const compiledNavigation = ts.transpileModule(`const navigation = ${navigationSource};`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const renderNavigation = new Function("React", "receivingBusy", "view", "navigateTo", `${compiledNavigation}; return navigation;`);
  const destinations = [];
  const navigation = renderNavigation(React, false, "receive", (destination) => destinations.push(destination));
  assert.deepEqual(navigation.props.children.map((button) => button.props.children), ["Receive", "Pack", "Load"]);
  assert.doesNotMatch(renderToStaticMarkup(navigation), />Capture<|>Putaway</);
  for (const button of navigation.props.children) button.props.onClick();
  assert.deepEqual(destinations, ["receive", "scan", "load"]);

  assert.match(styles, /\.compact-scanner \.setup-page-heading,[\s\S]*\.compact-scanner \.setup-rail \{ display: none; \}/);
  assert.match(styles, /\.compact-scanner \.main-content,[\s\S]*min-height: 100dvh/);
  assert.match(styles, /\.view-scan \.topbar \{ display: grid; \}/);
});
