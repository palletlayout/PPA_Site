"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { request as fetch } from "@/lib/client-request";
import { CameraScanner } from "@/app/camera-scanner";
import { buildTestDemandContext } from "@/lib/demand-capture";
import { captureLabelBarcode, type LabelCapture } from "@/lib/label-capture";
import { announceScan, playLabelCompleteBeep, prepareScanAudio } from "@/lib/scan-audio";
import {
  DEMAND_SCAN_LABELS,
  DEMAND_SCAN_ORDER,
  DEMAND_SCAN_PREFIXES,
  type DemandScanField,
} from "@/lib/scan-values";

type CaptureResult = {
  inventoryId?: string;
  inventoryCreated?: boolean;
  lineId?: string;
  sequence?: string;
  loadNumber?: string;
  picklistNumber?: string;
  cartNumber?: string;
  partNumber?: string;
  duplicate?: boolean;
  testMode?: boolean;
  checksheetNumber?: string;
  orderNumber?: string;
  batchNumber?: string;
  cartBarcode?: string;
  projectionStatus?: "created" | "existing" | "failed";
  inventory?: {
    id: string;
    created: boolean;
    idempotentReplay: boolean;
    existingSerial: boolean;
    status: string;
    source: string;
    aiagSerial: string;
    partNumber: string;
    partLevel: string;
    quantity: number;
    capturedAt: string;
  };
  testProjection?: {
    status: "created" | "existing" | "failed";
    demandDetailId?: string;
    loadNumber?: string;
    sequence?: string;
    error?: string;
  };
  error?: string;
};

type SessionResult = {
  id: string;
  text: string;
  duplicate: boolean;
};

type LoadDemandScannerProps = {
  initialTestSessionId: string;
  operatorName: string;
  onClose: () => void;
  onAdded: (duplicate: boolean) => Promise<void> | void;
};

export function LoadDemandScanner({
  initialTestSessionId,
  operatorName,
  onClose,
  onAdded,
}: LoadDemandScannerProps) {
  const [testSessionId, setTestSessionId] = useState(initialTestSessionId);
  const [generatedCartBarcode, setGeneratedCartBarcode] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [captured, setCaptured] = useState<LabelCapture>({});
  const capturedRef = useRef<LabelCapture>({});
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info" | "success"; text: string } | null>(null);
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [sessionAddedCount, setSessionAddedCount] = useState(0);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const captureIdRef = useRef("");

  const updateCaptured = (next: LabelCapture) => {
    capturedRef.current = next;
    setCaptured(next);
  };

  const testContext = useMemo(
    () => testSessionId ? buildTestDemandContext(testSessionId) : null,
    [testSessionId],
  );
  const destinationReady = Boolean(testContext);
  const capturedCount = DEMAND_SCAN_ORDER.filter((field) => captured[field]).length;
  const labelComplete = capturedCount === DEMAND_SCAN_ORDER.length;
  const cameraInitialValues = Object.fromEntries(
    DEMAND_SCAN_ORDER.flatMap((field) => captured[field] ? [[field, captured[field]!.rawValue]] : []),
  ) as Partial<Record<DemandScanField, string>>;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => labelInputRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cameraOpen) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [cameraOpen, destinationReady, onClose]);

  const startNewTestLoad = () => {
    if (busyRef.current) return;
    setTestSessionId(crypto.randomUUID());
    setGeneratedCartBarcode("");
    updateCaptured({});
    setLabelInput("");
    captureIdRef.current = "";
    setMessage({
      tone: "info",
      text: "A new test inventory session is ready. Scan the four real label values; PPA will generate only the linked test-demand fields.",
    });
    window.setTimeout(() => labelInputRef.current?.focus(), 40);
  };

  const captureOne = (suppliedValue: string) => {
    if (busyRef.current || !destinationReady) return false;
    const result = captureLabelBarcode(capturedRef.current, suppliedValue);
    if (result.status === "invalid" || result.status === "conflict") {
      setMessage({ tone: "error", text: result.message });
      return false;
    }
    if (result.status === "accepted") {
      captureIdRef.current = "";
      updateCaptured(result.captured);
      announceScan(result.field);
      if (result.completed) playLabelCompleteBeep();
    }
    if (result.status === "duplicate") announceScan("duplicate");
    setLabelInput("");
    setMessage({ tone: result.status === "duplicate" ? "info" : "success", text: result.message });
    window.setTimeout(() => labelInputRef.current?.focus(), 40);
    return true;
  };

  const captureCameraBatch = (rawValues: string[]) => {
    if (busyRef.current || !destinationReady) return;
    let next = capturedRef.current;
    let completed = false;
    for (const rawValue of rawValues) {
      const result = captureLabelBarcode(next, rawValue);
      if (result.status === "invalid" || result.status === "conflict") {
        setMessage({ tone: "error", text: result.message });
        setCameraOpen(false);
        return;
      }
      next = result.captured;
      completed ||= result.completed;
    }
    if (!DEMAND_SCAN_ORDER.every((field) => next[field])) {
      setMessage({ tone: "error", text: "The camera did not capture all four barcode types. Keep scanning the missing values." });
      setCameraOpen(false);
      return;
    }
    if (next !== capturedRef.current) {
      captureIdRef.current = "";
      updateCaptured(next);
    }
    if (completed) playLabelCompleteBeep();
    setCameraOpen(false);
    setMessage({
      tone: "success",
      text: testContext
        ? "Physical label captured. Review the four values, then add it to the generated test load."
        : "Physical label captured. Review the four values, then add it to the selected load.",
    });
  };

  const clearField = (field: DemandScanField) => {
    if (busyRef.current) return;
    const next = { ...capturedRef.current };
    delete next[field];
    updateCaptured(next);
    captureIdRef.current = "";
    setMessage(null);
    window.setTimeout(() => labelInputRef.current?.focus(), 40);
  };

  const addToInventory = async () => {
    if (!destinationReady || !labelComplete || busyRef.current) return;
    if (!operatorName.trim()) {
      setMessage({ tone: "error", text: "Enter an operator name before saving physical inventory." });
      return;
    }
    const captureId = captureIdRef.current || crypto.randomUUID();
    captureIdRef.current = captureId;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/inventory/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId,
          testSessionId: testContext!.sessionId,
          rawValues: DEMAND_SCAN_ORDER.map((field) => captured[field]!.rawValue),
          operatorName: operatorName.trim(),
        }),
      });
      const result = await response.json() as CaptureResult;
      if (!response.ok) throw new Error(result.error || "Unable to capture this physical inventory label.");
      if (result.testMode && result.cartBarcode) setGeneratedCartBarcode(result.cartBarcode);
      const inventoryCreated = result.inventory?.created ?? Boolean(result.inventoryCreated);
      const partNumber = result.inventory?.partNumber || result.partNumber || captured.partNumber?.value;
      const projectionFailed = result.projectionStatus === "failed";
      const text = projectionFailed
        ? `Inventory saved for ${partNumber}. The linked test demand still needs attention: ${result.testProjection?.error || "projection could not be completed"}. Retry this label or start a new test load.`
        : inventoryCreated
          ? `Inventory saved: ${partNumber} is available, and its test projection was added to load ${result.loadNumber || testContext!.loadNumber} as sequence ${result.sequence}.`
          : `Inventory serial ${result.inventory?.aiagSerial || captured.aiagSerial?.value} was already captured. Its test projection is ready in load ${result.loadNumber || testContext!.loadNumber}.`;
      setSessionResults((current) => [
        { id: crypto.randomUUID(), text, duplicate: !inventoryCreated },
        ...current,
      ].slice(0, 5));
      if (inventoryCreated) setSessionAddedCount((current) => current + 1);
      setMessage({ tone: projectionFailed || !inventoryCreated ? "info" : "success", text });
      if (projectionFailed) return;
      captureIdRef.current = "";
      updateCaptured({});
      setLabelInput("");
      await onAdded(!inventoryCreated);
      window.setTimeout(() => labelInputRef.current?.focus(), 40);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to capture this physical inventory label." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="demand-capture-backdrop" role="presentation">
      <section className="demand-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="demand-capture-title">
        <header className="demand-capture-heading">
          <div><p className="eyebrow">Inventory label intake · Test utility</p><h2 id="demand-capture-title">Scan physical labels</h2><p>The label values create test inventory and a separate pending demand record for the same part, color, and quantity. Scan the cart, then the inventory serial to test fulfillment.</p></div>
          <button ref={closeRef} className="camera-close" onClick={onClose} aria-label="Close physical label intake">×</button>
        </header>

        <div className="demand-capture-steps">
          <section className={destinationReady ? "capture-step capture-step-complete" : "capture-step capture-step-active"}>
            <div className="capture-step-heading"><span>{destinationReady ? "✓" : "1"}</span><div><small>Storage model</small><strong>Inventory first · test demand second</strong></div></div>
            {!testContext ? <button className="capture-test-start" type="button" onClick={startNewTestLoad}>
                <span>TEST</span>
                <div><strong>Start a test inventory session</strong><small>Scan serial, part, color when present, and quantity. PPA stores inventory, then makes linked test demand.</small></div>
                <b aria-hidden="true">→</b>
              </button> : <div className="capture-target-summary capture-test-summary">
              <div><span>Inventory</span><strong>Physical-label capture</strong><small>Saved as available inventory and marked as test data</small></div>
              <div><span>Demand adapter</span><strong>Generated TEST projection</strong><small>Never appended to an existing production load</small></div>
              <div><span>Load</span><strong>{testContext.loadNumber}</strong></div>
              <div><span>Checksheet</span><strong>{testContext.checksheetNumber}</strong></div>
              <div><span>Cart</span><strong>{testContext.cartNumber}</strong><small>{testContext.cartId}</small></div>
              <div><span>PPA Cart ID</span><strong>{generatedCartBarcode || "Generated after first label"}</strong></div>
              <div><span>Order / batch</span><strong>{testContext.orderNumber}</strong><small>{testContext.batchNumber}</small></div>
              <p>The scanned values remain the inventory source of truth. Generated load fields are test scaffolding only. Add every label before packing because the test load closes to new demand after its first fulfilled part.</p>
              <button className="text-button" onClick={startNewTestLoad}>Start a new test load</button>
            </div>}
          </section>

          <section className={`capture-step ${destinationReady ? "capture-step-active" : "capture-step-disabled"}`}>
            <div className="capture-step-heading"><span>2</span><div><small>Physical inventory label</small><strong>Capture serial, part, optional color, and quantity</strong></div><em>{capturedCount} / 4</em></div>
            <div className="capture-fields" aria-label={`${capturedCount} of 4 physical-label values captured`}>
              {DEMAND_SCAN_ORDER.map((field) => <article className={captured[field] ? "capture-field capture-field-ready" : "capture-field"} key={field}><span>{captured[field] ? "✓" : DEMAND_SCAN_PREFIXES[field]}</span><div><small>{DEMAND_SCAN_LABELS[field]}</small><strong>{captured[field] ? captured[field]!.value || "No color" : "Waiting"}</strong></div>{captured[field] && <button onClick={() => clearField(field)} aria-label={`Clear ${DEMAND_SCAN_LABELS[field]}`}>×</button>}</article>)}
            </div>

            <form className="capture-label-scan" onSubmit={(event) => { event.preventDefault(); if (labelInput.trim()) captureOne(labelInput); }}>
              <label><span>Scanner</span><input
                ref={labelInputRef}
                value={labelInput}
                onChange={(event) => setLabelInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Tab") { event.preventDefault(); if (labelInput.trim()) captureOne(labelInput); } }}
                disabled={!destinationReady || busy}
                placeholder="Scan the next 1S, P, 2P, or Q barcode…"
                autoComplete="off"
                inputMode="none"
                spellCheck={false}
                aria-label="Scan the next physical-label value: 1S, P, 2P, or Q"
              /></label>
              <button className="button button-secondary" type="button" disabled={!destinationReady || busy || labelComplete} onClick={() => { prepareScanAudio(); setCameraOpen(true); }}>Use camera</button>
              <button className="button button-primary" type="submit" disabled={!destinationReady || !labelInput.trim() || busy}>Capture</button>
            </form>

            {message && <div className={`capture-message capture-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div>}
            {!captured.color && <button className="button button-secondary" disabled={!destinationReady || busy} onClick={() => {
              captureIdRef.current = "";
              updateCaptured({ ...capturedRef.current, color: { rawValue: "C", value: "" } });
              setMessage({ tone: "success", text: "No color selected. Continue with the remaining label values." });
            }}>No color</button>}
            <div className="capture-actions"><button className="button button-secondary" disabled={!capturedCount || busy} onClick={() => { captureIdRef.current = ""; updateCaptured({}); setMessage(null); }}>Clear label</button><button className="button button-primary" disabled={!destinationReady || !labelComplete || busy} onClick={() => void addToInventory()}>{busy ? "Saving…" : "Save inventory + create test demand →"}</button></div>
          </section>
        </div>

        <footer className="capture-session-footer"><div><strong>Inventory saved this session</strong><span>{sessionAddedCount}</span></div>{sessionResults.length ? <ul>{sessionResults.map((result) => <li className={result.duplicate ? "capture-result-duplicate" : ""} key={result.id}>{result.duplicate ? "Already in inventory" : "Inventory created"} · {result.text}</li>)}</ul> : <p>Scan one complete physical label. Inventory is saved before its linked test-demand projection is attempted.</p>}<button className="button button-secondary" onClick={onClose}>Done</button></footer>
      </section>

      {cameraOpen && <CameraScanner
        mode="capture"
        initialValues={cameraInitialValues}
        onClose={() => setCameraOpen(false)}
        onDetectedBatch={captureCameraBatch}
      />}
    </div>
  );
}
