"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { request } from "@/lib/client-request";
import type { InventoryItem, InventoryReceiveResult as ReceiptResult } from "@/lib/inventory-types";
import { cleanScannerPayload, detectDemandBarcode, DEMAND_SCAN_ORDER } from "@/lib/scan-values";
import { captureReceivingBarcode, nextReceivingField, receivingDemandMismatch, RECEIVING_SCAN_ORDER, type ReceivingDemand } from "@/lib/receive-label";
import { announceScan, speakScanPrompt, preloadScanVoices, playLabelCompleteBeep, prepareScanAudio } from "@/lib/scan-audio";
import { packingScanFeedback, receivingScanFeedback } from "@/lib/scan-feedback";
import { partAttributeLabels, type FulfillmentSettings } from "@/lib/fulfillment-settings";
import "./receive-inventory.css";

const FIELDS = [
  { prefix: "1S", label: "Serial", instruction: "Scan serial", field: "aiagSerial" },
  { prefix: "P", label: "Part number", instruction: "Scan part number", field: "partNumber" },
  { prefix: "C", label: "Color", instruction: "Scan color", field: "color" },
  { prefix: "Q", label: "Quantity", instruction: "Scan quantity", field: "quantity" },
] as const;

export type ReceiveCheckResult = true | {
  reason: "demand_fulfilled" | "no_matching_demand";
  message: string;
};

type ReceiptDraft = {
  version: 1;
  captureId: string;
  receiptSessionId: string;
  operatorName: string;
  unitOfMeasure: string;
  supplierId: string;
  inventoryId: string;
  rawValues: string[];
  step: number;
  input: string;
  editing: boolean;
  attempted: boolean;
  result: ReceiptResult | null;
};

const emptyDraft = (): ReceiptDraft => ({
  version: 1, captureId: "", receiptSessionId: "", operatorName: "", unitOfMeasure: "EA", supplierId: "", inventoryId: "", rawValues: ["", "", "", ""],
  step: 0, input: "", editing: false, attempted: false, result: null,
});
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

function createReceiptId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validReceipt(value: unknown): value is ReceiptResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReceiptResult>;
  const inventory = candidate.inventory;
  return candidate.ok === true && typeof candidate.created === "boolean" && typeof candidate.duplicate === "boolean"
    && candidate.created !== candidate.duplicate && Boolean(inventory)
    && typeof inventory?.id === "string" && typeof inventory.serial === "string"
    && typeof inventory.partNumber === "string" && typeof inventory.partMark === "string"
    && Number.isFinite(inventory.quantity) && inventory.quantity > 0
    && typeof inventory.receivedAt === "string" && typeof inventory.receivedBy === "string"
    && inventory.isTest === false;
}

function loadDraft(key: string): ReceiptDraft | null {
  const stored = sessionStorage.getItem(key);
  if (!stored) return null;
  const value: unknown = JSON.parse(stored);
  if (!value || typeof value !== "object") throw new Error("Invalid saved receipt.");
  const candidate = value as ReceiptDraft;
  if (candidate.version !== 1 || !Array.isArray(candidate.rawValues) || candidate.rawValues.length !== 4
    || candidate.rawValues.some((value) => typeof value !== "string" || value.length > 512)
    || typeof candidate.input !== "string" || candidate.input.length > 1024
    || !Number.isInteger(candidate.step) || candidate.step < 0 || candidate.step > 4
    || typeof candidate.operatorName !== "string" || typeof candidate.editing !== "boolean"
    || typeof candidate.attempted !== "boolean"
    || (candidate.captureId !== "" && !UUID.test(candidate.captureId))
    || (candidate.receiptSessionId !== "" && !UUID.test(candidate.receiptSessionId))
    || (candidate.attempted && (!UUID.test(candidate.captureId) || !UUID.test(candidate.receiptSessionId)
      || candidate.rawValues.some((value) => !value)))
    || (candidate.result !== null && !validReceipt(candidate.result))) {
    throw new Error("Invalid saved receipt.");
  }
  return { ...candidate, unitOfMeasure: candidate.unitOfMeasure || "EA", supplierId: candidate.supplierId || "", inventoryId: candidate.inventoryId || "", step: candidate.attempted ? 4 : candidate.editing ? candidate.step : candidate.rawValues.filter(Boolean).length };
}

function persistDraft(key: string, draft: ReceiptDraft) {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

function hasDraft(draft: ReceiptDraft) {
  return !draft.result && (draft.attempted || Boolean(draft.input) || draft.rawValues.some(Boolean));
}

function displayValue(raw: string, emptyLabel: string) {
  return /^(2P|C)$/i.test(raw) ? emptyLabel : detectDemandBarcode(raw)?.value || "";
}

export function ReceiveInventory({ operatorName, ownerId = "local", active = true, initialSerial = "", initialInventory, unitOfMeasure = "EA", supplierId = "", expectedDemand, partAttribute, contextKey = "", autoContinue = false, editableMetadata = false, beforeReceive, onSkip, onContinue, onBusyChange, onReceived, onDraftChange }: {
  operatorName: string;
  ownerId?: string;
  active?: boolean;
  initialSerial?: string;
  initialInventory?: InventoryItem;
  unitOfMeasure?: string;
  supplierId?: string;
  expectedDemand?: ReceivingDemand;
  partAttribute?: FulfillmentSettings["partAttribute"];
  contextKey?: string;
  autoContinue?: boolean;
  editableMetadata?: boolean;
  beforeReceive?: (captured: { rawValues: string[]; unitOfMeasure: string; supplierId: string }) => ReceiveCheckResult | Promise<ReceiveCheckResult>;
  onSkip?: () => void;
  onContinue?: (serial: string, supplierId: string) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onReceived?: (receipt: ReceiptResult) => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const attribute = partAttributeLabels(partAttribute);
  const fields = FIELDS.map((field) => field.field === "color" ? { ...field, label: attribute.label, prefix: attribute.prefix } : field);
  const storageKey = `cartflow.receiving.draft.v1:${encodeURIComponent(ownerId)}${contextKey ? `:${encodeURIComponent(contextKey)}` : ""}`;
  const [draft, setDraft] = useState<ReceiptDraft>(emptyDraft);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fulfilledMessage, setFulfilledMessage] = useState("");
  const [scanNotice, setScanNotice] = useState("");
  const [lastReceived, setLastReceived] = useState("");
  const [recoveryError, setRecoveryError] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const draftRef = useRef<ReceiptDraft>(emptyDraft());
  const busyRef = useRef(false);
  const completionAnnounced = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const callbacks = useRef({ onBusyChange, onDraftChange, onReceived });

  useEffect(() => { callbacks.current = { onBusyChange, onDraftChange, onReceived }; }, [onBusyChange, onDraftChange, onReceived]);
  useEffect(() => () => { callbacks.current.onBusyChange?.(false); }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const scannedSerial = cleanScannerPayload(initialSerial);
        const initial = { ...emptyDraft(), unitOfMeasure, supplierId };
        if (scannedSerial) {
          initial.rawValues[0] = /^1S/i.test(scannedSerial) ? scannedSerial : `1S${scannedSerial}`;
          initial.step = 1;
        }
        if (initialInventory) {
          initial.inventoryId = initialInventory.id;
          initial.unitOfMeasure = initialInventory.unitOfMeasure || "EA";
          initial.supplierId = initialInventory.supplierId || "";
          initial.rawValues = [`1S${initialInventory.serial}`, `P${initialInventory.partNumber}`, initialInventory.color ? `C${initialInventory.color}` : `2P${initialInventory.partLevel || initialInventory.partMark || ""}`, `Q${initialInventory.quantity}`];
          initial.step = 4;
          initial.captureId = createReceiptId();
          initial.receiptSessionId = createReceiptId();
        }
        const saved = loadDraft(storageKey) || initial;
        draftRef.current = saved;
        completionAnnounced.current = Boolean(saved.result);
        setDraft(saved);
        callbacks.current.onDraftChange?.(hasDraft(saved));
      } catch {
        setRecoveryError(true);
        callbacks.current.onDraftChange?.(true);
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [storageKey, initialSerial, initialInventory, unitOfMeasure, supplierId]);

  const commitDraft = useCallback((next: ReceiptDraft) => {
    draftRef.current = next;
    setDraft(next);
    callbacks.current.onDraftChange?.(hasDraft(next));
    return persistDraft(storageKey, next);
  }, [storageKey]);

  useEffect(() => {
    if (!active || !ready || busy || recoveryError) return;
    const frame = requestAnimationFrame(() => {
      const target = draft.step < 4 && !discardConfirm && !draft.result ? inputRef.current : titleRef.current;
      if (target?.getClientRects().length) {
        window.scrollTo({ top: 0, behavior: "instant" });
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, ready, busy, recoveryError, draft.step, draft.result, discardConfirm, fulfilledMessage]);

  useEffect(() => {
    if (!hasDraft(draft) && !recoveryError) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [draft, recoveryError]);

  function focusScan(select = false) {
    requestAnimationFrame(() => {
      if (!active || !inputRef.current?.getClientRects().length) return;
      inputRef.current.focus({ preventScroll: true });
      if (select) inputRef.current.select();
    });
  }

  function acceptScan(scannedValue?: string) {
    const current = draftRef.current;
    if (busyRef.current || current.attempted || current.step >= 4) return;
    const audioContext = prepareScanAudio();
    const result = captureReceivingBarcode(current.rawValues, scannedValue ?? current.input, current.editing ? current.step : null, current.unitOfMeasure, expectedDemand, partAttribute);
    if (result.status !== "accepted") {
      commitDraft({ ...current, input: "" });
      setError(result.message);
      speakScanPrompt(receivingScanFeedback(result));
      focusScan(true);
      return;
    }
    const next = {
      ...current, rawValues: result.rawValues, input: "", step: result.count, editing: false,
      captureId: current.captureId || createReceiptId(), receiptSessionId: current.receiptSessionId || createReceiptId(),
      operatorName: current.operatorName || operatorName.trim(),
    };
    commitDraft(next);
    setError("");
    setScanNotice(result.message);
    announceScan(result.field, audioContext);
    if (result.completed) {
      void receive();
    }
  }

  function onScannerKey(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
      if (event.key === "Tab" && !draftRef.current.input) return;
      event.preventDefault();
      acceptScan();
    }
  }

  function editField(index: number) {
    const current = draftRef.current;
    if (current.attempted || busyRef.current) return;
    commitDraft({ ...current, step: index, editing: true, input: "" });
    setError("");
    setScanNotice("");
    setFulfilledMessage("");
  }

  function resetDraft() {
    const current = draftRef.current;
    if (busyRef.current || (current.attempted && !current.result)) return;
    const next = { ...emptyDraft(), receiptSessionId: current.receiptSessionId, unitOfMeasure: expectedDemand?.unitOfMeasure || (expectedDemand ? "EA" : current.unitOfMeasure), supplierId: current.supplierId };
    const scannedSerial = cleanScannerPayload(initialSerial);
    if (scannedSerial) {
      next.rawValues[0] = /^1S/i.test(scannedSerial) ? scannedSerial : `1S${scannedSerial}`;
      next.step = 1;
    }
    commitDraft(next);
    completionAnnounced.current = false;
    setDiscardConfirm(false);
    setError("");
    setScanNotice("");
    setFulfilledMessage("");
  }

  async function receive() {
    const current = draftRef.current;
    if (busyRef.current || current.result || current.step !== 4 || current.rawValues.some((value) => !value)) return;
    const audioContext = prepareScanAudio();
    // Preserve uncertain receipt retries exactly. Before the first write, also
    // validate recovered drafts and expected stock against the current demand.
    const mismatch = !current.attempted && receivingDemandMismatch(current.rawValues, expectedDemand, current.unitOfMeasure, partAttribute);
    if (mismatch) {
      setError(mismatch.message);
      speakScanPrompt(receivingScanFeedback({ status: "mismatch", field: mismatch.field }));
      return;
    }
    const receiptOperator = current.attempted ? current.operatorName : operatorName.trim();
    if (!receiptOperator) {
      setError("Set your operator name in the station menu before receiving inventory.");
      return;
    }
    if (beforeReceive && !current.attempted) {
      const proceed = await beforeReceive({ rawValues: current.rawValues, unitOfMeasure: current.unitOfMeasure, supplierId: current.supplierId });
      if (proceed !== true) {
        if (proceed.reason === "demand_fulfilled") setFulfilledMessage(proceed.message);
        else setError(proceed.message);
        speakScanPrompt(packingScanFeedback(proceed.reason));
        return;
      }
    }
    const wasUncertain = current.attempted;
    const pending = { ...current, operatorName: receiptOperator, attempted: true };
    // The exact request identity must survive a reload before any write is sent.
    if (!persistDraft(storageKey, pending)) {
      setError("This browser cannot save the receipt draft. Enable site storage, then try again.");
      return;
    }
    commitDraft(pending);
    busyRef.current = true;
    callbacks.current.onBusyChange?.(true);
    setBusy(true);
    setError("");
    let confirmed: ReceiptResult | null = null;
    try {
      const response = await request("/api/inventory/receive", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captureId: pending.captureId, receiptSessionId: pending.receiptSessionId,
          ...(pending.inventoryId ? { inventoryId: pending.inventoryId } : { rawValues: pending.rawValues, unitOfMeasure: pending.unitOfMeasure, supplierId: pending.supplierId }), operatorName: pending.operatorName }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error : "The receipt could not be confirmed.";
        const definiteRejection = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
        if (definiteRejection && !wasUncertain) commitDraft({ ...pending, attempted: false });
        throw new Error(message);
      }
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !validReceipt(result)) {
        throw new Error("The server returned an unreadable receipt.");
      }
      confirmed = result;
      commitDraft({ ...pending, result });
    } catch (failure) {
      const message = draftRef.current.attempted
        ? "Receipt not confirmed. Retry to check and finish this same receipt."
        : failure instanceof Error ? failure.message : "Unable to receive this container. Try again.";
      setError(message);
      speakScanPrompt("receiptNotConfirmed");
    } finally {
      busyRef.current = false;
      callbacks.current.onBusyChange?.(false);
      setBusy(false);
    }
    if (confirmed) {
      if (confirmed.duplicate) announceScan("duplicate", audioContext);
      if (confirmed.created && !completionAnnounced.current && !autoContinue) {
        completionAnnounced.current = true;
        playLabelCompleteBeep(audioContext);
      }
      callbacks.current.onReceived?.(confirmed);
      if (autoContinue && onContinue) {
        await onContinue(confirmed.inventory.serial, confirmed.inventory.supplierId || "");
      } else if (!onContinue) {
        resetDraft();
        setLastReceived(confirmed.inventory.serial);
      }
    }
  }

  if (!ready) return <section className="handheld-task receive-inventory"><p role="status">Opening receiving…</p></section>;

  if (recoveryError) return <section className="handheld-task receive-inventory" aria-labelledby="receive-recovery-title">
    <span className="receive-context">Receive inventory</span>
    <h1 id="receive-recovery-title">Check saved receipt</h1>
    <p role="alert">The saved receipt could not be opened. Keep this page open and ask your supervisor to check it before scanning again.</p>
  </section>;

  if (fulfilledMessage) return <section className="handheld-task receive-inventory" aria-labelledby="receive-fulfilled-title">
    <h1 id="receive-fulfilled-title" ref={titleRef} tabIndex={-1}>Already fulfilled</h1>
    <p role="status">{fulfilledMessage}</p>
    <button className="receive-action receive-primary" onClick={() => { resetDraft(); onSkip?.(); }}>Continue</button>
  </section>;

  if (discardConfirm) return <section className="handheld-task receive-inventory" aria-labelledby="receive-reset-title">
    <span className="receive-context">Receive inventory</span>
    <h1 id="receive-reset-title" ref={titleRef} tabIndex={-1}>Start this label over?</h1>
    <p>The scanned values will be cleared. No inventory has been received.</p>
    <button className="receive-action receive-primary" onClick={() => setDiscardConfirm(false)}>Keep scanning</button>
    <button className="receive-action receive-secondary" onClick={resetDraft}>Clear this label</button>
  </section>;

  if (draft.result) {
    const { inventory, duplicate } = draft.result;
    return <section className="handheld-task receive-inventory receive-complete" aria-labelledby="receive-complete-title">
      <span className="receive-context">Receive inventory</span>
      <div className={`receive-outcome ${duplicate ? "receive-outcome-existing" : ""}`} aria-hidden="true">✓</div>
      <h1 id="receive-complete-title" ref={titleRef} tabIndex={-1}>{duplicate ? "Already received" : "Inventory received"}</h1>
      <p role="status">{duplicate ? "This container is already in inventory. Nothing was added again." : "This container is now in inventory."}</p>
      <p className="receive-container-serial">{inventory.serial}</p>
      <button className="receive-action receive-primary" onClick={() => onContinue ? onContinue(inventory.serial, inventory.supplierId || "") : resetDraft()}>{onContinue ? "Use container to fulfill demand" : "Next container"}</button>
      {onContinue && <button className="receive-action receive-secondary" onClick={() => { resetDraft(); onSkip?.(); }}>Scan another container</button>}
      <details className="receive-details"><summary>Receipt details</summary><dl className="receive-summary"><div><dt>Part number</dt><dd>{inventory.partNumber}</dd></div><div><dt>Color</dt><dd>{inventory.color || inventory.partMark || "No color"}</dd></div><div><dt>Quantity</dt><dd>{inventory.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} {inventory.unitOfMeasure || "EA"}</dd></div></dl><p>Received by {inventory.receivedBy}</p><p>{new Date(inventory.receivedAt).toLocaleString()}</p><p className="receive-reference">Receipt {inventory.id}</p></details>
    </section>;
  }

  const metadataControls = editableMetadata && !draft.inventoryId && !draft.attempted && <details className="receive-metadata-options">
    <summary>Container unit &amp; supplier · {draft.unitOfMeasure}{draft.supplierId ? ` · ${draft.supplierId}` : ""}</summary>
    <div className="receive-metadata"><label>Unit of measure<select value={draft.unitOfMeasure} onChange={(event) => { commitDraft({ ...draftRef.current, unitOfMeasure: event.target.value }); setError(""); }}>
      {["EA", "KG", "G", "MG", "M", "CM", "MM", "L", "ML", "LB", "OZ", "FT", "IN"].map((unit) => <option key={unit}>{unit}</option>)}
    </select></label>
    <label>Supplier ID<input value={draft.supplierId} maxLength={180} onChange={(event) => { commitDraft({ ...draftRef.current, supplierId: event.target.value }); setError(""); }} autoComplete="off" /></label></div>
  </details>;

  if (draft.step === 4) return <section className="handheld-task receive-inventory" aria-labelledby="receive-review-title" aria-busy={busy}>
    <span className="receive-context">Receive inventory</span>
    <h1 id="receive-review-title" ref={titleRef} tabIndex={-1}>{busy ? "Saving container…" : draft.attempted ? "Check receipt" : draft.inventoryId ? "Confirm expected container" : "Review container"}</h1>
    <p role="status">{busy ? "All container values captured. Saving to inventory." : draft.attempted ? "Keep this label unchanged until the receipt is confirmed." : draft.inventoryId ? "This container is expected. Confirm that it is physically present before using it to fulfil demand." : "All container values captured. This container has not been saved yet."}</p>
    <dl className="receive-review">{fields.map((field, index) => <div key={field.prefix}><div><dt>{field.label}</dt><dd>{displayValue(draft.rawValues[index], attribute.empty)}</dd></div>{!draft.attempted && !draft.inventoryId && <button className="receive-edit" onClick={() => editField(index)} aria-label={`Rescan ${field.label.toLowerCase()}`}>Edit</button>}</div>)}</dl>
    <p>Unit: <strong>{draft.unitOfMeasure}</strong>{draft.supplierId && <> · Supplier: <strong>{draft.supplierId}</strong></>}</p>
    {metadataControls}
    {error && <p className="receive-error" role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void receive(); }}><button className="receive-action receive-primary" type="submit" disabled={busy}>{busy ? "Saving…" : draft.attempted ? "Retry receipt" : draft.inventoryId ? "Confirm physical receipt" : "Receive inventory"}</button></form>
    {!draft.attempted && !draft.inventoryId && <button className="receive-action receive-secondary" onClick={() => setDiscardConfirm(true)}>Start over</button>}
  </section>;

  const expected = nextReceivingField(draft.rawValues);
  const field = draft.editing ? fields[draft.step] : fields.find((entry) => entry.field === expected);
  const capturedCount = draft.rawValues.filter(Boolean).length;
  const requiredValue = expectedDemand && field && field.field !== "aiagSerial"
    ? field.field === "quantity" ? `${expectedDemand.quantity} ${expectedDemand.unitOfMeasure || "EA"}`
      : expectedDemand[field.field] || attribute.empty
    : null;
  return <section className="handheld-task receive-inventory" aria-labelledby="receive-scan-title">
    <div className="receive-context">{expectedDemand ? "New container" : "Receive inventory"} <span>{draft.editing ? "Edit value" : `${capturedCount + 1} / 4`}</span></div>
    <h1 id="receive-scan-title">{draft.editing ? "Rescan" : "Scan"} {field?.label.toLowerCase()}</h1>
    {requiredValue !== null && <div className="receive-required"><span>{field?.field === "quantity" && expectedDemand?.packingMode === "multiple" ? "Remaining demand · scan the full container quantity" : "Required by demand"}</span><strong>{requiredValue}</strong></div>}
    <p id="receive-scan-help">{field && <>Scan <strong>{field.field === "color" ? (attribute.prefix === "C" ? "C or 2P" : "2P or C") : field.prefix}</strong> from this container’s label.{field.field === "color" && <> If there is no color, scan quantity (Q) next or choose No color.</>}</>}</p>
    <form onSubmit={(event) => { event.preventDefault(); acceptScan(); }}>
      <label className="receive-sr-only" htmlFor="receive-barcode">{field ? `${field.label} barcode` : "Scan any label barcode"}</label>
      <input id="receive-barcode" ref={inputRef} value={draft.input}
        className="receive-input" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false}
        maxLength={1024} placeholder={field ? `${field.prefix}…` : "Scan any barcode…"} enterKeyHint="next" inputMode="none"
        aria-describedby={`receive-scan-help${error ? " receive-scan-error" : ""}`} aria-invalid={Boolean(error)}
        onChange={(event) => { commitDraft({ ...draftRef.current, input: event.target.value }); setError(""); }}
        onPointerDown={preloadScanVoices} onKeyDown={onScannerKey} />
      {error && <p id="receive-scan-error" className="receive-error" role="alert">{error}</p>}
      {!error && <p className="receive-sr-only" role="status">{scanNotice}</p>}
      {draft.input && <button className="receive-action receive-primary" type="submit">{draft.editing ? "Update value" : "Check scan"}</button>}
      {field?.field === "color" && (!expectedDemand || !expectedDemand.color) && <button className="receive-action receive-secondary" type="button" onClick={() => acceptScan(attribute.prefix)}>{attribute.empty}</button>}
    </form>
    {!draft.editing && <p className="receive-auto-save-note">{autoContinue ? "Checks and packs automatically." : "Saves automatically. Keep scanning."}</p>}
    {lastReceived && !capturedCount && <p className="receive-last" role="status">✓ {lastReceived} received</p>}
    {draft.editing ? <button className="receive-action receive-secondary" onClick={() => { commitDraft({ ...draftRef.current, step: draftRef.current.rawValues.filter(Boolean).length, editing: false, input: "" }); setError(""); }}>Cancel edit</button>
      : <details className="receive-details"><summary>Details &amp; options</summary>
        <dl className="receive-capture-grid" aria-label="Label capture progress">{RECEIVING_SCAN_ORDER.map((key) => { const index = DEMAND_SCAN_ORDER.indexOf(key); const entry = fields[index]; return <div key={entry.prefix} className={draft.rawValues[index] ? "receive-captured" : ""}>
          <dt><span aria-hidden="true">{draft.rawValues[index] ? "✓" : entry.prefix}</span> {entry.label}</dt>
          <dd>{displayValue(draft.rawValues[index], attribute.empty) || "Waiting"}</dd>
          {draft.rawValues[index] && <button className="receive-edit" onClick={() => editField(index)} aria-label={`Rescan ${entry.label.toLowerCase()}`}>Edit</button>}
        </div>; })}</dl>
        <div className="receive-metadata"><label>Unit of measure<select value={draft.unitOfMeasure} disabled={Boolean(expectedDemand) || Boolean(draft.rawValues[3]) || draft.attempted} onChange={(event) => commitDraft({ ...draftRef.current, unitOfMeasure: event.target.value })}>{["EA", "KG", "G", "MG", "M", "CM", "MM", "L", "ML", "LB", "OZ", "FT", "IN"].map((unit) => <option key={unit}>{unit}</option>)}</select></label><label>Supplier ID (if supplied)<input value={draft.supplierId} maxLength={80} disabled={draft.attempted} onChange={(event) => commitDraft({ ...draftRef.current, supplierId: event.target.value })} autoComplete="off" /></label></div>
        {capturedCount > 0 && <button className="receive-action receive-secondary" onClick={() => setDiscardConfirm(true)}>Start over</button>}
      </details>}
  </section>;
}
