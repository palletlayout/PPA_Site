"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { request as fetch } from "@/lib/client-request";
import { ConfirmationDialog, type Confirmation } from "@/app/confirmation-dialog";
import { OperationIcon } from "@/app/operation-icon";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/import-transport";
import { CameraScanner } from "@/app/camera-scanner";
import { LoadDemandScanner } from "@/app/load-demand-scanner";
import { ReceiveInventory, type ReceiveCheckResult } from "@/app/receive-inventory";
import { InventoryList } from "@/app/inventory-list";
import { InventoryLiveSummary } from "@/app/inventory-live-summary";
import { FulfillmentSettingsPanel } from "@/app/fulfillment-settings";
import { DEFAULT_FULFILLMENT_SETTINGS, partAttributeLabels } from "@/lib/fulfillment-settings";
import { packingReceiptForResult } from "@/lib/packing-scan";
import { fulfillmentAttemptAfterReset, prepareFulfillmentAttempt, recordFulfillmentResponse, restoreFulfillmentAttempt, type FulfillmentAttempt } from "@/lib/fulfillment-request";
import { comparePackingLines, packingLineLabel, packingMetrics, remainingDemand, shippingPriority } from "@/lib/packing-progress";
import { publishInventoryUpdate } from "@/lib/live-inventory";
import { parseDemandSpreadsheet } from "@/lib/spreadsheet-import";
import { playLabelCompleteBeep, playScanBeep, playScanErrorTone, prepareScanAudio, preloadScanVoices, speakScanPrompt } from "@/lib/scan-audio";
import { packingScanFeedback } from "@/lib/scan-feedback";
import { ScanBurstDetector } from "@/lib/scan-burst";
import { decideDrain, ScanQueue, settleScanInput } from "@/lib/scan-queue";
import { cleanScannerPayload, scanSerialBarcode } from "@/lib/scan-values";
import { parseQuantity } from "@/lib/quantity";
import { EMPTY_SUPERVISOR_FILTERS, filterSupervisorMovements, filterSupervisorPicklists, supervisorLineMatches, supervisorSearchMatches, visibleSupervisorSelection, type SupervisorFilters, type SupervisorStatus } from "@/lib/supervisor-filters";
import { capturedPackingContents, checkPackingDemand, packingDemandIsFulfilled, packingReceiptDefaults } from "@/lib/packing-demand";
import { conflictingPackingPicklists, matchingPackingReferences } from "@/app/packing-selection";
import { movementBarcodeMatches, picklistBarcodeMatches, normalizeIdentityBarcode, picklistIdentityKey } from "@/lib/cart-identity";
import type { InventoryItem } from "@/lib/inventory-types";
import "./packing.css";
import type { AppState, CartLine, DemandLinePatch, ImportRow } from "@/lib/types";

type View = "overview" | "receive" | "inventory" | "scan" | "load" | "import" | "manage";
type Notice = { tone: "success" | "error" | "info"; text: string } | null;
type ScanField = "cartBarcode" | "aiagSerial";
type ScanTask = { lineId: string; field: ScanField; label: string };
type ScanReceipt = { rawValue: string; value: string; complete?: boolean };
type ScanFeedback = {
  tone: "success" | "error";
  title: string;
  message: string;
  lineId: string;
  rawValue: string;
  value?: string;
  requiresContinue?: boolean;
} | null;

type DemandDraft = {
  loadNumber: string;
  trainNumber: string;
  picklistNumber: string;
  cartNumber: string;
  cartId: string;
  palletId: string;
  partNumber: string;
  description: string;
  color: string;
  quantity: string;
  unitOfMeasure: string;
};

type ImportMode = "spreadsheet" | "manual";

type ManualImportDraft = {
  plant: string;
  zone: string;
  areaType: "onsite" | "offsite";
  shipCategory: string;
  movementNumber: string;
  loadingSequence: string;
  picklistNumber: string;
  cartNumber: string;
  cartId: string;
  palletId: string;
  sequence: string;
  partNumber: string;
  description: string;
  color: string;
  quantity: string;
  unitOfMeasure: string;
  checksheetNumber: string;
  masterBarcode: string;
  movementBarcode: string;
  cartSequenceNumber: string;
};

type CartGroup = {
  key: string;
  requiresReconciliation: boolean;
  trainNumber: string;
  cartNumber: string;
  loadNumber: string;
  plant: string;
  zone: string;
  areaType: "onsite" | "offsite";
  picklistNumber: string;
  cartId: string;
  palletId: string;
  shipCategory: string;
  cartBarcode: string;
  loadedAt: string | null;
  loadedBy: string;
  dispatchedAt: string | null;
  lines: CartLine[];
  verified: number;
  total: number;
  lock: AppState["locks"][number] | null;
};

type LoadConfirmation = {
  tone: "success" | "error";
  title: string;
  message: string;
  /** The barcode that was scanned, so a result stays identifiable after the input is cleared. */
  cartBarcode?: string;
  cartNumber?: string;
  picklistNumber?: string;
  movementNumber?: string;
  alreadyLoaded?: boolean;
  dispatchedAt?: string | null;
  testMode?: boolean;
};

type MovementGroup = {
  key: string;
  areaType: "onsite" | "offsite";
  number: string;
  plant: string;
  zones: string[];
  carts: CartGroup[];
  lines: CartLine[];
  verified: number;
  total: number;
  picklistCount: number;
  status: SupervisorStatus;
  mismatchCount: number;
  lastActivity: string | null;
};

type PicklistGroup = {
  key: string;
  number: string;
  carts: CartGroup[];
  lines: CartLine[];
  verified: number;
  total: number;
  status: SupervisorStatus;
  mismatchCount: number;
  lastActivity: string | null;
};

const EMPTY_STATE: AppState = { lines: [], locks: [], events: [], lastImport: null, settings: DEFAULT_FULFILLMENT_SETTINGS };
const EMPTY_MANUAL_IMPORT: ManualImportDraft = {
  plant: "",
  zone: "",
  areaType: "offsite",
  shipCategory: "",
  movementNumber: "",
  loadingSequence: "",
  picklistNumber: "",
  cartNumber: "",
  cartId: "",
  palletId: "",
  sequence: "",
  partNumber: "",
  description: "",
  color: "",
  quantity: "1",
  unitOfMeasure: "EA",
  checksheetNumber: "",
  masterBarcode: "",
  movementBarcode: "",
  cartSequenceNumber: "",
};
export type CartFlowAccess = {
  principal: { id: string; name: string; role: "viewer" | "operator" | "supervisor" | "admin"; sessionId: string } | null;
  localMode: boolean;
  testToolsEnabled: boolean;
};
const LOCK_RELEASE_TIMEOUT_MS = 5_000;
const PICKLIST_RECONCILIATION_MESSAGE = "This picklist has conflicting legacy outbound cards. Packing is blocked. A supervisor must reconcile the demand to one outbound card per picklist before work can continue.";
const LOCK_RELEASE_WARNING = "PPA could not confirm the immediate release. The reservation will expire automatically.";

function createClientSessionId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}



function cartKey(line: CartLine | ImportRow) {
  const movement = line.areaType === "offsite" ? line.loadNumber : line.trainNumber;
  return [line.plant, line.areaType, movement, line.picklistNumber, line.cartNumber, line.cartId].join("::");
}

function picklistKey(line: CartLine | ImportRow) {
  const movement = line.areaType === "offsite" ? line.loadNumber : line.trainNumber;
  return [line.plant, line.areaType, movement, line.picklistNumber].join("::");
}

function movementLabel(areaType: "onsite" | "offsite") {
  return areaType === "onsite" ? "Train" : "Load";
}

function formatCentralTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function latestTimestamp(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function statusLabel(status: SupervisorStatus) {
  if (status === "short") return "Short";
  if (status === "dispatched") return "Dispatched";
  if (status === "loaded") return "Loaded";
  if (status === "done") return "Packed";
  if (status === "active") return "Packing";
  if (status === "attention") return "Attention";
  return "Unpacked";
}

function statusRank(status: SupervisorStatus) {
  return { short: 0, attention: 1, active: 2, ready: 3, done: 4, loaded: 5, dispatched: 6 }[status];
}

function summarizeStatus(lines: CartLine[], carts: CartGroup[], events: AppState["events"]) {
  const pendingLineIds = new Set(lines.filter((line) => line.status !== "verified").map((line) => line.id));
  const mismatchCount = events.filter((event) => !event.matched && pendingLineIds.has(event.lineId)).length;
  const verified = lines.filter((line) => line.status === "verified").length;
  const status: SupervisorStatus = lines.some((line) => line.status === "short") ? "short" : carts.some((cart) => cart.requiresReconciliation) ? "attention" : carts.length > 0 && carts.every((cart) => Boolean(cart.dispatchedAt))
    ? "dispatched"
    : carts.length > 0 && carts.every((cart) => Boolean(cart.loadedAt))
    ? "loaded"
    : mismatchCount
    ? "attention"
    : lines.length > 0 && verified === lines.length
      ? "done"
      : verified > 0 || lines.some((line) => line.fulfilledQuantity > 0 || line.status === "active") || carts.some((cart) => Boolean(cart.lock))
        ? "active"
        : "ready";
  return { status, mismatchCount, verified, total: lines.length };
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: SupervisorStatus }) {
  return <span className={`status-pill status-${tone}`}>{tone === "short" ? <span aria-label="Shortage">⚠</span> : <span className="status-dot" />}{children}</span>;
}


/** A request that never reached, or never heard back from, the server (offline, timeout, abort). */
function isNetworkFailure(error: unknown) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  // fetch rejects with a TypeError whose wording differs by browser; an application bug that
  // also throws a TypeError must not be announced as a network problem.
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

export function CartFlowApp({ initialAccess }: { initialAccess?: CartFlowAccess }) {
  const localMode = initialAccess?.localMode === true;
  const role = initialAccess?.principal?.role;
  const canOperate = localMode || role === "operator" || role === "supervisor" || role === "admin";
  const canManage = localMode || role === "supervisor" || role === "admin";
  const canReset = localMode;
  const testToolsEnabled = initialAccess?.testToolsEnabled === true;
  const [view, setView] = useState<View>("overview");
  const [compactScanner, setCompactScanner] = useState(false);
  const handheldWorkspace = view === "receive" || view === "scan" || view === "load";
  const demandWorkspace = view !== "receive" && view !== "inventory";
  const simpleHandheld = compactScanner && handheldWorkspace;
  const [handheldMenuOpen, setHandheldMenuOpen] = useState(false);
  const [manualCartSelection, setManualCartSelection] = useState(false);
  const [receivingBusy, setReceivingBusy] = useState(false);
  const receivingBusyRef = useRef(false);
  const [receivingDirty, setReceivingDirty] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const handleReceivingBusy = useCallback((busy: boolean) => { receivingBusyRef.current = busy; setReceivingBusy(busy); }, []);
  const handleInventoryReceived = useCallback(() => {
    setInventoryRevision((value) => value + 1);
    publishInventoryUpdate();
  }, []);
  const [allState, setState] = useState<AppState>(EMPTY_STATE);
  const [workScope, setWorkScope] = useState<"production" | "test">("production");
  const state = useMemo<AppState>(() => {
    const lines = allState.lines.filter((line) => {
      const isTest = line.plant === "TEST" && line.programId === "TESTSCAN" && String(line.pymtc || "").startsWith("TEST:");
      return isTest === (workScope === "test");
    });
    const ids = new Set(lines.map((line) => line.id));
    const keys = new Set(lines.map(cartKey));
    return { ...allState, lines, events: allState.events.filter((event) => ids.has(event.lineId)), locks: allState.locks.filter((lock) => keys.has(lock.cartKey)) };
  }, [allState, workScope]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(null);
  const confirmChange = (message: string, requiredText?: string, options: Pick<Confirmation, "title" | "confirmLabel"> = {}) => new Promise<boolean>((resolve) => {
    confirmationResolver.current?.(false);
    confirmationResolver.current = resolve;
    setConfirmation({ message, requiredText, ...options });
  });
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [selectedMovementKey, setSelectedMovementKey] = useState<string | null>(null);
  const [selectedPicklistKey, setSelectedPicklistKey] = useState<string | null>(null);
  const [operatorName, setOperatorName] = useState(initialAccess?.principal?.name || "Operator 01");
  const [sessionId, setSessionId] = useState("");
  const [scanPlant, setScanPlant] = useState<string | null>(null);
  const [packingMovementKey, setPackingMovementKey] = useState<string | null>(null);
  const [packingMovementValue, setPackingMovementValue] = useState("");
  const [serialSuppliers, setSerialSuppliers] = useState<{ serial: string; suppliers: string[] } | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [scanArea, setScanArea] = useState<"onsite" | "offsite" | null>(null);
  const [activeCartKey, setActiveCartKey] = useState<string | null>(null);
  const [activePicklistKey, setActivePicklistKey] = useState<string | null>(null);
  const [scanTasks, setScanTasks] = useState<ScanTask[]>([]);
  const [scanIndex, setScanIndex] = useState(0);
  const [scanValue, setScanValue] = useState("");
  const [lockBusyKey, setLockBusyKey] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // Scans that arrive while one is being checked wait here instead of being dropped.
  const scanQueue = useRef(new ScanQueue());
  const [queuedScans, setQueuedScans] = useState(0);
  const loadScanQueue = useRef(new ScanQueue());
  const [queuedLoadScans, setQueuedLoadScans] = useState(0);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const [scanReceipts, setScanReceiptsState] = useState<Record<string, ScanReceipt>>({});
  const scanReceiptsRef = useRef<Record<string, ScanReceipt>>({});
  const setScanReceipts = useCallback((update: Record<string, ScanReceipt> | ((current: Record<string, ScanReceipt>) => Record<string, ScanReceipt>)) => {
    const next = typeof update === "function" ? update(scanReceiptsRef.current) : update;
    scanReceiptsRef.current = next;
    setScanReceiptsState(next);
  }, []);
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback>(null);
  const [lastPacked, setLastPacked] = useState<{ serial: string; sequence: string } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [missingInventory, setMissingInventory] = useState<{ serial: string; capturing: boolean; inventory?: InventoryItem } | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("spreadsheet");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [manualImportDraft, setManualImportDraft] = useState<ManualImportDraft>(EMPTY_MANUAL_IMPORT);
  const [manualImportError, setManualImportError] = useState("");
  const [manualImportBusy, setManualImportBusy] = useState(false);
  const [manualImportResult, setManualImportResult] = useState("");
  const [pdfBusyArea, setPdfBusyArea] = useState<"onsite" | "offsite" | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [demandDraft, setDemandDraft] = useState<DemandDraft | null>(null);
  const [demandBusy, setDemandBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [dataResetRevision, setDataResetRevision] = useState(0);
  const [quickCartValue, setQuickCartValue] = useState("");
  const [loadStep, setLoadStep] = useState<"movement" | "cart">("movement");
  const [loadMovementValue, setLoadMovementValue] = useState("");
  const [loadCartValue, setLoadCartValue] = useState("");
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadConfirmation, setLoadConfirmation] = useState<LoadConfirmation | null>(null);
  const [loadDemandOpen, setLoadDemandOpen] = useState(false);
  const [loadDemandInitialTestSession, setLoadDemandInitialTestSession] = useState("");
  const scanInput = useRef<HTMLInputElement>(null);
  const quickCartInput = useRef<HTMLInputElement>(null);
  const loadInput = useRef<HTMLInputElement>(null);
  const scanAudioContext = useRef<AudioContext | null>(null);
  const scanBusyRef = useRef(false);
  const loadBusyRef = useRef(false);
  const lockBusyRef = useRef(false);
  const stateRequestId = useRef(0);
  const stateFetchInFlight = useRef(false);
  const stateValidator = useRef("");
  const importParseId = useRef(0);
  const clientSession = useRef("");
  const [supervisorFilters, setSupervisorFilters] = useState<SupervisorFilters>(EMPTY_SUPERVISOR_FILTERS);
  const [picklistSearch, setPicklistSearch] = useState("");
  const [demandSearch, setDemandSearch] = useState("");
  const supervisorImport = useRef<string | null>(null);
  const { query: searchQuery, status: statusFilter, areaType: movementTypeFilter, plant: plantFilter, zone: zoneFilter } = supervisorFilters;
  const resetSupervisorFilters = useCallback(() => {
    setSupervisorFilters(EMPTY_SUPERVISOR_FILTERS);
    setPicklistSearch("");
    setDemandSearch("");
    setSelectedMovementKey(null);
    setSelectedPicklistKey(null);
  }, []);
  const updateSupervisorFilters = (update: Partial<SupervisorFilters>) => {
    setSupervisorFilters((current) => ({ ...current, ...update }));
    setSelectedMovementKey(null);
    setSelectedPicklistKey(null);
    setPicklistSearch("");
    setDemandSearch("");
  };
  const [resetSearch, setResetSearch] = useState("");
  const [picklistActionBusy, setPicklistActionBusy] = useState(false);
  const fulfillmentAttempt = useRef<FulfillmentAttempt | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => { preloadScanVoices(); }, []);

  useEffect(() => {
    const phoneViewport = window.matchMedia("(max-width: 760px)");
    const syncScannerMode = () => {
      setCompactScanner(phoneViewport.matches);
      // Adapt the layout without interrupting the active task on resize.
    };

    syncScannerMode();
    const initialView = window.setTimeout(() => { if (phoneViewport.matches && canOperate) setView("scan"); }, 0);
    if (typeof phoneViewport.addEventListener === "function") {
      phoneViewport.addEventListener("change", syncScannerMode);
      return () => { window.clearTimeout(initialView); phoneViewport.removeEventListener("change", syncScannerMode); };
    }
    phoneViewport.addListener(syncScannerMode);
    return () => { window.clearTimeout(initialView); phoneViewport.removeListener(syncScannerMode); };
  }, [canOperate]);

  // A scan that has just been confirmed passes force, so a poll that began before the commit
  // is superseded and discarded instead of overwriting the confirmed counts with older ones.
  const refreshState = useCallback(async (quiet = false, force = false) => {
    if (quiet && !force && stateFetchInFlight.current) return;
    stateFetchInFlight.current = true;
    const requestId = ++stateRequestId.current;
    if (!quiet) setLoading(true);
    try {
      const currentSession = clientSession.current;
      const response = await fetch("/api/state", {
        cache: "no-store",
        headers: { ...(currentSession ? { "x-cartflow-session": currentSession } : {}), ...(stateValidator.current ? { "If-None-Match": stateValidator.current } : {}) },
      });
      if (response.status === 304) {
        if (requestId === stateRequestId.current) { setLastSyncedAt(new Date().toISOString()); setSyncError(false); }
        return;
      }
      const payload = await response.json() as AppState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to load the work queue.");
      if (requestId !== stateRequestId.current) return;
      stateValidator.current = response.headers.get("etag") || "";
      const importKey = payload.lastImport ? `${payload.lastImport.importedAt}:${payload.lastImport.fileName}` : null;
      if (supervisorImport.current !== importKey) resetSupervisorFilters();
      supervisorImport.current = importKey;
      setState(payload);
      setLastSyncedAt(new Date().toISOString());
      setSyncError(false);
    } catch (error) {
      if (requestId !== stateRequestId.current) return;
      setSyncError(true);
      if (!quiet) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to load PPA." });
      }
    } finally {
      if (requestId === stateRequestId.current) { stateFetchInFlight.current = false; setLoading(false); }
    }
  }, [resetSupervisorFilters]);

  // Every failed scan is announced at once by a distinct tone and a short fixed phrase.
  // Detail stays on screen; nothing scanned is ever spoken.
  const signalScanFailure = useCallback((phrase: Parameters<typeof speakScanPrompt>[0] = "checkScreen") => {
    scanAudioContext.current = prepareScanAudio();
    playScanErrorTone(scanAudioContext.current);
    void speakScanPrompt(phrase);
  }, []);
  // A scan the screen cannot act on is refused loudly, never swallowed: the scanner has
  // already beeped a good read, so the operator must be told the app did not take it.
  const rejectScan = useCallback((text: string) => {
    signalScanFailure("scanNotProcessed");
    setNotice({ tone: "error", text });
  }, [signalScanFailure]);

  useEffect(() => {
    let nextSession = createClientSessionId();
    let savedName: string | null = null;
    try {
      nextSession = window.sessionStorage.getItem("cartflow-session") || nextSession;
      window.sessionStorage.setItem("cartflow-session", nextSession);
      savedName = localMode ? window.localStorage.getItem("cartflow-operator") : null;
    } catch {
      // Restricted browser storage must not prevent an operator from working.
    }
    clientSession.current = nextSession;
    const timer = window.setTimeout(() => {
      setSessionId(nextSession);
      if (savedName) setOperatorName(savedName);
      void refreshState();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshState, localMode]);

  useEffect(() => {
    if (notice && notice.tone !== "error") {
      const timeout = window.setTimeout(() => setNotice(null), 4200);
      return () => window.clearTimeout(timeout);
    }
  }, [notice]);

  useEffect(() => {
    const refreshSupervisor = () => {
      if (document.visibilityState === "visible") void refreshState(true);
    };
    const interval = window.setInterval(refreshSupervisor, 12_000);
    window.addEventListener("focus", refreshSupervisor);
    window.addEventListener("online", refreshSupervisor);
    const markOffline = () => setSyncError(true);
    window.addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", refreshSupervisor);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshSupervisor);
      window.removeEventListener("online", refreshSupervisor);
      window.removeEventListener("offline", markOffline);
      document.removeEventListener("visibilitychange", refreshSupervisor);
    };
  }, [refreshState, view]);

  useEffect(() => {
    if (!activeCartKey || !activePicklistKey || !sessionId || scanComplete) return;
    const renewLock = async () => {
      try {
        const response = await fetch("/api/locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "renew", cartKey: activeCartKey, picklistKey: activePicklistKey, sessionId, operatorName }),
        });
        const result = await response.json() as { locked?: boolean; lock?: AppState["locks"][number] };
        if (response.status === 409 || !result.locked) {
          setNotice({
            tone: "error",
            text: result.lock?.operatorName
              ? `This picklist is now being scanned by ${result.lock.operatorName}.`
              : "This picklist could not be reserved. Try the queue again.",
          });
        }
      } catch {
        // A brief local connection interruption is retried on the next heartbeat or scan.
      }
    };
    const handleResume = () => {
      if (document.visibilityState === "visible") void renewLock();
    };

    void renewLock();
    const renew = window.setInterval(() => void renewLock(), 60_000);
    window.addEventListener("focus", handleResume);
    document.addEventListener("visibilitychange", handleResume);
    return () => {
      window.clearInterval(renew);
      window.removeEventListener("focus", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [activeCartKey, activePicklistKey, operatorName, scanComplete, sessionId]);

  const carts = useMemo<CartGroup[]>(() => {
    const groups = new Map<string, CartLine[]>();
    const headers = new Map<string, Set<string>>();
    state.lines.forEach((line) => {
      const picklist = picklistIdentityKey(line);
      const identities = headers.get(picklist) || new Set<string>();
      identities.add(line.cartBarcode);
      headers.set(picklist, identities);
      const key = cartKey(line);
      groups.set(key, [...(groups.get(key) || []), line]);
    });
    return [...groups.entries()].map(([key, rows]) => {
      const lines = [...rows].sort(comparePackingLines);
      const first = lines[0];
      return {
        key,
        requiresReconciliation: (headers.get(picklistIdentityKey(first))?.size || 0) > 1,
        trainNumber: first.trainNumber,
        cartNumber: first.cartNumber,
        loadNumber: first.loadNumber,
        plant: first.plant,
        zone: first.zone,
        areaType: first.areaType,
        picklistNumber: first.picklistNumber,
        cartId: first.cartId,
        palletId: first.palletId,
        shipCategory: first.shipCategory,
        cartBarcode: first.cartBarcode,
        loadedAt: first.loadedAt,
        loadedBy: first.loadedBy,
        dispatchedAt: first.dispatchedAt || null,
        lines,
        verified: lines.filter((line) => line.status === "verified").length,
        total: lines.length,
        lock: state.locks.find((lock) =>
          lock.cartKey === key || lock.picklistKey === picklistKey(first)
        ) || null,
      };
    });
  }, [state.lines, state.locks]);

  const picklistNeedsReconciliation = (cart: CartGroup) => cart.requiresReconciliation;
  const activeCart = carts.find((cart) => cart.key === activeCartKey) || null;
  const activeTask = scanTasks[scanIndex] || null;
  const activeLine = activeTask ? state.lines.find((line) => line.id === activeTask.lineId) || activeCart?.lines.find((line) => line.id === activeTask.lineId) || null : null;
  const activeLineCaptured = Boolean(activeTask?.field === "aiagSerial" && activeLine &&
    (activeLine.status === "verified" || scanReceipts[`${activeLine.id}:aiagSerial`]?.complete));
  const settings = state.settings || DEFAULT_FULFILLMENT_SETTINGS;
  const partAttribute = partAttributeLabels(settings.partAttribute);
  const metrics = packingMetrics(state.lines);
  const totalLines = state.lines.length;
  const verifiedLines = state.lines.filter((line) => line.status === "verified").length;
  const progress = totalLines ? Math.round((verifiedLines / totalLines) * 100) : 0;
  const plants = useMemo(() => [...new Set(carts.map((cart) => cart.plant))].sort(), [carts]);
  const stationCarts = carts
    .filter((cart) =>
      cart.verified < cart.total &&
      !cart.lines.some((line) => line.status === "short") &&
      (!scanPlant || cart.plant === scanPlant) &&
      (!scanArea || cart.areaType === scanArea) &&
      (!packingMovementKey || [cart.plant, cart.areaType, cart.areaType === "onsite" ? cart.trainNumber : cart.loadNumber].join("::") === packingMovementKey)
    )
    .sort((left, right) => {
      const lockRank = (cart: CartGroup) => cart.lock?.isOwned ? 0 : cart.lock ? 2 : 1;
      return lockRank(left) - lockRank(right) || shippingPriority(left.lines[0]).localeCompare(shippingPriority(right.lines[0])) || left.cartNumber.localeCompare(right.cartNumber, undefined, { numeric: true });
    });

  const movements = useMemo<MovementGroup[]>(() => {
    const groups = new Map<string, CartGroup[]>();
    carts.forEach((cart) => {
      const number = cart.areaType === "onsite" ? cart.trainNumber : cart.loadNumber;
      const key = [cart.plant, cart.areaType, number].join("::");
      groups.set(key, [...(groups.get(key) || []), cart]);
    });

    return [...groups.entries()].map(([key, movementCarts]) => {
      const first = movementCarts[0];
      const lines = movementCarts.flatMap((cart) => cart.lines);
      const lineIds = new Set(lines.map((line) => line.id));
      const events = state.events.filter((event) => lineIds.has(event.lineId));
      const summary = summarizeStatus(lines, movementCarts, events);
      return {
        key,
        areaType: first.areaType,
        number: first.areaType === "onsite" ? first.trainNumber : first.loadNumber,
        plant: first.plant,
        zones: [...new Set(movementCarts.map((cart) => cart.zone))].sort(),
        carts: movementCarts,
        lines,
        verified: summary.verified,
        total: summary.total,
        picklistCount: new Set(movementCarts.map((cart) => cart.picklistNumber)).size,
        status: summary.status,
        mismatchCount: summary.mismatchCount,
        lastActivity: latestTimestamp([
          ...events.map((event) => event.createdAt),
          ...movementCarts.map((cart) => cart.lock?.acquiredAt),
          ...lines.map((line) => line.verifiedAt),
          ...movementCarts.map((cart) => cart.loadedAt),
          state.lastImport?.importedAt,
        ]),
      };
    }).sort((left, right) =>
      statusRank(left.status) - statusRank(right.status) ||
      Date.parse(right.lastActivity || "") - Date.parse(left.lastActivity || "") ||
      left.number.localeCompare(right.number, undefined, { numeric: true }),
    );
  }, [carts, state.events, state.lastImport]);

  const packingSetupReady = Boolean(scanPlant && scanArea);
  const packingSetupHelp = !scanPlant && !scanArea
    ? "Choose a plant and movement type to enable scanning."
    : !scanPlant ? "Choose a plant to enable scanning." : "Choose a movement type to enable scanning.";
  const packingMovement = packingSetupReady ? movements.find((movement) => movement.key === packingMovementKey && movement.plant === scanPlant && movement.areaType === scanArea) || null : null;
  const packingMovements = movements.filter((movement) => movement.carts.some((cart) => cart.verified < cart.total && !cart.lines.some((line) => line.status === "short")) && (!scanPlant || movement.plant === scanPlant) && (!scanArea || movement.areaType === scanArea))
    .sort((a, b) => a.lines.map(shippingPriority).sort()[0].localeCompare(b.lines.map(shippingPriority).sort()[0]));
  const packingConflicts = packingMovement ? conflictingPackingPicklists(carts, packingMovement) : [];
  const packingPicklists = [...new Set(stationCarts.map((cart) => cart.picklistNumber))].map((number) => ({ number, records: stationCarts.filter((cart) => cart.picklistNumber === number) }));

  const supervisorPlants = [...new Set(state.lines.map((line) => line.plant).filter(Boolean))].sort();
  const supervisorZones = [...new Set(state.lines.filter((line) => (!plantFilter || line.plant === plantFilter) && (movementTypeFilter === "all" || line.areaType === movementTypeFilter)).map((line) => line.zone).filter(Boolean))].sort();
  const supervisorFiltersActive = Boolean(searchQuery.trim() || statusFilter !== "all" || movementTypeFilter !== "all" || plantFilter || zoneFilter);
  const matchingMovements = useMemo(() => filterSupervisorMovements(movements, supervisorFilters), [movements, supervisorFilters]);
  const allLoads = movements.filter((movement) => movement.areaType === "offsite");
  const allTrains = movements.filter((movement) => movement.areaType === "onsite");
  const loads = matchingMovements.filter((movement) => movement.areaType === "offsite");
  const trains = matchingMovements.filter((movement) => movement.areaType === "onsite");
  const selectedMovement = visibleSupervisorSelection(matchingMovements, selectedMovementKey);

  const allPicklists = useMemo<PicklistGroup[]>(() => {
    if (!selectedMovement) return [];
    const groups = new Map<string, CartGroup[]>();
    selectedMovement.carts.forEach((cart) => {
      groups.set(cart.picklistNumber, [...(groups.get(cart.picklistNumber) || []), cart]);
    });

    return [...groups.entries()].map(([number, picklistCarts]) => {
      const lines = picklistCarts.flatMap((cart) => cart.lines);
      const lineIds = new Set(lines.map((line) => line.id));
      const events = state.events.filter((event) => lineIds.has(event.lineId));
      const summary = summarizeStatus(lines, picklistCarts, events);
      return {
        key: `${selectedMovement.key}::${number}`,
        number,
        carts: picklistCarts,
        lines,
        verified: summary.verified,
        total: summary.total,
        status: summary.status,
        mismatchCount: summary.mismatchCount,
        lastActivity: latestTimestamp([
          ...events.map((event) => event.createdAt),
          ...picklistCarts.map((cart) => cart.lock?.acquiredAt),
          ...lines.map((line) => line.verifiedAt),
          ...picklistCarts.map((cart) => cart.loadedAt),
          state.lastImport?.importedAt,
        ]),
      };
    }).sort((left, right) =>
      statusRank(left.status) - statusRank(right.status) ||
      Date.parse(right.lastActivity || "") - Date.parse(left.lastActivity || "") ||
      left.number.localeCompare(right.number, undefined, { numeric: true }),
    );
  }, [selectedMovement, state.events, state.lastImport]);

  const picklists = filterSupervisorPicklists(allPicklists, supervisorFilters, picklistSearch);
  const selectedPicklist = visibleSupervisorSelection(picklists, selectedPicklistKey);
  const visibleDemandLines = (selectedPicklist?.lines || []).filter((line) => supervisorLineMatches(line, supervisorFilters) && supervisorSearchMatches(line, picklistSearch) && supervisorSearchMatches(line, demandSearch)).sort(comparePackingLines);
  const pendingLineIds = new Set(state.lines.filter((line) => line.status !== "verified").map((line) => line.id));
  const openExceptionLineIds = new Set(state.events
    .filter((event) => !event.matched && pendingLineIds.has(event.lineId))
    .map((event) => event.lineId));
  for (const cart of carts.filter(picklistNeedsReconciliation)) {
    for (const line of cart.lines) openExceptionLineIds.add(line.id);
  }

  const focusQuickCartInput = useCallback((selectContents = false) => {
    const quickScanReady =
      view === "scan" &&
      packingSetupReady &&
      !activeCartKey &&
      !lockBusyKey;
    if (!quickScanReady) return;

    window.requestAnimationFrame(() => {
      const input = quickCartInput.current;
      if (!input || input.disabled) return;
      input.focus({ preventScroll: true });
      if (selectContents && input.value) input.select();
    });
  }, [activeCartKey, lockBusyKey, packingSetupReady, view]);

  useEffect(() => {
    const quickScanReady =
      view === "scan" &&
      packingSetupReady &&
      !activeCartKey &&
      !lockBusyKey;
    if (!quickScanReady) return;

    const focusInput = () => focusQuickCartInput(true);
    // Setup changes may leave this field focused while a scanner starts typing.
    // Restore focus without selecting and replacing the first scanned characters.
    const focusTimer = window.setTimeout(() => focusQuickCartInput(), 0);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") focusInput();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable], [role='dialog']")) return;
      focusInput();
    };

    window.addEventListener("focus", focusInput);
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("focus", focusInput);
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [activeCartKey, compactScanner, focusQuickCartInput, handheldMenuOpen, manualCartSelection, lockBusyKey, packingMovementKey, packingSetupReady, scanArea, scanPlant, view]);

  const focusScannerInput = useCallback((selectContents = false) => {
    if (view !== "scan" || !activeCartKey || activeLineCaptured || cameraOpen || missingInventory?.capturing || scanBusy || scanComplete) return;
    window.requestAnimationFrame(() => {
      const input = scanInput.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      if (selectContents && input.value) input.select();
    });
  }, [activeCartKey, activeLineCaptured, cameraOpen, missingInventory?.capturing, scanBusy, scanComplete, view]);

  useEffect(() => {
    if (view !== "scan" || !activeCartKey || activeLineCaptured || cameraOpen || missingInventory?.capturing || scanBusy || scanComplete) return;

    const focusInput = () => focusScannerInput(true);
    // A scanner can already be typing when this timer runs. Selecting that
    // partial barcode would replace its prefix with the remaining characters.
    const focusTimer = window.setTimeout(() => focusScannerInput(), 0);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") focusInput();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable], [role='dialog']")) return;
      focusInput();
    };

    // A dismissed toast or re-rendered control can leave nothing focused, and characters
    // typed by a scanner then go nowhere. Take focus back unless something else has it.
    const handleFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusScannerInput();
      }, 0);
    };

    window.addEventListener("focus", focusInput);
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("focus", focusInput);
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [activeCartKey, activeLineCaptured, cameraOpen, missingInventory?.capturing, focusScannerInput, handheldMenuOpen, scanBusy, scanComplete, scanIndex, view]);

  const saveOperatorName = (value: string) => {
    setOperatorName(value);
    try { window.localStorage.setItem("cartflow-operator", value); } catch { /* Optional preference. */ }
  };

  const buildTasks = (cart: CartGroup) => {
    const pending = cart.lines.filter((line) => line.status !== "verified" && line.status !== "short").sort(comparePackingLines);
    const lines = pending.length ? pending : cart.lines;
    const tasks: ScanTask[] = [];
    const setupLine = lines[0];
    if (setupLine) {
      tasks.push({
        lineId: setupLine.id,
        field: "cartBarcode",
        label: "Scan picklist barcode",
      });
    }
    lines.forEach((line) => {
      tasks.push(
        { lineId: line.id, field: "aiagSerial", label: "Scan Serial Number (1S)" },
      );
    });
    return tasks;
  };

  const handleStartCart = async (cart: CartGroup, scannedCartBarcode?: string) => {
    if (cart.lines.some((line) => line.status === "short")) {
      setNotice({ tone: "error", text: "This picklist was closed short. A supervisor can unpack/reset it before packing again." });
      return;
    }
    if (picklistNeedsReconciliation(cart)) {
      setNotice({ tone: "error", text: PICKLIST_RECONCILIATION_MESSAGE });
      return;
    }
    if (!operatorName.trim()) {
      setNotice({ tone: "error", text: "Enter an operator name before starting a picklist." });
      return;
    }
    if (!sessionId || lockBusyRef.current) return;
    lockBusyRef.current = true;
    setLockBusyKey(cart.key);
    let lockAcquired = false;
    try {
      const response = await fetch("/api/locks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "acquire",
          cartKey: cart.key,
          picklistKey: picklistKey(cart.lines[0]),
          sessionId,
          operatorName: operatorName.trim(),
        }),
      });
      lockAcquired = response.ok;
      const result = await response.json() as {
        error?: string;
        locked?: boolean;
        lock?: AppState["locks"][number];
      };
      if (response.status === 409 || (!response.ok && result.lock)) {
        setNotice({ tone: "error", text: `Picklist ${cart.picklistNumber} is being scanned by ${result.lock?.operatorName || "another operator"}.` });
        await refreshState(true);
        return;
      }
      if (!response.ok || !result.locked) {
        throw new Error(result.error || "The picklist reservation could not be started.");
      }
      const tasks = buildTasks(cart);
      const receipts: Record<string, ScanReceipt> = {};
      let firstTaskIndex = 0;
      if (scannedCartBarcode && tasks[0]) {
        const cartScanResponse = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lineId: tasks[0].lineId,
            cartKey: cart.key,
            field: "cartBarcode",
            value: scannedCartBarcode,
            rawValue: scannedCartBarcode,
            sessionId,
            operatorName: operatorName.trim(),
          }),
        });
        const cartScan = await cartScanResponse.json() as { ok?: boolean; matched?: boolean; error?: string };
        if (!cartScanResponse.ok || !cartScan.ok || !cartScan.matched) {
          throw new Error(cartScan.error || "This checksheet barcode does not match the selected outbound card.");
        }
        receipts[`${tasks[0].lineId}:cartBarcode`] = { rawValue: scannedCartBarcode, value: cart.cartBarcode };
        firstTaskIndex = Math.min(1, tasks.length - 1);
      }
      setActiveCartKey(cart.key);
      setActivePicklistKey(picklistKey(cart.lines[0]));
      setScanTasks(tasks);
      setScanIndex(firstTaskIndex);
      setScanValue("");
      setMissingInventory(null);
      setSerialSuppliers(null);
      setSelectedSupplier("");
      setScanReceipts(receipts);
      setScanFeedback(null);
      setLastPacked(null);
      setScanComplete(false);
      setView("scan");
      setQuickCartValue("");
      setNotice({
        tone: "success",
        text: scannedCartBarcode
          ? `Picklist ${cart.picklistNumber} identified and locked to you.`
          : `Picklist ${cart.picklistNumber} is locked to you. Scan its checksheet or master barcode.`,
      });
      await refreshState(true);
    } catch (error) {
      if (lockAcquired) {
        await fetch("/api/locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "release", cartKey: cart.key, picklistKey: picklistKey(cart.lines[0]), sessionId, operatorName }),
          keepalive: true,
        }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : "";
      const connectionInterrupted = /before connect|failed to fetch|load failed|network error/i.test(message);
      setNotice({
        tone: "error",
        text: connectionInterrupted
          ? "The preview connection was interrupted. Reload this page, then start verification again."
          : message || "Unable to start verification. Try again.",
      });
    } finally {
      lockBusyRef.current = false;
      setLockBusyKey(null);
    }
  };

  const handleStartCartClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const key = event.currentTarget.dataset.cartKey;
    const cart = carts.find((candidate) => candidate.key === key);
    if (cart) void handleStartCart(cart);
  };

  const releaseOwnReservation = async (cart: CartGroup) => {
    const name = operatorName.trim();
    if (!name) {
      setNotice({ tone: "error", text: "Enter an operator name before releasing a reservation." });
      return false;
    }
    setLockBusyKey(cart.key);
    try {
      const response = await fetch("/api/locks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "release_own",
          cartKey: cart.key,
          picklistKey: picklistKey(cart.lines[0]),
          sessionId,
          operatorName: name,
        }),
      });
      const result = await response.json().catch(() => null) as { released?: boolean; error?: string } | null;
      if (!response.ok || !result?.released) {
        setNotice({ tone: "error", text: result?.error || "The reservation could not be released. It will expire automatically." });
        return false;
      }
      setNotice({ tone: "success", text: `Reservation on picklist ${cart.picklistNumber} released.` });
      await refreshState(true);
      return true;
    } catch {
      setNotice({ tone: "error", text: "The reservation could not be released. Try again." });
      return false;
    } finally {
      setLockBusyKey(null);
    }
  };

  const handleReleaseReservationClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const key = event.currentTarget.dataset.cartKey;
    const cart = carts.find((candidate) => candidate.key === key);
    if (cart && await confirmChange(`Picklist ${cart.picklistNumber} is reserved under "${operatorName.trim()}" in another tab or session. Release that reservation so you can open it here?`, undefined, { title: "Release my reservation?", confirmLabel: "Release reservation" })) {
      await releaseOwnReservation(cart);
    }
  };

  const openScanSetup = (cart?: CartGroup) => {
    setManualCartSelection(false);
    if (cart) {
      setScanPlant(cart.plant);
      setScanArea(cart.areaType);
      setPackingMovementKey([cart.plant, cart.areaType, cart.areaType === "onsite" ? cart.trainNumber : cart.loadNumber].join("::"));
    }
    setQuickCartValue("");
    setView("scan");
  };

  const choosePackingMovement = (movement: MovementGroup) => {
    setScanPlant(movement.plant);
    setScanArea(movement.areaType);
    setPackingMovementKey(movement.key);
    setPackingMovementValue("");
    setQuickCartValue("");
    setManualCartSelection(false);
    setNotice(null);
    window.setTimeout(() => focusQuickCartInput(), 50);
  };

  const handleChoosePackingMovement = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!packingSetupReady) return;
    const movement = packingMovements.find((candidate) => candidate.key === event.currentTarget.dataset.movementKey);
    if (movement) choosePackingMovement(movement);
  };

  const submitPackingMovement = () => {
    if (!packingSetupReady) {
      setNotice({ tone: "info", text: packingSetupHelp });
      return;
    }
    const value = cleanScannerPayload(packingMovementValue);
    if (!value) return;
    const matches = packingMovements.filter((movement) => movement.lines.some((line) => movementBarcodeMatches(line, value)));
    if (matches.length !== 1) {
      setNotice({ tone: "error", text: matches.length ? "This barcode matches more than one movement. Choose the correct load or train below." : `No unfinished ${scanArea === "onsite" ? "train" : "load"} matches this barcode in Plant ${scanPlant}. Check the barcode or change your selection.` });
      setManualCartSelection(true);
      focusQuickCartInput(true);
      return;
    }
    choosePackingMovement(matches[0]);
  };

  const changePackingSetup = (plant: typeof scanPlant, area: typeof scanArea) => {
    setScanPlant(plant);
    setScanArea(area);
    setPackingMovementKey(null);
    setPackingMovementValue("");
    setQuickCartValue("");
    setManualCartSelection(false);
    setNotice(null);
  };

  const submitQuickCart = async () => {
    if (!quickCartValue.trim() || !packingMovement) return;
    if (lockBusyKey) {
      // Left in the box, this text would be glued onto the next scan.
      setQuickCartValue("");
      rejectScan("A picklist is still being reserved. This scan was not processed; scan it again in a moment.");
      return;
    }
    const normalized = cleanScannerPayload(quickCartValue);
    const blockedLabel = packingMovement.carts.some((cart) => packingConflicts.includes(normalizeIdentityBarcode(cart.picklistNumber))
      && cart.lines.some((line) => picklistBarcodeMatches(line, normalized)));
    if (blockedLabel) {
      setNotice({ tone: "error", text: PICKLIST_RECONCILIATION_MESSAGE });
      setManualCartSelection(true);
      return;
    }
    const matches = matchingPackingReferences(carts, packingMovement, normalized);
    if (matches.length !== 1) {
      setNotice({ tone: "error", text: matches.length
        ? "This checksheet barcode identifies more than one picklist. Ask a supervisor to correct the barcode assignment before packing."
        : "That picklist barcode is not unfinished work in the selected load or train." });
      if (matches.length) setManualCartSelection(true);
      window.setTimeout(() => focusQuickCartInput(), 50);
      return;
    }
    const cart = matches[0];
    if (cart.lock && !cart.lock.isOwned) {
      setQuickCartValue("");
      if (cart.lock.isOwnedByOperator) {
        if (await confirmChange(`Picklist ${cart.picklistNumber} is reserved under "${operatorName.trim()}" in another tab or session. Release that reservation so you can open it here?`, undefined, { title: "Release my reservation?", confirmLabel: "Release reservation" })) {
          const released = await releaseOwnReservation(cart);
          if (released) {
            setScanPlant(cart.plant);
            setScanArea(cart.areaType);
            await handleStartCart(cart, normalized);
            return;
          }
        }
        window.setTimeout(() => focusQuickCartInput(), 50);
        return;
      }
      setNotice({ tone: "error", text: `Picklist ${cart.picklistNumber} is being scanned by ${cart.lock.operatorName}.` });
      window.setTimeout(() => focusQuickCartInput(), 50);
      return;
    }
    setScanPlant(cart.plant);
    setScanArea(cart.areaType);
    await handleStartCart(cart, normalized);
  };

  const releaseCart = useCallback(async () => {
    if (!activeCartKey || !activePicklistKey || !sessionId) return true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LOCK_RELEASE_TIMEOUT_MS);
    try {
      const response = await fetch("/api/locks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "release",
          cartKey: activeCartKey,
          picklistKey: activePicklistKey,
          sessionId,
          operatorName: operatorName.trim() || "PPA operator",
        }),
        keepalive: true,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as { released?: boolean } | null;
      return response.ok && result?.released === true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }, [activeCartKey, activePicklistKey, operatorName, sessionId]);

  useEffect(() => {
    if (!activeCartKey || !activePicklistKey || !sessionId) return;
    const body = JSON.stringify({
      action: "release",
      cartKey: activeCartKey,
      picklistKey: activePicklistKey,
      sessionId,
      operatorName: operatorName.trim() || "PPA operator",
    });
    const releaseOnPageHide = () => {
      let queued = false;
      try {
        if (typeof navigator.sendBeacon === "function") {
          queued = navigator.sendBeacon("/api/locks", new Blob([body], { type: "application/json" }));
        }
      } catch {
        // Fall through to a keepalive request when Beacon is unavailable or rejects the payload.
      }
      if (!queued) {
        void fetch("/api/locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => window.removeEventListener("pagehide", releaseOnPageHide);
  }, [activeCartKey, activePicklistKey, operatorName, sessionId]);

  const leaveScan = async (destination: View = "overview") => {
    if (scanBusyRef.current || lockBusyRef.current || receivingBusyRef.current) return;
    setNotice(null);
    setManualCartSelection(false);
    const releasePromise = releaseCart();
    setCameraOpen(false);
    setMissingInventory(null);
    setActiveCartKey(null);
    setActivePicklistKey(null);
    setScanTasks([]);
    setScanIndex(0);
    setScanValue("");
    setScanComplete(false);
    setScanReceipts({});
    setScanFeedback(null);
    setLastPacked(null);
    // Arriving at load confirmation from packing must not show a stale banner as if it were live.
    if (destination === "load") {
      setLoadStep("movement");
      setLoadMovementValue("");
      setLoadCartValue("");
      setLoadConfirmation(null);
    }
    setView(destination);
    const released = await releasePromise;
    await refreshState(true, true);
    if (!released) setNotice({ tone: "info", text: LOCK_RELEASE_WARNING });
  };

  const navigateTo = async (nextView: View) => {
    if (picklistActionBusy) return;
    if (receivingBusyRef.current) {
      setNotice({ tone: "info", text: "Wait for the inventory receipt to finish saving." });
      return;
    }
    if (loadBusy) {
      setNotice({ tone: "info", text: "Wait for the loading confirmation to finish before leaving this station." });
      return;
    }
    if (scanBusyRef.current || lockBusyRef.current) {
      setNotice({ tone: "info", text: "Wait for the current scan to finish before leaving this station." });
      return;
    }
    if ((nextView === "receive" || nextView === "scan" || nextView === "load") && !canOperate) return;
    if ((nextView === "import" || nextView === "manage") && !canManage) return;
    setNotice(null);
    setHandheldMenuOpen(false);
    if (nextView === "scan") {
      if (!activeCartKey) openScanSetup();
      else setView("scan");
      return;
    }
    if (activeCartKey) {
      const releasePromise = releaseCart();
      setCameraOpen(false);
      setMissingInventory(null);
      setActiveCartKey(null);
      setActivePicklistKey(null);
      setScanTasks([]);
      setScanIndex(0);
      setScanValue("");
      setScanComplete(false);
      setScanReceipts({});
      setScanFeedback(null);
      if (nextView === "load") {
        setLoadStep("movement");
        setLoadMovementValue("");
        setLoadCartValue("");
        setLoadConfirmation(null);
      }
      setView(nextView);
      const released = await releasePromise;
      await refreshState(true, true);
      if (!released) setNotice({ tone: "info", text: LOCK_RELEASE_WARNING });
      return;
    }
    if (nextView === "load") {
      setLoadStep("movement");
      setLoadMovementValue("");
      setLoadCartValue("");
      setLoadConfirmation(null);
    }
    setView(nextView);
    await refreshState(true);
  };

  // Finish any in-flight stock transaction before releasing its picklist.
  // Cancel remains available while saving, without creating an uncertain receipt.
  const finishCancel = useEffectEvent(() => {
    setCancelRequested(false);
    setHandheldMenuOpen(false);
    setPackingMovementKey(null);
    setPackingMovementValue("");
    setQuickCartValue("");
    setSerialSuppliers(null);
    setSelectedSupplier("");
    setLoadStep("movement");
    setLoadMovementValue("");
    setLoadCartValue("");
    setLoadConfirmation(null);
    void leaveScan("overview");
  });
  useEffect(() => {
    if (!cancelRequested || scanBusy || lockBusyKey || loadBusy || receivingBusy) return;
    const timer = window.setTimeout(() => finishCancel(), 0);
    return () => window.clearTimeout(timer);
  }, [cancelRequested, scanBusy, lockBusyKey, loadBusy, receivingBusy]);

  const resetLoadConfirmation = useCallback((keepMovement = false) => {
    loadScanQueue.current.flush();
    setQueuedLoadScans(0);
    setLoadStep(keepMovement && loadMovementValue ? "cart" : "movement");
    if (!keepMovement) setLoadMovementValue("");
    setLoadCartValue("");
    setLoadConfirmation(null);
    window.setTimeout(() => loadInput.current?.focus(), 50);
  }, [loadMovementValue]);

  useEffect(() => {
    // The input stays live after a success so the next outbound card can be scanned at once.
    // A blocked result hides it until acknowledged.
    if (view !== "load" || loadConfirmation?.tone === "error") return;
    const focusInput = () => loadInput.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(focusInput, 0);
    const handleFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) focusInput();
      }, 0);
    };
    window.addEventListener("focus", focusInput);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", focusInput);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [handheldMenuOpen, loadConfirmation, loadStep, view]);

  useEffect(() => {
    if (!simpleHandheld) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => window.cancelAnimationFrame(frame);
  }, [simpleHandheld, view, handheldMenuOpen, manualCartSelection, scanPlant, scanArea, activeCartKey, scanIndex, activeLineCaptured, loadStep, loadConfirmation]);

  // As with the packing input: clear only if it still holds the scan that was just taken, so
  // the next scan's characters are neither wiped nor appended to.
  const settleLoadInput = (accepted: string) => {
    setLoadCartValue((current) => settleScanInput(current, accepted));
    const input = loadInput.current;
    if (input && input.value === accepted) input.value = "";
  };

  const queueLoadScan = (value: string) => {
    if (loadScanQueue.current.enqueue(value)) setQueuedLoadScans(loadScanQueue.current.size);
    else rejectScan("Too many scans are waiting while the last one is checked. This scan was not processed; wait for the check to finish, then rescan it.");
    settleLoadInput(value);
  };

  const submitLoadScan = async (scanned?: string) => {
    const raw = scanned ?? (loadStep === "movement" ? loadMovementValue : loadCartValue);
    if (!raw.trim()) return;
    if (loadConfirmation?.tone === "error") {
      // A blocked result stays on screen until it is acknowledged, so a following scan can
      // never replace it unseen and leave a wrong outbound card loaded.
      settleLoadInput(raw);
      rejectScan("The last outbound card was blocked. Tap OK to acknowledge it, then scan again. This scan was not processed.");
      return;
    }
    if (loadBusyRef.current) {
      // The scanner has already beeped a good read, so wait for the current check.
      queueLoadScan(raw);
      return;
    }
    scanAudioContext.current = prepareScanAudio();
    if (loadStep === "movement") {
      const value = cleanScannerPayload(raw);
      if (!value) return;
      setLoadMovementValue(value);
      setLoadStep("cart");
      setNotice({ tone: "info", text: "Destination captured. Now scan the picklist or master barcode." });
      window.setTimeout(() => loadInput.current?.focus(), 50);
      return;
    }

    const cartBarcode = cleanScannerPayload(raw);
    if (!cartBarcode) {
      settleLoadInput(raw);
      rejectScan("That scan held no readable barcode, so it was not processed. Scan the outbound card again.");
      return;
    }
    if (!loadMovementValue.trim()) return;
    if (!operatorName.trim()) {
      setNotice({ tone: "error", text: "Enter an operator name before confirming a load." });
      signalScanFailure("checkScreen");
      return;
    }
    loadBusyRef.current = true;
    setLoadBusy(true);
    settleLoadInput(raw);
    try {
      const response = await fetch("/api/loading/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movementValue: loadMovementValue,
          cartBarcode,
          operatorName: operatorName.trim(),
        }),
      });
      const result = await response.json() as {
        ok?: boolean;
        alreadyLoaded?: boolean;
        error?: string;
        reason?: string;
        cart?: {
          cartNumber?: string;
          picklistNumber?: string;
          movementNumber?: string;
          testMode?: boolean;
          dispatchedAt?: string | null;
        };
      };
      if (!response.ok || !result.ok) {
        const message = result.error || (result.reason === "not_packed"
          ? "This outbound card is not fully packed. Finish every demand line before loading it."
          : result.reason === "wrong_movement"
            ? "Blocked: this outbound card is assigned to a different load or train."
            : "The load confirmation was blocked.");
        setLoadConfirmation({ tone: "error", title: "Do not load this outbound card", message, cartBarcode });
        setNotice({ tone: "error", text: message });
        signalScanFailure("doNotLoad");
        return;
      }
      setNotice(null);
      const loadingIsTest = Boolean(result.cart?.testMode);
      setLoadConfirmation({
        tone: "success",
        title: result.alreadyLoaded
          ? loadingIsTest ? "TEST picklist already loaded" : "Picklist already loaded"
          : loadingIsTest ? "TEST picklist loaded" : "Picklist loaded",
        message: result.alreadyLoaded
          ? "The earlier loading confirmation is still valid. No duplicate audit record was created."
          : loadingIsTest
            ? "This test picklist is assigned correctly. Loading was recorded in the test workflow."
            : "The picklist is fully packed and assigned to this destination. Loading was recorded.",
        cartBarcode,
        cartNumber: result.cart?.cartNumber,
        picklistNumber: result.cart?.picklistNumber,
        movementNumber: result.cart?.movementNumber,
        alreadyLoaded: result.alreadyLoaded,
        dispatchedAt: result.cart?.dispatchedAt,
        testMode: loadingIsTest,
      });
      // Confirm to the operator at once; the queue reconciles in the background.
      playLabelCompleteBeep(scanAudioContext.current);
      void refreshState(true, true);
    } catch (error) {
      const network = isNetworkFailure(error);
      const message = network
        ? "The server did not answer, so loading may or may not have been recorded. Scan the outbound card again to check."
        : error instanceof Error ? error.message : "Load confirmation failed.";
      setLoadConfirmation({ tone: "error", title: "Unable to confirm loading", message, cartBarcode });
      setNotice({ tone: "error", text: message });
      signalScanFailure(network ? "networkProblem" : "checkScreen");
    } finally {
      loadBusyRef.current = false;
      setLoadBusy(false);
    }
  };

  const confirmDispatch = async () => {
    if (loadBusyRef.current || loadConfirmation?.tone !== "success" || loadConfirmation.dispatchedAt) return;
    if (!await confirmChange("Confirm that this loaded picklist has physically departed on the selected load or train?")) return;
    loadBusyRef.current = true;
    setLoadBusy(true);
    try {
      const response = await fetch("/api/loading/dispatch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movementValue: loadMovementValue, cartBarcode: loadConfirmation.cartBarcode || cleanScannerPayload(loadCartValue), operatorName }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Dispatch could not be confirmed.");
      const dispatchedAt = result.cart?.dispatchedAt || result.dispatchedAt;
      if (!dispatchedAt) throw new Error("Refresh the queue to check dispatch status before trying again.");
      setNotice(null);
      setLoadConfirmation((current) => current ? { ...current, dispatchedAt, title: "Picklist dispatched", message: "Physical departure was recorded for this picklist." } : current);
      playLabelCompleteBeep(prepareScanAudio());
      void refreshState(true, true);
      handleInventoryReceived();
    } catch (error) {
      const network = isNetworkFailure(error);
      const message = network
        ? "The server did not answer, so departure may or may not have been recorded. Scan the outbound card again to check."
        : error instanceof Error ? error.message : "Dispatch could not be confirmed.";
      // A blocking result: a scan waiting behind this request must not replace it unseen.
      setLoadConfirmation({ tone: "error", title: "Departure not confirmed", message, cartBarcode: loadConfirmation.cartBarcode, picklistNumber: loadConfirmation.picklistNumber });
      setNotice({ tone: "error", text: message });
      signalScanFailure(network ? "networkProblem" : "checkScreen");
    } finally { loadBusyRef.current = false; setLoadBusy(false); }
  };

  // Clear the input once its scan has been accepted, but only if it still holds that scan.
  // The next scan's characters may already be arriving, and wiping or appending to them
  // would corrupt a scan instead of merely delaying it. The DOM value is cleared at once
  // because React only re-renders it a frame later.
  const settleInput = (accepted: string) => {
    setScanValue((current) => settleScanInput(current, accepted));
    const input = scanInput.current;
    if (input && input.value === accepted) input.value = "";
  };

  const queueScan = (value: string) => {
    if (scanQueue.current.enqueue(value)) setQueuedScans(scanQueue.current.size);
    else rejectScan("Too many scans are waiting while the last one is checked. This scan was not processed; wait for the check to finish, then rescan it.");
    settleInput(value);
  };

  const submitScan = async (cameraValue?: string, supplierId: string | undefined = selectedSupplier === "__legacy__" ? "" : selectedSupplier || undefined, source: "scanner" | "received" = "scanner") => {
    const rawValue = cameraValue ?? scanInput.current?.value ?? scanValue;
    if (!rawValue.trim()) return;
    if (scanBusyRef.current) {
      // The scanner has already beeped a good read, so a scan that arrives while the previous
      // one is being checked waits its turn instead of being dropped.
      if (source === "scanner") queueScan(rawValue);
      return;
    }
    if (!activeTask || !activeCart || !activeLine) return;
    if (picklistNeedsReconciliation(activeCart)) {
      setNotice({ tone: "error", text: PICKLIST_RECONCILIATION_MESSAGE });
      signalScanFailure("checkScreen");
      return;
    }
    const isCartScan = activeTask.field === "cartBarcode";
    // Receipt callbacks contain canonical serials; only scanner input includes a
    // barcode identifier. A real serial may itself begin with P, Q, C, or 1S.
    const serialRead = isCartScan ? null : source === "received"
      ? { ok: true as const, serial: rawValue, rawValue: `1S${rawValue}` }
      : scanSerialBarcode(rawValue);
    if (serialRead && !serialRead.ok) {
      settleInput(rawValue);
      setScanFeedback({ tone: "error", title: "Scan the container serial", message: serialRead.message, lineId: activeLine.id, rawValue });
      setNotice({ tone: "error", text: serialRead.message });
      signalScanFailure("scanSerial");
      return;
    }
    const serial = serialRead?.ok ? serialRead.serial : "";
    const serialBarcode = `1S${serial}`;
    scanAudioContext.current = prepareScanAudio();
    scanBusyRef.current = true;
    setScanBusy(true);
    // Accepted: free the input at once so the next scan starts clean while this one is checked.
    settleInput(rawValue);
    setMissingInventory(null);
    try {
      if (!isCartScan) {
        if (!fulfillmentAttempt.current) {
          const stored = window.sessionStorage.getItem("ppa.fulfillment-attempt");
          if (stored) {
            fulfillmentAttempt.current = restoreFulfillmentAttempt(JSON.parse(stored));
            if (!fulfillmentAttempt.current) throw new Error("The saved packing request could not be opened. Ask a supervisor to check its receipt before scanning again.");
          }
        }
        const nextRequest = {
          cartKey: activeCart.key, serial: source === "received" ? serial : serialBarcode,
          serialFormat: source === "received" ? "canonical" as const : "barcode" as const, ...(supplierId !== undefined ? { supplierId } : {}),
        };
        try {
          fulfillmentAttempt.current = prepareFulfillmentAttempt(fulfillmentAttempt.current, nextRequest, createClientSessionId(), source === "received");
        } catch (pendingError) {
          const previous = fulfillmentAttempt.current;
          if (!previous) throw pendingError;
          const query = new URLSearchParams({ ...previous.request, requestId: previous.requestId });
          const receiptResponse = await fetch(`/api/fulfill?${query}`);
          const savedReceipt = await receiptResponse.json() as { ok?: boolean; recorded?: boolean; reason?: string; error?: string };
          if (savedReceipt.reason === "allocation_reversed") {
            if (!await confirmChange("The previous packing contribution was unpacked by a supervisor. Clear this saved attempt and start a new scan?", undefined, { title: "Previous packing was reset", confirmLabel: "Start new scan" })) throw pendingError;
          } else if (!receiptResponse.ok || !savedReceipt.ok || !savedReceipt.recorded) {
            throw new Error(savedReceipt.error || (pendingError instanceof Error ? pendingError.message : "The previous scan is not confirmed."));
          }
          fulfillmentAttempt.current = prepareFulfillmentAttempt(null, nextRequest, createClientSessionId(), source === "received");
        }
        try { window.sessionStorage.setItem("ppa.fulfillment-attempt", JSON.stringify(fulfillmentAttempt.current)); }
        catch { throw new Error("Enable site storage before packing so an interrupted scan can be retried safely."); }
      }
      const response = await fetch(isCartScan ? "/api/scan" : "/api/fulfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isCartScan ? { lineId: activeLine.id } : {}),
          cartKey: activeCart.key, sessionId, operatorName,
          ...(isCartScan ? { field: "cartBarcode", value: cleanScannerPayload(rawValue), rawValue } : { ...fulfillmentAttempt.current!.request, requestId: fulfillmentAttempt.current!.requestId }),
        }),
      });
      const result = await response.json() as {
        ok?: boolean; matched?: boolean; verified?: boolean; alreadyFulfilled?: boolean; reason?: string; error?: string; lineId?: string;
        fulfilledQuantity?: number; remainingQuantity?: number; allocatedQuantity?: number;
        suppliers?: string[]; inventory?: InventoryItem; serial?: string; retryDisposition?: string;
      };
      if (!isCartScan && result.reason === "allocation_reversed" && await confirmChange("The previous packing contribution was unpacked by a supervisor. Clear this saved attempt so you can scan again?", undefined, { title: "Previous packing was reset", confirmLabel: "Clear saved attempt" })) {
        window.sessionStorage.removeItem("ppa.fulfillment-attempt");
        fulfillmentAttempt.current = null;
        setScanFeedback(null);
        setNotice({ tone: "info", text: "The reset is acknowledged. Scan the container again to start a new packing contribution." });
        return;
      }
      if (!isCartScan && !result.ok && fulfillmentAttempt.current && result.retryDisposition === "not_allocated") {
        fulfillmentAttempt.current = recordFulfillmentResponse(fulfillmentAttempt.current, result);
        window.sessionStorage.setItem("ppa.fulfillment-attempt", JSON.stringify(fulfillmentAttempt.current));
      }
      const receipt = !isCartScan && packingReceiptForResult(result, serialBarcode);
      if (receipt) {
        setMissingInventory(receipt);
        setSerialSuppliers(null);
        setScanFeedback(null);
        setNotice(null);
        return;
      }
      if (!response.ok || !result.ok || (isCartScan && !result.matched)) {
        if (result.reason === "ambiguous_serial") {
          setSerialSuppliers({ serial: serialBarcode, suppliers: result.suppliers || [] });
          setSelectedSupplier("");
        }
        if (["no_matching_demand", "demand_fulfilled", "inventory_consumed", "content_mismatch", "inventory_mismatch"].includes(result.reason || "")) {
          const message = result.error || "This container is not part of this picklist's demand.";
          const alreadyRecorded = result.reason === "demand_fulfilled" || result.reason === "inventory_consumed";
          setScanFeedback({ tone: "error", title: alreadyRecorded ? "Container already recorded" : "Container not required", requiresContinue: alreadyRecorded, message, lineId: activeLine.id, rawValue });
          setNotice({ tone: "error", text: message });
          signalScanFailure(packingScanFeedback(result.reason));
          return;
        }
        throw new Error(result.error || (isCartScan
          ? "This checksheet barcode does not match the selected outbound card."
          : "Fulfillment was not confirmed. Scan the same serial again to check its status."));
      }
      setSerialSuppliers(null);
      setNotice(null);
      const value = isCartScan ? activeCart.cartBarcode : serial;
      if (isCartScan) {
        setScanReceipts((current) => ({ ...current, [`${activeLine.id}:cartBarcode`]: { rawValue, value } }));
        playScanBeep(scanAudioContext.current);
        setScanIndex((index) => Math.min(index + 1, scanTasks.length - 1));
        setScanFeedback(null);
        setNotice({ tone: "success", text: "Picklist confirmed. Scan any container serial." });
      } else {
        const fulfilledLineId = result.lineId || activeLine.id;
        const fulfilledLine = activeCart.lines.find((line) => line.id === fulfilledLineId) || activeLine;
        setScanReceipts((current) => ({ ...current, [`${fulfilledLineId}:aiagSerial`]: { rawValue, value, complete: result.verified === true } }));
        if (typeof result.fulfilledQuantity === "number") setState((current) => ({ ...current, lines: current.lines.map((line) => line.id === fulfilledLineId ? { ...line, fulfilledQuantity: result.fulfilledQuantity!, remainingQuantity: result.remainingQuantity, status: result.verified ? "verified" : "active" } : line) }));
        fulfillmentAttempt.current = null;
        try { window.sessionStorage.removeItem("ppa.fulfillment-attempt"); } catch { /* The confirmed response is already reflected in the queue. */ }
        if (result.alreadyFulfilled) {
          const message = `Container ${value} is already recorded for line ${fulfilledLine.packSequence || fulfilledLine.sequence}. No quantity was packed again. Scan another container.`;
          setScanFeedback({ tone: "success", title: "Already fulfilled", requiresContinue: true, message, lineId: activeLine.id, rawValue });
          setNotice({ tone: "info", text: message });
          signalScanFailure("alreadyScanned");
          void refreshState(true, true);
          return;
        }
        playLabelCompleteBeep(scanAudioContext.current);
        setLastPacked({ serial: value, sequence: fulfilledLine.sequence });
        handleInventoryReceived();
        if (result.verified) await advanceAfterReview();
        else {
          setScanFeedback(null);
          setMissingInventory(null);
          setNotice({ tone: "success", text: `${result.fulfilledQuantity ?? 0} of ${fulfilledLine.quantity} ${fulfilledLine.unitOfMeasure || "EA"} packed on line ${fulfilledLine.packSequence || fulfilledLine.sequence}. Scan another container.` });
        }
        // The confirmed response has already updated the counts. Reconcile in the background so
        // the next scan is not held behind a full download of the work queue.
        void refreshState(true, true);
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "The scan could not be checked.";
      setScanFeedback({ tone: "error", title: isCartScan ? "Picklist not confirmed" : "Fulfillment not confirmed", message,
        lineId: activeLine.id, rawValue });
      setNotice({ tone: "error", text: message });
      signalScanFailure(isNetworkFailure(failure) ? "networkProblem" : "checkScreen");
    } finally {
      scanBusyRef.current = false;
      setScanBusy(false);
    }
  };

  const advanceAfterReview = async () => {
    if (!activeCart || !activeLine) return;
    const lineDone = (lineId: string) => {
      const line = state.lines.find((candidate) => candidate.id === lineId)
        || activeCart.lines.find((candidate) => candidate.id === lineId);
      return Boolean(line && (line.status === "verified" || line.loadedAt || scanReceiptsRef.current[`${lineId}:aiagSerial`]?.complete));
    };
    setMissingInventory(null);
    setSerialSuppliers(null);
    setSelectedSupplier("");
    setScanFeedback(null);

    const anyUndone = scanTasks.some((task) => task.field === "aiagSerial" && !lineDone(task.lineId));
    if (!anyUndone) {
      setScanComplete(true);
      setNotice({ tone: "success", text: `Demand fulfilled for picklist ${activeCart.picklistNumber}.` });
      const released = await releaseCart();
      await refreshState(true);
      if (!released) setNotice({ tone: "info", text: `Demand fulfillment is complete. ${LOCK_RELEASE_WARNING}` });
      return;
    }

    const nextIndex = scanTasks.findIndex((task, index) => index > scanIndex && task.field === "aiagSerial" && !lineDone(task.lineId));
    const targetIndex = nextIndex >= 0
      ? nextIndex
      : scanTasks.findIndex((task) => task.field === "aiagSerial" && !lineDone(task.lineId));
    setScanIndex(targetIndex);
    setNotice(null);
    window.setTimeout(() => scanInput.current?.focus(), 50);
  };

  const continuePacking = async () => {
    setMissingInventory(null);
    setSerialSuppliers(null);
    setSelectedSupplier("");
    setScanValue("");
    setScanFeedback(null);
    setNotice(null);
    if (activeLineCaptured) await advanceAfterReview();
    else window.setTimeout(() => scanInput.current?.focus(), 50);
  };

  // Scans that waited behind a request run in order once it finishes, but only while the
  // screen can still act on them. If the previous scan failed or opened another step they are
  // refused loudly: they were made before the operator saw that result.
  const packingScanReady = Boolean(activeTask && activeCart && activeLine) && !scanComplete
    && !scanFeedback && !missingInventory && !serialSuppliers && notice?.tone !== "error";
  const drainScanQueue = useEffectEvent(() => {
    const decision = decideDrain({ busy: scanBusy, waiting: queuedScans, onScreen: view === "scan" && Boolean(activeCartKey), cancelling: cancelRequested, ready: packingScanReady });
    if (decision === "idle") return;
    if (decision === "process") {
      const next = scanQueue.current.take();
      setQueuedScans(scanQueue.current.size);
      if (next !== undefined) void submitScan(next);
      return;
    }
    const dropped = scanQueue.current.flush();
    setQueuedScans(0);
    if (decision === "discard" && dropped.length) {
      signalScanFailure("scanNotProcessed");
      const count = `${dropped.length} queued scan${dropped.length === 1 ? " was" : "s were"} not processed because the previous scan needs attention. Fix that, then rescan.`;
      setNotice((current) => ({ tone: "error", text: current?.tone === "error" ? `${current.text} ${count}` : count }));
    }
  });
  useEffect(() => { drainScanQueue(); }, [scanBusy, queuedScans]);

  const loadScanReady = loadConfirmation?.tone !== "error" && loadStep === "cart";
  const drainLoadQueue = useEffectEvent(() => {
    const decision = decideDrain({ busy: loadBusy, waiting: queuedLoadScans, onScreen: view === "load", cancelling: cancelRequested, ready: loadScanReady });
    if (decision === "idle") return;
    if (decision === "process") {
      const next = loadScanQueue.current.take();
      setQueuedLoadScans(loadScanQueue.current.size);
      if (next !== undefined) void submitLoadScan(next);
      return;
    }
    const dropped = loadScanQueue.current.flush();
    setQueuedLoadScans(0);
    if (decision === "discard" && dropped.length) {
      signalScanFailure("scanNotProcessed");
      const why = loadConfirmation?.tone === "error" ? "the previous outbound card needs attention. Acknowledge it" : "the destination changed. Check it";
      const count = `${dropped.length} queued scan${dropped.length === 1 ? " was" : "s were"} not processed because ${why}, then rescan.`;
      setNotice((current) => ({ tone: "error", text: current?.tone === "error" ? `${current.text} ${count}` : count }));
    }
  });
  useEffect(() => { drainLoadQueue(); }, [loadBusy, queuedLoadScans]);

  // A scanner types into whatever has focus. A dismissed toast, a re-rendered control or a
  // focused button can leave no input to receive it, and a scan's Enter would press that
  // button. Catch such a burst ourselves: hand it to the screen if it can take it, and
  // refuse it loudly if not. It must never disappear.
  const packingInputLive = view === "scan" && Boolean(activeTask && activeCart && activeLine) && !scanComplete && !activeLineCaptured
    && !cameraOpen && !missingInventory?.capturing && !(scanFeedback?.requiresContinue && scanFeedback.lineId === activeLine?.id);
  const handleOrphanScan = useEffectEvent((value: string) => {
    if (handheldMenuOpen) { rejectScan("Close the station menu before scanning. This scan was not processed."); return; }
    if (view === "load") { void submitLoadScan(value); return; }
    if (view === "scan" && packingInputLive) { void submitScan(value); return; }
    rejectScan("A scan arrived while this screen was waiting for a tap, so it was not processed. Finish the step on screen, then scan again.");
  });
  const handleUnreadableScan = useEffectEvent(() => {
    rejectScan("That scan held a special key or was too long to read reliably, so it was not processed. Scan it again.");
  });
  useEffect(() => {
    if (view !== "scan" && view !== "load") return;
    const detector = new ScanBurstDetector();
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // Inputs and dialogs (native or ARIA, such as the camera and test-capture panels) receive their own keystrokes.
      if (target?.closest("input, textarea, select, dialog, [role='dialog'], [aria-modal='true'], [contenteditable]:not([contenteditable='false'])")) { detector.reset(); return; }
      // Space presses a focused button or summary, so a person's Space is left alone and it
      // is held back only when it is part of a burst already in progress.
      const holdSpace = event.key === " " && detector.continuesBurst(event.timeStamp);
      const result = detector.push({ key: event.key, time: event.timeStamp, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat });
      if (holdSpace) event.preventDefault();
      if (result.kind === "scan" || result.kind === "rejected") {
        // The terminating Enter or Tab of a scan must not act on whatever is focused.
        event.preventDefault();
        event.stopPropagation();
        if (result.kind === "scan") handleOrphanScan(result.value);
        else handleUnreadableScan();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [view]);

  const handleFallbackBeforeReceive = (captured: { rawValues: string[]; unitOfMeasure: string; supplierId: string }): ReceiveCheckResult => {
    if (!activeCart) return { reason: "no_matching_demand", message: "Open the picklist again before receiving this container." };
    const actual = capturedPackingContents(captured.rawValues, captured.unitOfMeasure, captured.supplierId);
    const pending = activeCart.lines.filter((line) => (line.status === "pending" || line.status === "active") && !scanReceiptsRef.current[`${line.id}:aiagSerial`]?.complete);
    const result = checkPackingDemand(pending, actual, settings.packingMode, settings.partAttribute);
    return result.line ? true : { reason: result.reason || "no_matching_demand", message: `This container is not required by the remaining demand on this picklist. ${result.message}` };
  };

  const closePicklistShort = async () => {
    if (!activeCart || picklistActionBusy || scanBusyRef.current || receivingBusyRef.current) return;
    if (!await confirmChange(`Close picklist ${activeCart.picklistNumber} with shortages? Every unfinished line will be marked Short. Packed quantities stay recorded. A supervisor must unpack/reset this picklist to reopen it.`, undefined, { title: "Close picklist short?", confirmLabel: "Close with shortages" })) return;
    setPicklistActionBusy(true);
    try {
      const response = await fetch("/api/picklists/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cartKey: activeCart.key, sessionId, operatorName }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "The picklist could not be closed.");
      setActiveCartKey(null); setActivePicklistKey(null); setScanTasks([]); setScanIndex(0);
      setMissingInventory(null); setScanReceipts({}); setScanFeedback(null); setScanComplete(false); setCameraOpen(false);
      setView("overview");
      await refreshState();
      setNotice({ tone: "info", text: `Picklist ${activeCart.picklistNumber} closed with shortages. Its packed inventory remains allocated.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to close picklist." }); }
    finally { setPicklistActionBusy(false); }
  };

  const unpackPicklist = async (cart: CartGroup) => {
    if (!canManage || picklistActionBusy) return;
    if (!await confirmChange(`Unpack picklist ${cart.picklistNumber}? This returns its packed quantities to inventory, clears its fulfillment and loading status, and reopens every line. The previous packing and reset remain in the audit history.`, undefined, { title: "Unpack / reset picklist?", confirmLabel: "Unpack picklist" })) return;
    setPicklistActionBusy(true);
    try {
      const response = await fetch("/api/picklists/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cartKey: cart.key, sessionId, operatorName }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "The picklist could not be reset.");
      try {
        const saved = window.sessionStorage.getItem("ppa.fulfillment-attempt");
        const reset = fulfillmentAttemptAfterReset(fulfillmentAttempt.current, saved ? JSON.parse(saved) : null, cart.key);
        fulfillmentAttempt.current = reset.attempt;
        if (reset.clearStored) window.sessionStorage.removeItem("ppa.fulfillment-attempt");
        for (const key of Object.keys(window.sessionStorage)) if (key.includes(encodeURIComponent(`packing:${cart.key}:`)) || cart.lines.some((line) => key.includes(encodeURIComponent(`packing:${line.id}:`)))) window.sessionStorage.removeItem(key);
      } catch {
        // Preserve foreign or unreadable retries. A retained own-cart draft is
        // safely rejected as reversed by the server on its next retry.
        if (fulfillmentAttempt.current?.request.cartKey === cart.key) fulfillmentAttempt.current = null;
      }
      setScanReceipts({});
      handleInventoryReceived();
      await refreshState();
      setNotice({ tone: "success", text: `Picklist ${cart.picklistNumber} is unpacked. Its allocated quantities are available again.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to unpack picklist." }); }
    finally { setPicklistActionBusy(false); }
  };

  const handleUnpackClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const cart = carts.find((candidate) => candidate.key === event.currentTarget.dataset.cartKey);
    if (cart) void unpackPicklist(cart);
  };

  const parseSpreadsheet = async (file: File) => {
    const parseId = ++importParseId.current;
    setImportError("");
    setImportRows([]);
    setImportFile(file);
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        throw new Error("Spreadsheet files must be smaller than 4 MB. Save a large workbook as compressed XLSX.");
      }
      const rows = await parseDemandSpreadsheet(await file.arrayBuffer());
      if (parseId === importParseId.current) setImportRows(rows);
    } catch (error) {
      if (parseId === importParseId.current) setImportError(error instanceof Error ? error.message : "Unable to read this spreadsheet.");
    }
  };

  const uploadImport = async () => {
    if (!importFile || !importRows.length || importBusy) return;
    if (!await confirmChange("Make this spreadsheet the active demand batch? Changes to reserved picklists wait until those reservations are released. Omitted dispatched picklists leave the active queue; their audit history is retained.")) return;
    setImportError("");
    setImportBusy(true);
    try {
      type ImportPayload = { error?: string; code?: string; rowCount?: number; shrink?: { reason: string; unworkedLines: number; removedLines: number } };
      const postImport = async (allowShrink: boolean) => {
        const form = new FormData();
        form.set("file", importFile);
        form.set("action", "replace");
        if (allowShrink) form.set("allowShrink", "true");
        const result = await fetch("/api/import", { method: "POST", body: form });
        return { response: result, payload: await result.json() as ImportPayload };
      };
      let { response, payload } = await postImport(false);
      if (response.status === 409 && payload.code === "shrink_confirmation_required" && payload.shrink) {
        // Nothing has changed yet. A file that would retire most open demand is usually
        // truncated or the wrong file, so require a typed confirmation before resending.
        const { removedLines, unworkedLines, reason } = payload.shrink;
        const cause = reason === "empty_snapshot"
          ? "This file has no demand rows, which usually means an export failed."
          : "A truncated or wrong file usually causes this.";
        const proceed = await confirmChange(
          `${cause} Importing it would remove ${removedLines} of ${unworkedLines} demand lines that have no scan, packing or loading activity yet. Lines already worked are kept. Continue only if this file is the complete list of open demand.`,
          "REMOVE",
          { title: "Remove open demand?", confirmLabel: "Import and remove" },
        );
        if (!proceed) {
          setImportError("Import cancelled. No demand was changed.");
          return;
        }
        ({ response, payload } = await postImport(true));
      }
      if (!response.ok) throw new Error(payload.error || "Import failed.");
      setNotice({ tone: "success", text: `${importRows.length} rows imported. The work queue is ready.` });
      setImportFile(null);
      setImportRows([]);
      setWorkScope("production");
      resetSupervisorFilters();
      await refreshState(true);
      setView("overview");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  };

  const submitManualImport = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (manualImportBusy) return;

    setManualImportError("");
    setManualImportResult("");
    const quantity = parseQuantity(manualImportDraft.quantity, manualImportDraft.unitOfMeasure);
    const requiredValues = [
      manualImportDraft.plant,
      manualImportDraft.zone,
      manualImportDraft.shipCategory,
      manualImportDraft.movementNumber,
      manualImportDraft.picklistNumber,
      manualImportDraft.sequence,
      manualImportDraft.partNumber,
      ...(manualImportDraft.areaType === "offsite" ? [manualImportDraft.loadingSequence] : []),
    ];
    if (requiredValues.some((value) => !value.trim()) || !Number.isFinite(quantity) || quantity <= 0) {
      setManualImportError("Complete every required field. Quantity must be positive and valid for the selected unit (whole numbers for EA).");
      return;
    }

    const manualRow: ImportRow = {
      plant: manualImportDraft.plant,
      zone: manualImportDraft.zone,
      areaType: manualImportDraft.areaType,
      shipCategory: manualImportDraft.shipCategory,
      loadNumber: manualImportDraft.areaType === "offsite" ? manualImportDraft.movementNumber : "",
      trainNumber: manualImportDraft.areaType === "onsite" ? manualImportDraft.movementNumber : "",
      picklistNumber: manualImportDraft.picklistNumber,
      cartNumber: manualImportDraft.cartNumber,
      cartId: manualImportDraft.cartId,
      palletId: manualImportDraft.palletId,
      sequence: manualImportDraft.sequence,
      partNumber: manualImportDraft.partNumber,
      description: manualImportDraft.description,
      color: manualImportDraft.color,
      quantity,
      unitOfMeasure: manualImportDraft.unitOfMeasure,
      aiagSerial: "",
      loadingSequence: manualImportDraft.areaType === "offsite" ? manualImportDraft.loadingSequence : "",
      checksheetNumber: manualImportDraft.checksheetNumber,
      masterBarcode: manualImportDraft.masterBarcode,
      movementBarcode: manualImportDraft.movementBarcode,
      cartSequenceNumber: manualImportDraft.cartSequenceNumber,
    };

    setManualImportBusy(true);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "append", fileName: "manual-entry", rows: [manualRow] }),
      });
      const payload = await response.json() as { error?: string; totalRowCount?: number; createdBatch?: boolean };
      if (!response.ok) throw new Error(payload.error || "Unable to add this demand row.");

      const resultText = payload.createdBatch
        ? `Created the active demand with ${manualImportDraft.partNumber} on picklist ${manualImportDraft.picklistNumber}.`
        : `Added ${manualImportDraft.partNumber} to picklist ${manualImportDraft.picklistNumber}. Active demand now has ${payload.totalRowCount ?? state.lines.length + 1} rows.`;
      setManualImportResult(resultText);
      setNotice({ tone: "success", text: "Demand row added. It is ready for scanning." });
      setManualImportDraft((current) => ({
        ...current,
        sequence: "",
        partNumber: "",
        description: "",
        color: "",
        quantity: "1",
      }));
      await refreshState(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to add this demand row.";
      setManualImportError(message.replace(/^Row 2\s+/, ""));
    } finally {
      setManualImportBusy(false);
    }
  };

  const downloadTemplate = () => {
    const anchor = document.createElement("a");
    anchor.href = "/cartflow-demo-pick-list.csv";
    anchor.download = "ppa-import-template.csv";
    anchor.click();
  };

  const downloadSectionPdf = async (areaType: "onsite" | "offsite") => {
    if (pdfBusyArea) return;
    setPdfBusyArea(areaType);
    try {
      const response = await fetch("/api/picklists/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "section", areaType, workScope }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "Unable to generate this checksheet PDF.");
      }
      const disposition = response.headers.get("content-disposition") || "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
      const filename = encodedName ? decodeURIComponent(encodedName) : quotedName || `${areaType === "onsite" ? "trains" : "loads"}-checksheets.pdf`;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice({ tone: "success", text: `${filename} is ready.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Unable to generate this checksheet PDF." });
    } finally {
      setPdfBusyArea(null);
    }
  };

  const beginDemandEdit = (line: CartLine) => {
    setEditingLineId(line.id);
    setDemandDraft({
      loadNumber: line.loadNumber,
      trainNumber: line.trainNumber,
      picklistNumber: line.picklistNumber,
      cartNumber: line.cartNumber,
      cartId: line.cartId,
      palletId: line.palletId,
      partNumber: line.partNumber,
      description: line.description,
      color: line.color,
      quantity: String(line.quantity),
      unitOfMeasure: line.unitOfMeasure || "EA",
    });
  };

  const saveDemandEdit = async () => {
    if (!editingLineId || !demandDraft || demandBusy) return;
    const currentLine = state.lines.find((line) => line.id === editingLineId);
    if (!currentLine) {
      setNotice({ tone: "error", text: "This demand row is no longer in the active batch." });
      return;
    }
    const quantity = parseQuantity(demandDraft.quantity, demandDraft.unitOfMeasure);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setNotice({ tone: "error", text: "Quantity must be positive and valid for the selected unit (whole numbers for EA)." });
      return;
    }
    const candidate: DemandLinePatch = {
      loadNumber: demandDraft.loadNumber.trim(),
      trainNumber: demandDraft.trainNumber.trim(),
      picklistNumber: demandDraft.picklistNumber.trim(),
      cartNumber: demandDraft.cartNumber.trim(),
      cartId: demandDraft.cartId.trim(),
      palletId: demandDraft.palletId.trim(),
      partNumber: demandDraft.partNumber.trim(),
      description: demandDraft.description.trim(),
      color: demandDraft.color.trim(),
      quantity,
      unitOfMeasure: demandDraft.unitOfMeasure,
    };
    const changes = Object.fromEntries(Object.entries(candidate).filter(([field, value]) =>
      String(currentLine[field as keyof CartLine] ?? "") !== String(value)
    )) as DemandLinePatch;
    if (!Object.keys(changes).length) {
      setEditingLineId(null);
      setDemandDraft(null);
      setNotice({ tone: "info", text: "No demand values changed." });
      return;
    }
    setDemandBusy(true);
    try {
      const response = await fetch("/api/demand", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: editingLineId, changes }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Demand could not be updated.");
      setEditingLineId(null);
      setDemandDraft(null);
      await refreshState(true);
      setNotice({ tone: "success", text: "Open demand updated." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Demand update failed." });
    } finally {
      setDemandBusy(false);
    }
  };

  const deleteDemand = async (line: CartLine) => {
    if (line.status !== "pending" || line.fulfilledQuantity > 0 || demandBusy) return;
    if (!await confirmChange(`Remove sequence ${line.sequence}, part ${line.partNumber}, from open demand?`)) return;
    setDemandBusy(true);
    try {
      const response = await fetch("/api/demand", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: line.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Demand could not be removed.");
      if (editingLineId === line.id) {
        setEditingLineId(null);
        setDemandDraft(null);
      }
      await refreshState(true);
      setNotice({ tone: "success", text: "Open demand row removed." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Demand removal failed." });
    } finally {
      setDemandBusy(false);
    }
  };

  const deleteAllData = async () => {
    if (!canReset || clearBusy || scanBusyRef.current || receivingBusyRef.current) return;
    if (!await confirmChange("This permanently removes every import batch, demand row, inventory container, receipt, scan, packing and loading record, reservation, and audit record. It clears ALL production and test work across every load and train, regardless of dashboard filters. Sign-in access and application configuration are kept. This cannot be undone.", "CLEAR ALL DATA", { title: "Clear all data?", confirmLabel: "Clear all data" })) return;
    setClearBusy(true);
    try {
      const response = await fetch("/api/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE_ALL_CARTFLOW_DATA" }),
      });
      const result = await response.json() as { deleted?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "PPA data could not be deleted.");
      // Ignore queue requests that started before the reset completed.
      stateRequestId.current += 1;
      stateValidator.current = "";
      stateFetchInFlight.current = false;
      setEditingLineId(null);
      setDemandDraft(null);
      setImportFile(null);
      setImportRows([]);
      setImportError("");
      setManualImportDraft(EMPTY_MANUAL_IMPORT);
      setManualImportError("");
      setManualImportResult("");
      setState(EMPTY_STATE);
      setSelectedMovementKey(null);
      setSelectedPicklistKey(null);
      setPackingMovementKey(null);
      setPackingMovementValue("");
      setQuickCartValue("");
      setScanPlant(null);
      setScanArea(null);
      resetSupervisorFilters();
      setActiveCartKey(null);
      setActivePicklistKey(null);
      setScanTasks([]);
      setScanIndex(0);
      setScanValue("");
      setScanComplete(false);
      setScanReceipts({});
      setScanFeedback(null);
      setLastPacked(null);
      setMissingInventory(null);
      setSerialSuppliers(null);
      setSelectedSupplier("");
      resetLoadConfirmation(false);
      let draftsCleared = true;
      const clearedAttempt = fulfillmentAttemptAfterReset(fulfillmentAttempt.current, null, null);
      fulfillmentAttempt.current = clearedAttempt.attempt;
      try {
        // Old completed or unfinished receipts must not outlive a deliberate reset.
        if (clearedAttempt.clearStored) window.sessionStorage.removeItem("ppa.fulfillment-attempt");
        const keys = Object.keys(window.sessionStorage).filter((key) => key.startsWith("cartflow.receiving.draft.v1:"));
        keys.forEach((key) => window.sessionStorage.removeItem(key));
      } catch { draftsCleared = false; }
      setDataResetRevision((revision) => revision + 1);
      setReceivingDirty(false);
      handleInventoryReceived();
      await refreshState(true);
      setView("overview");
      setNotice({
        tone: draftsCleared ? "success" : "info",
        text: `${result.deleted || 0} records cleared. All production and test data has been removed.${draftsCleared ? "" : " This browser could not clear saved receiving or packing drafts; close this tab before receiving or packing inventory."}`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "PPA reset failed." });
    } finally {
      setClearBusy(false);
    }
  };

  const renderSupervisorStatus = (status: SupervisorStatus, exceptionCount = 0) => (
    <StatusPill tone={status}>
      {status === "attention" && exceptionCount ? `Attention · ${exceptionCount}` : statusLabel(status)}
    </StatusPill>
  );

  const renderMovementPanel = (areaType: "onsite" | "offsite", groups: MovementGroup[]) => {
    const label = areaType === "onsite" ? "Train" : "Load";
    const sectionLines = state.lines.filter((line) => line.areaType === areaType);
    const sectionMovements = areaType === "onsite" ? allTrains : allLoads;
    const sectionPicklists = new Set(sectionLines.map(picklistKey)).size;
    const preparingSection = pdfBusyArea === areaType;
    return (
      <article className={`panel supervisor-panel movement-panel movement-panel-${areaType}`}>
        <div className="panel-heading supervisor-panel-heading">
          <div><p className="eyebrow">All {label.toLowerCase()} status</p><h2>{label}s</h2></div>
          <div className="panel-heading-actions movement-pdf-actions">
            <span className="panel-meta">{sectionMovements.length} {sectionMovements.length === 1 ? label.toLowerCase() : `${label.toLowerCase()}s`} · {sectionPicklists} {sectionPicklists === 1 ? "picklist" : "picklists"}</span>
            <button
              className="button button-secondary pdf-download-button"
              title={`Print all ${label.toLowerCase()} checksheets in ${workScope} work, including rows hidden by filters`}
              disabled={Boolean(pdfBusyArea) || !sectionLines.length}
              onClick={() => void downloadSectionPdf(areaType)}
            >{preparingSection ? "Preparing…" : "Print checksheets"}</button>
          </div>
        </div>
        {groups.length > 0 ? (
          <div className="supervisor-table-wrap" role="region" aria-label={`${label} movement queue`} tabIndex={0}>
            <table className="supervisor-table movement-table">
              <caption className="sr-only">All {label.toLowerCase()} verification statuses</caption>
              <thead><tr><th scope="col">{label} #</th><th scope="col">Last activity (CT)</th><th scope="col">Progress</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {groups.map((movement) => {
                  const selected = selectedMovement?.key === movement.key;
                  const movementProgress = movement.total ? Math.round((movement.verified / movement.total) * 100) : 0;
                  return (
                    <tr className={selected ? "supervisor-row-selected" : ""} key={movement.key}>
                      <td data-label={`${label} #`}>
                        <button
                          className="supervisor-id"
                          aria-pressed={selected}
                          onClick={() => {
                            setSelectedMovementKey(movement.key);
                            setSelectedPicklistKey(null);
                            setPicklistSearch("");
                            setDemandSearch("");
                          }}
                        >
                          <strong>{movement.number}</strong>
                          <span>{movement.plant} · {movement.picklistCount} {movement.picklistCount === 1 ? "picklist" : "picklists"} · {movement.zones.join(", ")}</span>
                        </button>
                      </td>
                      <td data-label="Last activity">
                        {movement.lastActivity ? <time dateTime={movement.lastActivity} title={`${formatCentralTime(movement.lastActivity)} Central Time`}>{formatCentralTime(movement.lastActivity)}</time> : <span className="supervisor-muted">—</span>}
                      </td>
                      <td data-label="Progress">
                        <div className="supervisor-progress"><span><strong>{movement.verified}</strong> / {movement.total}</span><div className="progress-track" role="progressbar" aria-label={`${label} ${movement.number} packing progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={movementProgress}><span style={{ width: `${movementProgress}%` }} /></div></div>
                      </td>
                      <td data-label="Status">{renderSupervisorStatus(movement.status, movement.mismatchCount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className="supervisor-empty"><span>{areaType === "onsite" ? "TR" : "LD"}</span><div><strong>{supervisorFiltersActive ? `No ${label.toLowerCase()}s match these filters` : `No ${label.toLowerCase()}s in this plan`}</strong><p>{supervisorFiltersActive ? "Change or clear the work queue filters to see other work." : `Imported ${areaType === "onsite" ? "onsite" : "offsite"} work will appear here.`}</p></div></div>}
      </article>
    );
  };

  const renderOverview = () => (
    <>
      <section className="page-heading supervisor-heading">
        <div className="heading-intro">
          <p className="eyebrow">Operations overview · {workScope === "test" ? "Test movements" : "Production movements"}</p>
          <h1>Supervisor dashboard</h1>
          <p className="heading-copy">Reconcile each inbound inventory container against an outbound picklist demand line. Review progress and exceptions across your operations.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" disabled={loading} onClick={() => void refreshState()}><OperationIcon name="refresh" />{loading ? "Refreshing…" : "Refresh"}</button>
          <a className="button button-secondary" href="/api/scans/export" download>Export scans ↓</a>
          {canReset && <button className="button button-danger" disabled={clearBusy || scanBusy || receivingBusy || importBusy || demandBusy} onClick={() => void deleteAllData()}>{clearBusy ? "Clearing…" : "Clear all data"}</button>}
        </div>
      </section>

      <section className="supervisor-summary" aria-label="Current operations summary">
        <article><span>Loads</span><strong>{allLoads.length}</strong><small>{allLoads.filter((movement) => movement.status === "loaded").length} loaded · {allLoads.filter((movement) => movement.status === "active").length} working</small></article>
        <article><span>Trains</span><strong>{allTrains.length}</strong><small>{allTrains.filter((movement) => movement.status === "loaded").length} loaded · {allTrains.filter((movement) => movement.status === "active").length} working</small></article>
        <article><span>Active scans</span><strong>{state.locks.length}</strong><small>{state.locks.length ? "Operators on picklists" : "No picklists locked"}</small></article>
        <article className="summary-progress"><span>Parts packed</span><strong>{progress}<small>%</small></strong><div className="progress-track" role="progressbar" aria-label="Overall packing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div></article>
        <article className={openExceptionLineIds.size ? "summary-attention" : ""}><span>Needs attention</span><strong>{openExceptionLineIds.size}</strong><small>{openExceptionLineIds.size ? "Demand exceptions" : "No open mismatches"}</small></article>
        <div className="supervisor-legend">
          <span>{state.lines.length} demand rows · {new Set(state.lines.map(picklistKey)).size} picklists in this work environment</span>
          <details className="status-guide"><summary>Status guide</summary><p>Packed means every demand line is fulfilled by a matching inventory container. Loaded means every picklist passed the final destination check. Dispatched means physical departure was confirmed. Short means the picklist was closed with unfulfilled demand. TEST identifies work using the separate test inventory.</p></details>
        </div>
      </section>

      <section className="fulfillment-metrics" aria-label="Picklist fulfillment analytics">
        <article><span>Packed picklists</span><strong>{metrics.packed}</strong></article>
        <article><span>Unpacked picklists</span><strong>{metrics.unpacked}</strong></article>
        <article className={metrics.short ? "shortage-metric" : ""}><span>Picklists with shorts</span><strong>{metrics.short ? "⚠ " : ""}{metrics.short}</strong></article>
        <article><span>Pick efficiency</span><strong>{metrics.completion}%</strong><small>Demand lines packed / total lines</small></article>
      </section>

      {workScope === "production" && <InventoryLiveSummary revision={inventoryRevision} onOpenInventory={() => void navigateTo("inventory")} />}

      <div className="queue-toolbar">
        <div className="queue-toolbar-heading"><h2>Work queue</h2><span role="status" aria-live="polite">{matchingMovements.length} of {movements.length} movements</span></div>
        <div className="queue-search" role="search" aria-label="Filter supervisor work queue">
          <label className="queue-search-field"><OperationIcon name="search" /><span className="sr-only">Find work</span><input type="search" value={searchQuery} onChange={(event) => updateSupervisorFilters({ query: event.target.value })} placeholder="Search movement, barcode, part, lot or serial…" /></label>
          <label className="queue-status-filter"><span>Movement</span><select value={movementTypeFilter} onChange={(event) => updateSupervisorFilters({ areaType: event.target.value as SupervisorFilters["areaType"], zone: "" })}><option value="all">Loads and trains</option><option value="offsite">Loads</option><option value="onsite">Trains</option></select></label>
          <label className="queue-status-filter"><span>Plant</span><select value={plantFilter} onChange={(event) => updateSupervisorFilters({ plant: event.target.value, zone: "" })}><option value="">All plants</option>{supervisorPlants.map((plant) => <option key={plant} value={plant}>{plant}</option>)}</select></label>
          <label className="queue-status-filter"><span>Delivery zone</span><select value={zoneFilter} onChange={(event) => updateSupervisorFilters({ zone: event.target.value })}><option value="">All zones</option>{supervisorZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label className="queue-status-filter"><span>Movement status</span><select value={statusFilter} onChange={(event) => updateSupervisorFilters({ status: event.target.value as SupervisorFilters["status"] })}><option value="all">All statuses</option><option value="short">With shortages</option><option value="attention">Needs attention</option><option value="active">In progress</option><option value="ready">Unpacked</option><option value="done">Packed</option><option value="loaded">Loaded</option><option value="dispatched">Dispatched</option></select></label>
          <button className="text-button" disabled={!supervisorFiltersActive && !picklistSearch && !demandSearch} onClick={resetSupervisorFilters}>Clear filters</button>
        </div>
      </div>
      {supervisorFiltersActive && !matchingMovements.length && <p className="search-empty" role="status">No movements match the current filters. Change or clear the filters to see other work.</p>}
      <section className="supervisor-grid" aria-label="Supervisor work status">
        {renderMovementPanel("offsite", loads)}

        <article className="panel supervisor-panel picklist-panel">
          <div className="panel-heading supervisor-panel-heading">
            <div><p className="eyebrow">Load or train status</p><h2>{selectedMovement ? `Picklists · ${selectedMovement.number}` : "Picklists"}</h2></div>
            <span className="panel-meta" role="status">{selectedMovement ? `${picklists.length} of ${allPicklists.length} picklists · Plant ${selectedMovement.plant}` : "Select a movement"}</span>
          </div>
          <div className="supervisor-panel-search"><label><span>Find picklists</span><input type="search" disabled={!selectedMovement} value={picklistSearch} onChange={(event) => { setPicklistSearch(event.target.value); setSelectedPicklistKey(null); setDemandSearch(""); }} placeholder="Picklist, master barcode, cart or pallet…" /></label></div>
          {selectedMovement && picklists.length > 0 ? (
            <div className="supervisor-table-wrap" role="region" aria-label="Picklists in selected movement" tabIndex={0}>
              <table className="supervisor-table picklist-table">
                <caption className="sr-only">Picklists for {movementLabel(selectedMovement.areaType)} {selectedMovement.number}</caption>
                <thead><tr><th scope="col">Picklist #</th><th scope="col">Parts</th><th scope="col">Progress</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {picklists.map((picklist) => {
                    const selected = selectedPicklist?.key === picklist.key;
                    const picklistProgress = picklist.total ? Math.round((picklist.verified / picklist.total) * 100) : 0;
                    return (
                      <tr className={selected ? "supervisor-row-selected" : ""} key={picklist.key}>
                        <td data-label="Picklist #"><button className="supervisor-id" aria-pressed={selected} onClick={() => { setSelectedPicklistKey(picklist.key); setDemandSearch(""); }}><strong>{picklist.number}</strong><span>{[...new Set(picklist.lines.map((line) => line.unitOfMeasure || "EA"))].join(" / ")}</span></button></td>
                        <td data-label="Parts"><strong>{picklist.total}</strong><details><summary>Outbound card identifiers</summary>{picklist.carts.some(picklistNeedsReconciliation) ? <span className="cell-detail">Reconciliation required: conflicting outbound cards. Ask a supervisor to correct this picklist before packing.</span> : <span className="cell-detail">{[picklist.carts[0]?.cartNumber, picklist.carts[0]?.cartId, picklist.carts[0]?.palletId].filter(Boolean).join(" · ")}</span>}</details></td>
                        <td data-label="Progress"><div className="supervisor-progress"><span><strong>{picklist.verified}</strong> / {picklist.total}</span><div className="progress-track" role="progressbar" aria-label={`Picklist ${picklist.number} packing progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={picklistProgress}><span style={{ width: `${picklistProgress}%` }} /></div></div></td>
                        <td data-label="Status">{renderSupervisorStatus(picklist.status, picklist.mismatchCount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="supervisor-empty"><span>PL</span><div><strong>{selectedMovement ? "No picklists match these filters" : "Select a load or train"}</strong><p>{selectedMovement ? "Change or clear the picklist search to see other work." : "Its picklists will appear here."}</p></div></div>}
        </article>

        {renderMovementPanel("onsite", trains)}

        <article className="panel supervisor-panel parts-panel">
          <div className="panel-heading supervisor-panel-heading">
            <div><p className="eyebrow">Picklist status</p><h2>{selectedPicklist ? `Demand lines · ${selectedPicklist.number}` : "Demand lines"}</h2></div>
            <span className="panel-meta" role="status">{selectedPicklist ? `${visibleDemandLines.length} of ${selectedPicklist.total} demand lines · packing status` : "Select a picklist"}</span>
          </div>
          <div className="supervisor-panel-search"><label><span>Find demand lines</span><input type="search" disabled={!selectedPicklist} value={demandSearch} onChange={(event) => setDemandSearch(event.target.value)} placeholder="Part, color, sequence, lot, location or serial…" /></label></div>
          {selectedPicklist && visibleDemandLines.length > 0 ? (
            <div className="supervisor-table-wrap" role="region" aria-label="Parts in selected picklist" tabIndex={0}>
              <table className="supervisor-table parts-table">
                <caption className="sr-only">Part verification status for picklist {selectedPicklist.number}</caption>
                <thead><tr><th scope="col">Part #</th><th scope="col">Color</th><th scope="col">Qty</th><th scope="col">Outbound card</th><th scope="col">Operational status</th></tr></thead>
                <tbody>
                  {visibleDemandLines
                    .map((line) => {
                      const lineHasMismatch = state.events.some((event) => event.lineId === line.id && !event.matched) && line.status !== "verified";
                      const lineWasTested = state.events.some((event) => event.lineId === line.id && event.matched && event.isTest);
                      const lineCart = selectedPicklist.carts.find((cart) => cart.lines.some((cartLine) => cartLine.id === line.id));
                      const lineStatus: SupervisorStatus = line.status === "short" ? "short" : lineHasMismatch || lineCart?.requiresReconciliation ? "attention" : line.dispatchedAt ? "dispatched" : line.loadedAt ? "loaded" : line.status === "verified" ? "done" : line.status === "active" || line.fulfilledQuantity > 0 || lineCart?.lock ? "active" : "ready";
                      return (
                        <tr key={line.id}>
                          <td data-label="Part #"><strong className="part-number">{line.partNumber}</strong><span className="cell-detail">Pack seq. {line.packSequence || line.sequence}{line.description ? ` · ${line.description}` : ""}</span></td>
                          <td data-label="Color"><strong>{line.color || partAttribute.empty}</strong></td>
                          <td data-label="Qty"><strong>{line.quantity} {line.unitOfMeasure || "EA"}</strong><span className="cell-detail">{line.fulfilledQuantity || 0} fulfilled · {remainingDemand(line)} remaining</span><span className="cell-detail">{line.allocations?.length ? line.allocations.map((allocation) => `${allocation.serial} (${allocation.quantity})`).join(", ") : line.aiagSerial}</span></td>
                          <td data-label="Outbound card"><strong>{line.cartNumber}</strong><span className="cell-detail">{line.palletId}</span></td>
                          <td data-label="Operational status"><div className="status-with-marker">{renderSupervisorStatus(lineStatus, lineHasMismatch ? 1 : 0)}{lineWasTested && <span className="test-record-marker">TEST</span>}</div></td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ) : <div className="supervisor-empty"><span>PT</span><div><strong>{selectedPicklist ? "No demand lines match these filters" : selectedMovement ? "Select a picklist" : "Select a load or train first"}</strong><p>{selectedPicklist ? "Change or clear the demand line search to see other parts." : "Demand-line verification will appear here."}</p></div></div>}
        </article>
      </section>
    </>
  );

  const renderScan = () => {
    if (activeCart && picklistNeedsReconciliation(activeCart)) return <section className="handheld-task packing-task"><h1>Picklist needs reconciliation</h1><p role="alert">{PICKLIST_RECONCILIATION_MESSAGE}</p><button className="button button-secondary" disabled={scanBusy || receivingBusy} onClick={() => void leaveScan("scan")}>Release picklist and return</button></section>;
    if (!activeCart || !scanTasks.length) {
      return <section className={`packing-start ${compactScanner ? "handheld-task" : "station-select"}`}>
        <div className="page-heading"><div><p className="eyebrow">Packing</p><h1>{packingMovement ? "Scan picklist" : packingSetupReady ? `Scan ${scanArea === "onsite" ? "train" : "load"}` : "Set up packing"}</h1><p>{packingMovement ? "Scan the cart master barcode." : "Choose your plant and movement type, then scan."}</p></div></div>
        {!packingMovement ? <>
          <div className="packing-filters">
            <label htmlFor="packing-plant">1. Plant<select id="packing-plant" value={scanPlant || ""} required onChange={(event) => changePackingSetup(event.target.value || null, scanArea)}><option value="">Choose plant</option>{plants.map((plant) => <option key={plant}>{plant}</option>)}</select></label>
            <label htmlFor="packing-area">2. Movement type<select id="packing-area" value={scanArea || ""} required disabled={!scanPlant} onChange={(event) => changePackingSetup(scanPlant, (event.target.value || null) as typeof scanArea)}><option value="">Choose movement type</option><option value="onsite">Train</option><option value="offsite">Load</option></select></label>
          </div>
          <form className="packing-cart-form" onSubmit={(event) => { event.preventDefault(); submitPackingMovement(); }}>
            <label htmlFor="packing-movement-barcode">3. {packingSetupReady && scanArea ? `${movementLabel(scanArea)} barcode` : "Scan barcode"}</label>
            <input id="packing-movement-barcode" ref={quickCartInput} value={packingMovementValue} disabled={!packingSetupReady} aria-describedby="packing-setup-help" onChange={(event) => setPackingMovementValue(event.target.value)} inputMode={compactScanner ? "none" : "text"} autoComplete="off" placeholder={packingSetupReady ? "Ready to scan…" : "Complete setup first"} onKeyDown={(event) => { if (event.key === "Tab" && !event.shiftKey && packingMovementValue.trim()) { event.preventDefault(); submitPackingMovement(); } }} />
            <p id="packing-setup-help" className="packing-help" role="status">{packingSetupReady ? `Scan the ${scanArea === "onsite" ? "train" : "load"} barcode for Plant ${scanPlant}. No tap needed.` : packingSetupHelp}</p>
            {packingSetupReady && packingMovementValue.trim() && <button className="button button-primary" type="submit">Find movement</button>}
          </form>
          {packingSetupReady && <button className="button button-secondary" onClick={() => setManualCartSelection((current) => !current)}>{manualCartSelection ? "Hide selection" : "Choose manually"}</button>}
          {packingSetupReady && manualCartSelection && <div className="station-grid">{packingMovements.map((movement) => <article className="station-cart" key={movement.key}><p className="eyebrow">Plant {movement.plant}</p><h2>{movementLabel(movement.areaType)} {movement.number}</h2><p>{movement.picklistCount} picklists · {movement.total - movement.verified} parts remaining</p><button className="button button-primary button-full" data-movement-key={movement.key} onClick={handleChoosePackingMovement}>Select {movement.areaType === "onsite" ? "train" : "load"}</button></article>)}</div>}
          {packingSetupReady && !packingMovements.length && <p>No unfinished {scanArea === "onsite" ? "trains" : "loads"} in Plant {scanPlant}.</p>}
          {!plants.length && <p>No packing demand is available. Import demand to choose a plant.</p>}
        </> : <>
          <div className="packing-context"><strong>{movementLabel(packingMovement.areaType)} {packingMovement.number} · Plant {packingMovement.plant}</strong><button className="button button-secondary" onClick={() => { setPackingMovementKey(null); setQuickCartValue(""); }}>Change movement</button></div>
          <form className="packing-cart-form" onSubmit={(event) => { event.preventDefault(); void submitQuickCart(); }}>
            <label className="sr-only" htmlFor="packing-cart-barcode">Picklist / master barcode</label>
            <input id="packing-cart-barcode" ref={quickCartInput} value={quickCartValue} onChange={(event) => setQuickCartValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Tab" && !event.shiftKey && quickCartValue.trim()) { event.preventDefault(); void submitQuickCart(); } }} placeholder="Ready to scan" autoFocus autoComplete="off" autoCapitalize="characters" enterKeyHint="done" inputMode={compactScanner ? "none" : "text"} spellCheck={false} />
            {(quickCartValue.trim() || lockBusyKey) && <button className="button button-primary" disabled={Boolean(lockBusyKey)} type="submit">{lockBusyKey ? "Opening picklist…" : "Open picklist"}</button>}
          </form>
          <button className="button button-secondary" onClick={() => setManualCartSelection((current) => !current)}>{manualCartSelection ? "Hide picklist selection" : "Choose picklist manually"}</button>
          {packingConflicts.length > 0 && <div className="packing-feedback packing-feedback-error" role="alert"><strong>Reconciliation required</strong><p>{PICKLIST_RECONCILIATION_MESSAGE}</p><p>Affected picklists: {packingConflicts.join(", ")}</p></div>}
          {manualCartSelection && <div className="station-grid">{packingPicklists.map(({ number, records }) => {
            const blocked = packingConflicts.includes(normalizeIdentityBarcode(number));
            const cart = records[0];
            return <article className="station-cart" key={number}><h2>Picklist {number}</h2><p>{records.reduce((sum, record) => sum + record.total - record.verified, 0)} demand lines remaining</p>{blocked ? <p role="alert">Packing blocked. Ask a supervisor to reconcile this picklist to one outbound card.</p> : <><p className="cell-detail">Outbound card: {[cart.cartNumber, cart.cartId, cart.palletId].filter(Boolean).join(" · ")}</p>{cart.lock && !cart.lock.isOwned && cart.lock.isOwnedByOperator ? <button className="button button-secondary button-full" disabled={Boolean(lockBusyKey)} data-cart-key={cart.key} onClick={handleReleaseReservationClick}>{lockBusyKey === cart.key ? "Releasing…" : "Release my reservation"}</button> : <button className="button button-primary button-full" data-cart-key={cart.key} disabled={Boolean((cart.lock && !cart.lock.isOwned) || lockBusyKey)} onClick={handleStartCartClick}>{cart.lock && !cart.lock.isOwned ? `In use by ${cart.lock.operatorName}` : "Open picklist"}</button>}</>}</article>;
          })}</div>}
        </>}
        {packingMovement && <p className="packing-help">Scan to continue. No tap needed.</p>}
      </section>;
    }
    if (scanComplete) return <section className="handheld-task packing-task packing-complete">
      <p className="eyebrow">Picklist {activeCart.picklistNumber}</p><div className="handheld-success-symbol" aria-hidden="true">✓</div><h1>Picklist complete</h1><p role="status">All {activeCart.total} lines packed.</p>
      <button className="button button-primary" onClick={() => void leaveScan("scan")}>Scan another picklist</button><button className="button button-secondary" onClick={() => void leaveScan("load")}>Confirm loading</button>
    </section>;
    if (!activeTask || !activeLine) return null;
    const isCartScan = activeTask.field === "cartBarcode";
    const currentFeedback = scanFeedback?.lineId === activeLine.id ? scanFeedback : null;
    const fulfilledSerial = activeLine.aiagSerial || scanReceipts[`${activeLine.id}:aiagSerial`]?.value || "";
    const remainingLines = activeCart.lines.filter((line) => (line.status === "pending" || line.status === "active") && !scanReceipts[`${line.id}:aiagSerial`]?.complete);
    const receiptDefaults = packingReceiptDefaults(remainingLines);
    const receivingContainer = !isCartScan && workScope !== "test" && !activeLineCaptured && !currentFeedback?.requiresContinue
      && missingInventory?.capturing;
    return <section className="packing-workspace">
      <div className="packing-context"><span title={activeCart.picklistNumber}>{activeCart.picklistNumber}</span><strong>{activeCart.verified} / {activeCart.total} packed</strong></div>
      <article className="handheld-task packing-task">
        <p className="eyebrow">{isCartScan ? "Confirm picklist" : "Packing"}</p>
        {!receivingContainer && <h1>{currentFeedback?.requiresContinue ? "Container already recorded" : isCartScan ? "Scan picklist" : activeLineCaptured ? "Line packed" : "Scan container serial"}</h1>}
        {!isCartScan && !receivingContainer && !activeLineCaptured && !currentFeedback?.requiresContinue && <p>Remaining: {remainingLines.length} {remainingLines.length === 1 ? "line" : "lines"}</p>}
        {currentFeedback && <div className={`packing-feedback packing-feedback-${currentFeedback.tone}`} role={currentFeedback.tone === "error" ? "alert" : "status"}>{!currentFeedback.requiresContinue && <strong>{currentFeedback.title}</strong>}<p>{currentFeedback.message}</p></div>}
        {currentFeedback?.requiresContinue ? <button className="button button-primary" onClick={() => void continuePacking()}>Scan another container</button> : activeLineCaptured ? <>
          <dl className="packing-demand"><div><dt>Inventory serial</dt><dd>{fulfilledSerial}</dd></div><div><dt>Fulfilled quantity</dt><dd>{(activeLine.fulfilledQuantity || activeLine.quantity).toLocaleString(undefined, { maximumFractionDigits: 6 })} {activeLine.unitOfMeasure || "EA"}</dd></div></dl>
          <button className="button button-primary" onClick={() => void advanceAfterReview()}>{remainingLines.length ? "Scan another container" : "Finish picklist →"}</button>
        </> : !receivingContainer && <>
          <p id="packing-scan-help">{isCartScan ? "Scan the cart master barcode." : settings.packingMode === "multiple" ? "Scan any container serial. Its contents will be matched to remaining demand; any unused quantity stays available." : `Scan any container serial. Its part, ${partAttribute.label.toLowerCase()}, and quantity will be matched to remaining demand.`}</p>
          <form className="packing-scan-form" onSubmit={(event) => { event.preventDefault(); void submitScan(); }}>
            <label className="sr-only" htmlFor="packing-scan-value">{isCartScan ? "Picklist barcode" : "Inventory serial barcode"}</label>
            <input id="packing-scan-value" ref={scanInput} value={scanValue} onChange={(event) => { setScanValue(event.target.value); setSerialSuppliers(null); setSelectedSupplier(""); }}
              onKeyDown={(event) => { if (event.key === "Tab" && !event.shiftKey && event.currentTarget.value.trim()) { event.preventDefault(); void submitScan(event.currentTarget.value); } }}
              onPointerDown={preloadScanVoices} placeholder={isCartScan ? "Scan picklist…" : "Scan serial…"} aria-busy={scanBusy} autoComplete="off" autoCapitalize="characters" enterKeyHint="done" inputMode={compactScanner ? "none" : "text"} spellCheck={false} aria-describedby="packing-scan-help" />
            {(scanValue.trim() || scanBusy) && <button className="button button-primary" type="submit">{scanBusy ? "Checking…" : "Check scan"}</button>}
          </form>
          {queuedScans > 0 && <p className="packing-queued" role="status">{queuedScans} more scan{queuedScans === 1 ? "" : "s"} waiting to be checked.</p>}
          {lastPacked && !currentFeedback && <p className="packing-last" role="status">✓ {lastPacked.serial} packed · line {lastPacked.sequence}</p>}
        </>}
        {serialSuppliers && !activeLineCaptured && <div className="packing-missing"><p>This serial exists for more than one supplier. Select the supplier printed on this container.</p><label>Supplier<select value={selectedSupplier} onChange={(event) => setSelectedSupplier(event.target.value)}><option value="">Select supplier</option>{serialSuppliers.suppliers.map((supplier) => <option key={supplier} value={supplier || "__legacy__"}>{supplier || "Legacy / unspecified supplier"}</option>)}</select></label><button className="button button-primary" disabled={scanBusy || !selectedSupplier} onClick={() => void submitScan(serialSuppliers.serial, selectedSupplier === "__legacy__" ? "" : selectedSupplier)}>Check selected supplier</button></div>}
        {receivingContainer && <div className="packing-receive">
          <ReceiveInventory partAttribute={settings.partAttribute} key={`packing:${activeCart.key}:${missingInventory?.serial || ""}`} operatorName={operatorName} ownerId={initialAccess?.principal?.id || "local"} initialSerial={missingInventory?.serial || ""} initialInventory={missingInventory?.inventory} unitOfMeasure={receiptDefaults.unitOfMeasure} supplierId={selectedSupplier === "__legacy__" ? "" : selectedSupplier || receiptDefaults.supplierId} contextKey={`packing:${activeCart.key}:${missingInventory?.serial || ""}`} autoContinue editableMetadata beforeReceive={handleFallbackBeforeReceive} onSkip={() => void continuePacking()}
            onBusyChange={handleReceivingBusy} onReceived={handleInventoryReceived} onContinue={(serial, supplier) => submitScan(serial, supplier, "received")} />
        </div>}
        {missingInventory && workScope === "test" && !activeLineCaptured && <p>Use Capture test inventory to add this container to the test inventory, then scan its serial here.</p>}
        <details className="packing-line-details"><summary>Picklist details &amp; actions</summary>
          <h2 className="packing-demand-heading">All required demand</h2>
          <ol className="packing-demand-list" aria-label="All picklist demand lines">{activeCart.lines.map((line) => {
            const fulfilled = packingDemandIsFulfilled(line) || Boolean(scanReceipts[`${line.id}:aiagSerial`]?.complete);
            return <li key={line.id}>
              <div className="packing-demand-status"><strong>Pack sequence {line.packSequence || line.sequence}</strong><span>{fulfilled ? "Packed" : packingLineLabel(line)}</span></div>
              <dl><div><dt>Part number</dt><dd>{line.partNumber}</dd></div><div><dt>{partAttribute.label}</dt><dd>{line.color || partAttribute.empty}</dd></div><div><dt>Ordered quantity</dt><dd>{line.quantity} {line.unitOfMeasure || "EA"}</dd></div><div><dt>Fulfilled / remaining</dt><dd>{line.fulfilledQuantity || 0} / {remainingDemand(line)}</dd></div>{line.preferredSupplierId && <div><dt>Required supplier</dt><dd>{line.preferredSupplierId}</dd></div>}{Boolean(line.allocations?.length || fulfilled) && <div><dt>Container serials</dt><dd>{line.allocations?.length ? line.allocations.map((allocation) => `${allocation.serial} (${allocation.quantity})`).join(", ") : line.aiagSerial || scanReceipts[`${line.id}:aiagSerial`]?.value || "Historical verification"}</dd></div>}{line.fulfilledAt && <div><dt>Last packed</dt><dd>{formatCentralTime(line.fulfilledAt)} · {line.fulfilledBy}</dd></div>}</dl>
            </li>;
          })}</ol>
          <dl><div><dt>Outbound card</dt><dd>{[activeCart.cartNumber, activeCart.cartId, activeCart.palletId].filter(Boolean).join(" · ")}</dd></div><div><dt>{movementLabel(activeCart.areaType)}</dt><dd>{activeCart.areaType === "onsite" ? activeCart.trainNumber : activeCart.loadNumber}</dd></div></dl>
          {receivingContainer && <button className="button button-secondary" disabled={receivingBusy || scanBusy} onClick={() => setMissingInventory(null)}>Change container</button>}
          {!isCartScan && !receivingContainer && !activeLineCaptured && !currentFeedback?.requiresContinue && <button className="button button-secondary" disabled={scanBusy} onClick={() => setCameraOpen(true)}>Use camera for serial</button>}
          <button className="button button-secondary" disabled={scanBusy || receivingBusy} onClick={() => void leaveScan("scan")}>Release &amp; exit picklist</button>
          <button className="button button-danger" disabled={scanBusy || receivingBusy || picklistActionBusy} onClick={() => void closePicklistShort()}>{picklistActionBusy ? "Closing…" : "Close with shortages"}</button>
        </details>
      </article>
      {!compactScanner && <aside className="panel packing-parts"><div className="panel-heading"><h2>Picklist demand lines</h2></div><ol>{activeCart.lines.map((line) => <li key={line.id}><strong>{line.packSequence || line.sequence}. {line.partNumber}</strong><span>{line.color || partAttribute.empty} · {line.quantity} {line.unitOfMeasure || "EA"}</span><span>{packingLineLabel(line)} · {line.fulfilledQuantity || 0} fulfilled · {remainingDemand(line)} remaining</span>{line.allocations?.map((entry) => <span key={entry.id}>{entry.serial} · {entry.quantity}</span>)}</li>)}</ol></aside>}
    </section>;
  };

  const renderLoadConfirm = () => {
    const readyCarts = carts.filter((cart) => cart.verified === cart.total && !cart.loadedAt);
    const loadedCarts = carts.filter((cart) => Boolean(cart.loadedAt) && !cart.dispatchedAt);
    const dispatchedCarts = carts.filter((cart) => Boolean(cart.dispatchedAt));
    const activeValue = loadStep === "movement" ? loadMovementValue : loadCartValue;
    const activeLabel = loadStep === "movement" ? "Destination Load / Train barcode" : "Picklist / master barcode";
    if (compactScanner) {
      return (
        <section className="handheld-load-page" aria-label="Load confirmation">
          {loadConfirmation && <div className={`handheld-load-result handheld-load-result-${loadConfirmation.tone}`} role={loadConfirmation.tone === "error" ? "alert" : "status"} aria-live="assertive">
            <span className="handheld-load-result-mark" aria-hidden="true">{loadConfirmation.tone === "success" ? "✓" : "!"}</span>
            {loadConfirmation.testMode && <strong className="handheld-load-test">Test confirmation</strong>}
            <h1>{loadConfirmation.tone === "success" ? loadConfirmation.dispatchedAt ? "Picklist dispatched" : loadConfirmation.alreadyLoaded ? "Picklist already loaded" : "Picklist loaded" : loadConfirmation.title}</h1>
            {(loadConfirmation.picklistNumber || loadConfirmation.cartBarcode) && <p className="handheld-load-result-id"><strong>{loadConfirmation.picklistNumber || loadConfirmation.cartBarcode}</strong></p>}
            <p>{loadConfirmation.tone === "success" ? loadConfirmation.dispatchedAt ? "Physical departure recorded." : loadConfirmation.testMode ? "Correct destination. This is a test record." : loadConfirmation.alreadyLoaded ? "This outbound card was already confirmed at this destination." : "Correct destination. Loading recorded." : loadConfirmation.message}</p>
            <div className="handheld-load-result-actions">
              {loadConfirmation.tone === "success" && !loadConfirmation.dispatchedAt && <button className="button button-secondary" disabled={loadBusy} onClick={() => void confirmDispatch()}>{loadBusy ? "Recording…" : "Confirm departure"}</button>}
              {loadConfirmation.tone === "error" && <button className="button button-primary" onClick={() => resetLoadConfirmation(true)}>OK, scan next outbound card</button>}
              {loadConfirmation.tone === "error" && <button className="button button-secondary" onClick={() => resetLoadConfirmation(false)}>Start over</button>}
            </div>
            {loadConfirmation.tone === "success" && <details className="handheld-load-details"><summary>Confirmation details</summary><dl><div><dt>Destination</dt><dd>{loadConfirmation.movementNumber || loadMovementValue}</dd></div><div><dt>Outbound card</dt><dd>{loadConfirmation.cartNumber || loadConfirmation.cartBarcode || "—"}</dd></div><div><dt>Picklist</dt><dd>{loadConfirmation.picklistNumber || "—"}</dd></div></dl><p>{loadConfirmation.message}</p></details>}
          </div>}
          {loadConfirmation?.tone !== "error" && <>
            <h1 {...(loadConfirmation ? { role: "heading", "aria-level": 2 } : {})}>{loadStep === "movement" ? "Scan destination" : loadConfirmation ? "Scan next outbound card" : "Scan outbound card checksheet"}</h1>
            <p className="handheld-load-instruction" id="handheld-load-instructions">{loadStep === "movement" ? "Scan the load or train barcode." : "Scan the picklist or master barcode on the sheet."}</p>
            <form className="handheld-load-form" onSubmit={(event) => { event.preventDefault(); void submitLoadScan(); }}>
              <label className="sr-only" htmlFor="handheld-load-barcode">{activeLabel}</label>
              <input
                id="handheld-load-barcode"
                ref={loadInput}
                value={activeValue}
                onChange={(event) => loadStep === "movement" ? setLoadMovementValue(event.target.value) : setLoadCartValue(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Tab" && !event.shiftKey && activeValue.trim()) { event.preventDefault(); void submitLoadScan(); } }}
                placeholder="Scan barcode"
                autoComplete="off"
                autoCapitalize="characters"
                enterKeyHint="done"
                inputMode="none"
                spellCheck={false}
                aria-describedby="handheld-load-instructions"
                aria-busy={loadBusy}
              />
              <button type="submit" className="button button-primary" disabled={!activeValue.trim()}>{loadBusy ? "Checking…" : loadStep === "movement" ? "Continue" : "Confirm placement"}</button>
            </form>
            {loadBusy && loadStep === "cart" && <p className="handheld-load-instruction" role="status">Checking the last scan…</p>}
            {queuedLoadScans > 0 && <p className="handheld-load-instruction" role="status">{queuedLoadScans} more scan{queuedLoadScans === 1 ? "" : "s"} waiting to be checked.</p>}
            {loadStep === "cart" && <div className="handheld-load-destination"><span>Destination</span><strong>{loadMovementValue}</strong><button type="button" className="button button-secondary" onClick={() => resetLoadConfirmation(false)} disabled={loadBusy}>Change destination</button></div>}
          </>}
        </section>
      );
    }
    return (
      <section className="load-confirm-page">
        <div className="page-heading compact-heading load-confirm-heading">
          <div><p className="eyebrow">Final physical placement</p><h1>Load confirm</h1><p className="heading-copy">Scan the destination, then the outbound card’s checksheet. PPA permits loading only when every demand line on its picklist is packed and assigned to that load or train.</p></div>
          <button className="button button-secondary" onClick={() => void navigateTo("overview")}>Back to dashboard</button>
        </div>

        <div className="load-confirm-layout">
          <div className="load-confirm-station">
            {loadConfirmation && <div className={`load-decision load-decision-${loadConfirmation.tone}`} role={loadConfirmation.tone === "error" ? "alert" : "status"} aria-live="assertive">
              <span className="load-decision-mark">{loadConfirmation.tone === "success" ? "✓" : "!"}</span>
              <p className="eyebrow">{loadConfirmation.tone === "success" ? "Server approved" : "Server blocked"}</p>
              {loadConfirmation.testMode && <span className="test-record-marker">TEST</span>}
              <h2>{loadConfirmation.title}</h2>
              {(loadConfirmation.picklistNumber || loadConfirmation.cartBarcode) && <p className="load-decision-id"><strong>{loadConfirmation.picklistNumber || loadConfirmation.cartBarcode}</strong></p>}
              <p>{loadConfirmation.message}</p>
              {loadConfirmation.tone === "success" && <dl><div><dt>Movement</dt><dd>{loadConfirmation.movementNumber || loadMovementValue}</dd></div><div><dt>Outbound card</dt><dd>{loadConfirmation.cartNumber || loadConfirmation.cartBarcode || "—"}</dd></div><div><dt>Picklist</dt><dd>{loadConfirmation.picklistNumber || "—"}</dd></div></dl>}
              <div className="load-confirm-actions">
                {loadConfirmation.tone === "success" && !loadConfirmation.dispatchedAt && <button className="button button-secondary" disabled={loadBusy} onClick={() => void confirmDispatch()}>{loadBusy ? "Recording…" : "Confirm departure"}</button>}
                {loadConfirmation.tone === "error" && <button className="button button-primary" onClick={() => resetLoadConfirmation(true)}>OK, scan next cart</button>}
                {loadConfirmation.tone === "error" && <button className="button button-secondary" onClick={() => resetLoadConfirmation(false)}>Start over</button>}
              </div>
            </div>}
            {loadConfirmation?.tone !== "error" && <>
              <div className="load-confirm-stage-heading"><span>{loadStep === "movement" ? "01" : "02"}</span><div><p>{loadStep === "movement" ? "Identify the destination first" : `Destination ${loadMovementValue} captured`}</p><h2>{loadStep === "movement" ? "Scan load or train" : loadConfirmation ? "Scan the next outbound card checksheet" : "Scan the outbound card checksheet"}</h2></div></div>
              <form onSubmit={(event) => { event.preventDefault(); void submitLoadScan(); }}>
                <label className="load-scan-shell">
                  <span>Scanner</span>
                  <input
                    ref={loadInput}
                    value={activeValue}
                    onChange={(event) => loadStep === "movement" ? setLoadMovementValue(event.target.value) : setLoadCartValue(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Tab" && !event.shiftKey && activeValue.trim()) { event.preventDefault(); void submitLoadScan(); } }}
                    placeholder={`Scan ${activeLabel}…`}
                    autoComplete="off"
                    autoCapitalize="characters"
                    enterKeyHint="done"
                    inputMode="none"
                    spellCheck={false}
                    aria-label={`Scan ${activeLabel}`}
                    aria-describedby="load-scan-instructions"
                    aria-busy={loadBusy}
                  />
                </label>
                <p className="load-scan-hint" id="load-scan-instructions"><span><i /> Trigger ready</span> Enter or Tab submits the scan automatically.{loadBusy && loadStep === "cart" && " Checking the last scan…"}{queuedLoadScans > 0 && ` ${queuedLoadScans} more scan${queuedLoadScans === 1 ? "" : "s"} waiting to be checked.`}</p>
                <div className="load-confirm-actions">
                  {loadStep === "cart" && <button type="button" className="button button-secondary" disabled={loadBusy} onClick={() => resetLoadConfirmation(false)}>Rescan destination</button>}
                  <button type="submit" className="button button-primary" disabled={!activeValue.trim()}>{loadBusy ? "Checking assignment…" : loadStep === "movement" ? "Accept destination →" : "Confirm outbound card placement →"}</button>
                </div>
              </form>
            </>}
          </div>
          <aside className="load-confirm-rail" aria-label="Loading progress and counts">
            <p className="eyebrow">Two-scan gate</p>
            <ol>
              <li className={loadStep === "movement" && loadConfirmation?.tone !== "error" ? "load-step-active" : loadMovementValue ? "load-step-done" : ""}><span>{loadMovementValue ? "✓" : "1"}</span><div><strong>Destination</strong><small>Scan the load or train barcode at the dock.</small></div></li>
              <li className={loadStep === "cart" && loadConfirmation?.tone !== "error" ? "load-step-active" : loadConfirmation?.tone === "success" ? "load-step-done" : ""}><span>{loadConfirmation?.tone === "success" ? "✓" : "2"}</span><div><strong>Outbound card</strong><small>Rescan the checksheet or master barcode attached to the outbound card.</small></div></li>
            </ol>
            <div className="load-confirm-metrics"><div><strong>{readyCarts.length}</strong><span>Packed, ready</span></div><div><strong>{loadedCarts.length}</strong><span>Loaded</span></div><div><strong>{dispatchedCarts.length}</strong><span>Dispatched</span></div></div>
          </aside>
        </div>

        <section className="load-ready-strip" aria-label="Outbound cards ready for loading">
          <div><p className="eyebrow">Staging visibility</p><h2>Packed outbound cards waiting for placement</h2></div>
          <div className="load-ready-list">{readyCarts.length ? readyCarts.slice(0, 8).map((cart) => <article key={cart.key}><span>{cart.areaType === "onsite" ? "TR" : "LD"}</span><div><strong>{cart.cartNumber}</strong><small>{cart.areaType === "onsite" ? cart.trainNumber : cart.loadNumber} · {cart.picklistNumber}</small></div></article>) : <p>There are no packed outbound cards waiting for load confirmation.</p>}</div>
        </section>
      </section>
    );
  };

  const renderImport = () => {
    const updateManualImport = (field: keyof ManualImportDraft, value: string) => {
      setManualImportDraft((current) => ({ ...current, [field]: value }));
      setManualImportError("");
      setManualImportResult("");
    };

    return (
      <section className="import-page">
        <div className="page-heading compact-heading"><div><p className="eyebrow">Demand administration</p><h1>Import demand</h1><p className="heading-copy">Replace the full plan from a spreadsheet, or add a specific row without replacing the current plan.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => setView("overview")}>Back to dashboard</button></div></div>

        <div className="import-method-switch" role="group" aria-label="Demand import method">
          <button type="button" aria-pressed={importMode === "spreadsheet"} className={importMode === "spreadsheet" ? "import-method-active" : ""} onClick={() => setImportMode("spreadsheet")}><span>Spreadsheet batch</span><small>Replace active demand</small></button>
          <button type="button" aria-pressed={importMode === "manual"} className={importMode === "manual" ? "import-method-active" : ""} onClick={() => setImportMode("manual")}><span>Add one row</span><small>Keep current demand</small></button>
        </div>

        {importMode === "spreadsheet" ? <>
          <p className="import-method-note"><strong>Spreadsheet behavior:</strong> activating the file updates production demand. Changes to reserved picklists wait until their reservations are released. Unfinished worked demand must remain unchanged. Omitted dispatched picklists leave the active queue with their history preserved. Generated TEST work is kept separately.</p>
          <div className="import-layout">
            <article className="panel import-panel">
              <div className="panel-heading"><div><p className="eyebrow">Step 1</p><h2>Choose spreadsheet</h2></div><button className="text-button" onClick={downloadTemplate}>Download template ↓</button></div>
              <div className="demo-download">
                <div>
                  <span className="demo-file-mark">CSV</span>
                  <div><strong>Need test data?</strong><p>Download 10 example rows using the common demand headers: TRAIN and LOAD, separate delivery locations, and loading sequence for loads.</p></div>
                </div>
                <a className="button button-primary" href="/cartflow-demo-pick-list.csv" download="ppa-example-demand.csv">Download example demand ↓</a>
              </div>
              <label className={`drop-zone ${importFile ? "drop-zone-ready" : ""}`}>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseSpreadsheet(file); }} />
                <span className="upload-mark">↑</span>
                <strong>{importFile ? importFile.name : "Choose a spreadsheet file"}</strong>
                <p>{importFile ? `${importRows.length || "Checking"} rows detected` : "Excel (.xlsx, .xls) or CSV · up to 10,000 rows"}</p>
              </label>
              {importError && <div className="inline-error"><span>!</span><div><strong>Spreadsheet needs attention</strong><p>{importError}</p></div></div>}
              <div className="required-columns"><h3>Required columns</h3><div>{["Type", "Train/Load Number", "Plant", "Delivery Zone", "Ship Category", "Picklist Number", "Container Packing Sequence", "Part Number", "Final Required Quantity"].map((header) => <span key={header}>{header}</span>)}</div><p>Part Colour is optional. Leave Fulfilled Quantity and Inventory Serial Number blank; PPA fills both when a container fulfills the demand.</p><h3 className="optional-columns-heading">Optional and conditional fields</h3><div>{["Part Colour", "Fulfilled Quantity", "Inventory Serial Number", "Unit of Measure", "Preferred Supplier ID", "Source Line ID", "Source Scope", "Program ID", "Total Carts", "P/Y/M/T/C", "Checksheet Number", "Master Barcode", "Movement Barcode", "Case Code", "O/G Serial", "Cart Sequence Number", "From / To Lot", "Model", "Cart Type", "Delivery / Dispatch Date / Time", "Header Delivery Location", "Detail Delivery Location", "Container Position / Type", "Container sequence", "From / To Model", "From / To Type", "From / To Option", "From / To Color", "From / To Interior Color", "From / To Units", "Container Total", "Picking Location", "MCID", "Chassis #", "Order #", "Batch #", "Loading Sequence", "Description", "Cart Number", "Cart ID", "Pallet ID"].map((header) => <span className="optional-column" key={header}>{header}</span>)}</div></div>
            </article>

            <aside className="panel import-guide">
              <p className="eyebrow">Import controls</p><h2>Before you activate a batch</h2>
              <div className="guide-step"><span>01</span><div><strong>Headers are matched automatically</strong><p>Use Type (TRAIN or LOAD) and Train/Load Number. Loading Sequence is optional. Delivery date/time and separate From/To vehicle fields are supported. Existing templates and production-report headings are still accepted.</p></div></div>
              <div className="guide-step"><span>02</span><div><strong>Every row is checked</strong><p>Blank identifiers, invalid quantities, non-printable values, or missing onsite barcode semantics stop the import before data changes.</p></div></div>
              <div className="guide-step"><span>03</span><div><strong>PDF layouts follow movement</strong><p>TRAIN rows produce cart-master pages; LOAD rows produce trailer-load pages. Header and detail delivery locations are kept separate.</p></div></div>
            </aside>
          </div>

          {importRows.length > 0 && (
            <article className="panel preview-panel">
              <div className="panel-heading"><div><p className="eyebrow">Step 2</p><h2>Review {importRows.length} rows</h2></div><button className="button button-primary" disabled={importBusy} onClick={() => void uploadImport()}>{importBusy ? "Importing…" : "Activate demand batch →"}</button></div>
              <div className="table-wrap" role="region" aria-label="Demand import preview" tabIndex={0}><table className="preview-table"><caption className="sr-only">Demand import preview, showing {Math.min(importRows.length, 8)} of {importRows.length} rows</caption><thead><tr><th scope="col">Plant</th><th scope="col">Area</th><th scope="col">Movement</th><th scope="col">Picklist</th><th scope="col">Cart</th><th scope="col">Cart ID</th><th scope="col">Pallet</th><th scope="col">Seq.</th><th scope="col">Part</th><th scope="col">Description</th><th scope="col">Color</th><th scope="col">Qty</th><th scope="col">Fulfillment</th></tr></thead><tbody>{importRows.slice(0, 8).map((row, index) => <tr key={`${row.aiagSerial}-${index}`}><td>{row.plant}</td><td>{row.areaType}</td><td>{row.areaType === "onsite" ? row.trainNumber : row.loadNumber}</td><td>{row.picklistNumber}</td><td>{row.cartNumber}</td><td>{row.cartId}</td><td>{row.palletId}</td><td>{row.sequence}</td><td>{row.partNumber}</td><td>{row.description || "—"}</td><td>{row.color}</td><td>{row.quantity} {row.unitOfMeasure || "EA"}</td><td>Assigned during packing</td></tr>)}</tbody></table></div>
              {importRows.length > 8 && <p className="preview-more">Showing 8 of {importRows.length} rows</p>}
            </article>
          )}
        </> : <>
          <p className="import-method-note import-method-note-safe"><strong>Manual row behavior:</strong> this adds to the active demand without replacing other rows. If demand is empty, it creates the first active batch.</p>
          <div className="manual-import-layout">
            <article className="panel manual-import-panel">
              <div className="panel-heading"><div><p className="eyebrow">Manual demand</p><h2>Add one specific row</h2></div><span className="manual-import-required">* Required</span></div>
              <form onSubmit={(event) => void submitManualImport(event)}>
                <section className="manual-import-section" aria-labelledby="manual-routing-heading">
                  <div className="manual-import-section-heading"><div><span>01</span><h3 id="manual-routing-heading">Movement and picklist</h3></div><p>One picklist identifies one outbound card or pallet.</p></div>
                  <div className="manual-import-grid">
                    <label><span>Plant *</span><input required value={manualImportDraft.plant} onChange={(event) => updateManualImport("plant", event.target.value)} placeholder="PLT-01" /></label>
                    <label><span>Area *</span><select required value={manualImportDraft.areaType} onChange={(event) => updateManualImport("areaType", event.target.value)}><option value="offsite">Offsite load</option><option value="onsite">Onsite train</option></select></label>
                    <label><span>{manualImportDraft.areaType === "onsite" ? "Train #" : "Load #"} *</span><input required value={manualImportDraft.movementNumber} onChange={(event) => updateManualImport("movementNumber", event.target.value)} placeholder={manualImportDraft.areaType === "onsite" ? "TR-301" : "LD-9002"} /></label>
                    {manualImportDraft.areaType === "offsite" && <label><span>Loading sequence *</span><input required value={manualImportDraft.loadingSequence} onChange={(event) => updateManualImport("loadingSequence", event.target.value)} placeholder="1" /></label>}
                    <label><span>Zone *</span><input required value={manualImportDraft.zone} onChange={(event) => updateManualImport("zone", event.target.value)} placeholder="A-12" /></label>
                    <label><span>Ship category *</span><input required value={manualImportDraft.shipCategory} onChange={(event) => updateManualImport("shipCategory", event.target.value)} placeholder="AA" /></label>
                    <label><span>Picklist # *</span><input required value={manualImportDraft.picklistNumber} onChange={(event) => updateManualImport("picklistNumber", event.target.value)} placeholder="PL-21006789" /></label>
                    <label><span>Outbound card number (optional)</span><input value={manualImportDraft.cartNumber} onChange={(event) => updateManualImport("cartNumber", event.target.value)} placeholder="CT-1001" /></label>
                    <label><span>Outbound card ID (optional)</span><input value={manualImportDraft.cartId} onChange={(event) => updateManualImport("cartId", event.target.value)} placeholder="CART-1001-A" /><small>An identifier for the same outbound card, not a separate container.</small></label>
                    <label><span>Outbound pallet ID (optional)</span><input value={manualImportDraft.palletId} onChange={(event) => updateManualImport("palletId", event.target.value)} placeholder="PAL-1001" /></label>
                  </div>
                </section>

                <section className="manual-import-section" aria-labelledby="manual-part-heading">
                  <div className="manual-import-section-heading"><div><span>02</span><h3 id="manual-part-heading">Part demand</h3></div><p>What the scanner will verify.</p></div>
                  <div className="manual-import-grid">
                    <label><span>Sequence *</span><input required value={manualImportDraft.sequence} onChange={(event) => updateManualImport("sequence", event.target.value)} placeholder="010" /></label>
                    <label className="manual-import-wide"><span>Part # *</span><input required value={manualImportDraft.partNumber} onChange={(event) => updateManualImport("partNumber", event.target.value)} placeholder="1971064A A010M4" /></label>
                    <label><span>{partAttribute.label} (optional)</span><input value={manualImportDraft.color} onChange={(event) => updateManualImport("color", event.target.value)} placeholder="12-M4" /></label>
                    <label><span>Quantity *</span><input required min={manualImportDraft.unitOfMeasure === "EA" ? "1" : "0.000001"} step={manualImportDraft.unitOfMeasure === "EA" ? "1" : "0.000001"} inputMode="decimal" type="number" value={manualImportDraft.quantity} onChange={(event) => updateManualImport("quantity", event.target.value)} /></label>
                    <label><span>Unit of measure</span><select value={manualImportDraft.unitOfMeasure} onChange={(event) => updateManualImport("unitOfMeasure", event.target.value)}>{["EA", "KG", "G", "MG", "M", "CM", "MM", "L", "ML", "LB", "OZ", "FT", "IN"].map((unit) => <option key={unit}>{unit}</option>)}</select></label>
                    <label className="manual-import-wide"><span>Description <b>Optional</b></span><input value={manualImportDraft.description} onChange={(event) => updateManualImport("description", event.target.value)} placeholder="Cooling module assembly" /></label>
                  </div>
                </section>

                <details className="manual-print-fields" open={manualImportDraft.areaType === "onsite"}>
                  <summary><span>03</span><div><strong>Print fields</strong><small>{manualImportDraft.areaType === "onsite" ? "Required when values cannot be derived" : "Optional for PDF output"}</small></div></summary>
                  <p>For an onsite train, supply a master barcode or checksheet number and a movement barcode unless PPA can derive them from the plant, category, train, zone, and cart sequence.</p>
                  <div className="manual-import-grid">
                    <label><span>Checksheet #</span><input value={manualImportDraft.checksheetNumber} onChange={(event) => updateManualImport("checksheetNumber", event.target.value)} /></label>
                    <label className="manual-import-wide"><span>Master barcode</span><input value={manualImportDraft.masterBarcode} onChange={(event) => updateManualImport("masterBarcode", event.target.value)} /></label>
                    <label className="manual-import-wide"><span>Movement barcode</span><input value={manualImportDraft.movementBarcode} onChange={(event) => updateManualImport("movementBarcode", event.target.value)} /></label>
                    <label><span>Cart sequence</span><input value={manualImportDraft.cartSequenceNumber} onChange={(event) => updateManualImport("cartSequenceNumber", event.target.value)} placeholder="1 / 4" /></label>
                  </div>
                </details>

                {manualImportError && <div className="inline-error manual-import-message" role="alert"><span>!</span><div><strong>Row needs attention</strong><p>{manualImportError}</p></div></div>}
                {manualImportResult && <div className="manual-import-success" role="status"><span>✓</span><div><strong>Row is ready</strong><p>{manualImportResult}</p></div><button type="button" className="button button-secondary" onClick={() => void navigateTo("overview")}>View work queue →</button></div>}
                <div className="manual-import-actions"><p>Existing demand stays active.</p><button type="submit" className="button button-primary" disabled={manualImportBusy}>{manualImportBusy ? "Adding row…" : "Add row to active demand →"}</button></div>
              </form>
            </article>

            <aside className="panel manual-import-guide">
              <p className="eyebrow">What happens next</p><h2>One row, normal workflow</h2>
              <ol><li><span>1</span><div><strong>PPA validates it</strong><p>The same demand and barcode rules used for spreadsheets apply here.</p></div></li><li><span>2</span><div><strong>The row joins active demand</strong><p>No other open rows or scanner reservations are replaced.</p></div></li><li><span>3</span><div><strong>Print, scan, and verify</strong><p>Generate the checksheet from the dashboard, then scan its picklist or master barcode.</p></div></li></ol>
            </aside>
          </div>
        </>}
      </section>
    );
  };

  const renderDemandMaintenance = () => {
    const pendingCount = state.lines.filter((line) => line.status !== "verified").length;
    const updateDraft = (field: keyof DemandDraft, value: string) => {
      setDemandDraft((current) => current ? { ...current, [field]: value } : current);
    };
    return (
      <section className="maintenance-page">
        <div className="page-heading compact-heading">
          <div><p className="eyebrow">Data administration</p><h1>Maintain open demand</h1><p className="heading-copy">Correct or remove unverified demand before operators begin packing. Verified rows remain locked for audit integrity.</p></div>
          <div className="heading-actions"><a className="button button-secondary" href="/api/audit/export" download title="Up to 10,000 recent changes; the CSV includes a link to older records.">Download recent audit ↓</a><a className="button button-secondary" href="/api/scans/export" download>Download scanned data ↓</a><button className="button button-secondary" onClick={() => setView("overview")}>Back to dashboard</button></div>
        </div>

        <section className="maintenance-summary" aria-label="Demand maintenance summary">
          <article><span>Open rows</span><strong>{pendingCount}</strong></article>
          <article><span>Packed rows</span><strong>{state.lines.length - pendingCount}</strong></article>
          <article><span>Current batch</span><strong>{state.lastImport?.fileName || "—"}</strong></article>
        </section>

        <FulfillmentSettingsPanel settings={settings} onSaved={(updated) => setState((current) => ({ ...current, settings: updated }))} disabled={picklistActionBusy || demandBusy} />

        <article className="panel picklist-reset-panel">
          <div className="panel-heading"><div><p className="eyebrow">Packing corrections</p><h2>Unpack / reset picklist</h2><p>Return allocated stock and reopen all lines. Dispatched picklists cannot be reset.</p></div></div>
          <label className="picklist-reset-search">Find a picklist<input type="search" value={resetSearch} onChange={(event) => setResetSearch(event.target.value)} placeholder="Picklist, load, train, plant, or outbound card" /></label>
          <ul className="picklist-reset-list">{carts.filter((cart) => [cart.picklistNumber, cart.loadNumber, cart.trainNumber, cart.plant, cart.cartNumber].some((value) => value.toLowerCase().includes(resetSearch.toLowerCase().trim()))).map((cart) => <li key={cart.key}>
            <div><strong>{cart.picklistNumber}</strong><span>{cart.plant} · {movementLabel(cart.areaType)} {cart.areaType === "onsite" ? cart.trainNumber : cart.loadNumber} · {cart.verified}/{cart.total} packed{cart.lines.some((line) => line.status === "short") ? " · ⚠ Short" : ""}</span></div>
            <button className="button button-secondary" data-cart-key={cart.key} disabled={picklistActionBusy || Boolean(cart.dispatchedAt) || Boolean(cart.lock && !cart.lock.isOwned)} onClick={handleUnpackClick}>{cart.dispatchedAt ? "Dispatched" : cart.lock && !cart.lock.isOwned ? `In use by ${cart.lock.operatorName}` : "Unpack / reset"}</button>
          </li>)}</ul>
        </article>

        {editingLineId && demandDraft && <article className="panel maintenance-editor">
          <div className="panel-heading"><div><p className="eyebrow">Edit open demand</p><h2>{demandDraft.partNumber}</h2></div><button className="text-button" onClick={() => { setEditingLineId(null); setDemandDraft(null); }}>Cancel</button></div>
          <div className="maintenance-form-grid">
            {([
              ["trainNumber", "Train #"], ["loadNumber", "Load #"], ["picklistNumber", "Picklist #"],
              ["cartNumber", "Outbound card #"], ["cartId", "Outbound card ID"], ["palletId", "Outbound pallet ID"],
              ["partNumber", "Part #"], ["description", "Description"], ["color", "Color"],
              ["quantity", "Required quantity"], ["unitOfMeasure", "Unit of measure"],
            ] as Array<[keyof DemandDraft, string]>).map(([field, label]) => <label key={field}><span>{label}</span><input value={demandDraft[field]} inputMode={field === "quantity" ? "decimal" : undefined} onChange={(event) => updateDraft(field, event.target.value)} /></label>)}
          </div>
          <div className="maintenance-editor-actions"><button className="button button-primary" disabled={demandBusy} onClick={() => void saveDemandEdit()}>{demandBusy ? "Saving…" : "Save demand changes"}</button></div>
        </article>}

        <article className="panel maintenance-table-panel">
          <div className="panel-heading"><div><p className="eyebrow">Current queue</p><h2>Header and detail demand</h2></div><span className="panel-meta">{state.lines.length} rows</span></div>
          <div className="supervisor-table-wrap" role="region" aria-label="Demand maintenance queue" tabIndex={0}><table className="supervisor-table maintenance-table"><caption className="sr-only">Current demand rows and maintenance actions</caption><thead><tr><th scope="col">Movement</th><th scope="col">Picklist</th><th scope="col">Cart</th><th scope="col">Seq.</th><th scope="col">Demand ID</th><th scope="col">Part</th><th scope="col">Color</th><th scope="col">Required qty</th><th scope="col">Fulfilled qty</th><th scope="col">Inventory serial</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>
            {state.lines.map((line) => <tr key={line.id}><td data-label="Movement"><strong>{line.areaType === "onsite" ? line.trainNumber : line.loadNumber}</strong><span className="cell-detail">{line.plant} · {movementLabel(line.areaType)}</span></td><td data-label="Picklist"><strong>{line.picklistNumber}</strong></td><td data-label="Outbound card"><strong>{line.cartNumber}</strong><span className="cell-detail">{line.cartId}</span></td><td data-label="Sequence">{line.sequence}</td><td data-label="Demand ID">{line.sourceLineId || line.id}</td><td data-label="Part"><strong>{line.partNumber}</strong><span className="cell-detail">{line.description || "—"}</span></td><td data-label="Color">{line.color || partAttribute.empty}</td><td data-label="Quantity">{line.quantity} {line.unitOfMeasure || "EA"}</td><td data-label="Fulfilled quantity">{line.fulfilledQuantity || 0} {line.unitOfMeasure || "EA"}</td><td data-label="Inventory serial">{line.allocations?.length ? line.allocations.map((entry) => `${entry.serial} (${entry.quantity})`).join(", ") : line.aiagSerial || "—"}</td><td data-label="Status"><StatusPill tone={line.dispatchedAt ? "dispatched" : line.loadedAt ? "loaded" : line.status === "short" ? "short" : line.status === "verified" ? "done" : line.status === "active" ? "active" : "ready"}>{line.dispatchedAt ? "Dispatched" : line.loadedAt ? "Loaded" : packingLineLabel(line)}</StatusPill></td><td data-label="Actions"><div className="row-actions"><button className="text-button" aria-label={`Edit part ${line.partNumber}, sequence ${line.sequence}, cart ${line.cartNumber}, picklist ${line.picklistNumber}`} disabled={line.status !== "pending" || line.fulfilledQuantity > 0 || demandBusy} onClick={() => beginDemandEdit(line)}>Edit</button><button className="text-button text-danger" aria-label={`Remove part ${line.partNumber}, sequence ${line.sequence}, cart ${line.cartNumber}, picklist ${line.picklistNumber}`} disabled={line.status !== "pending" || line.fulfilledQuantity > 0 || demandBusy} onClick={() => void deleteDemand(line)}>Remove</button></div></td></tr>)}
          </tbody></table></div>
        </article>
      </section>
    );
  };

  const handheldNoticeIsInline = simpleHandheld && !handheldMenuOpen && notice && (
    (view === "scan" && activeLine?.id === scanFeedback?.lineId && (
      notice.text === scanFeedback?.message || notice.text === `${scanFeedback?.title}.` ||
      (activeLineCaptured && notice.text === `Sequence ${activeLine?.sequence} verified against demand.`)
    )) || (view === "load" && notice.text === loadConfirmation?.message)
  );

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to {handheldWorkspace ? "station" : "work queue"}</a>
      <div className={`app-shell view-${view} ${handheldWorkspace ? "handheld-workspace" : "supervisor-workspace"} ${simpleHandheld ? "simple-handheld" : ""} ${compactScanner && view === "scan" ? "compact-scanner" : ""} ${view === "scan" && activeCart && !scanComplete && !handheldMenuOpen ? "packing-active" : ""}`}>
        {simpleHandheld ? <header className="handheld-header"><strong>PPA</strong><button disabled={cancelRequested} onClick={() => setCancelRequested(true)}>{cancelRequested ? "Canceling…" : "Cancel"}</button><button aria-expanded={handheldMenuOpen} aria-controls="main-content" disabled={scanBusy || Boolean(lockBusyKey) || loadBusy || receivingBusy} onClick={() => { setNotice(null); setHandheldMenuOpen(!handheldMenuOpen); }}>{handheldMenuOpen ? "Close" : "Menu"}</button></header> : <>
        <header className={`topbar ${view === "scan" ? "scan-topbar" : ""}`}>
          <button className="brand" onClick={() => void navigateTo(handheldWorkspace ? "scan" : "overview")}><span className="brand-mark"><i /><i /><i /></span><span className="brand-copy"><strong>PPA</strong><small>{handheldWorkspace ? "Handheld operations" : "Supervisor workspace"}</small></span></button>
          <span className="nav-section-label">{handheldWorkspace ? "Operator tools" : "Supervisor tools"}</span>
          <nav aria-label={handheldWorkspace ? "Handheld navigation" : "Supervisor navigation"}>
            {handheldWorkspace ? <>
              {canOperate && <button className={view === "receive" ? "nav-active" : ""} aria-current={view === "receive" ? "page" : undefined} onClick={() => void navigateTo("receive")}><OperationIcon name="receive" /><span>Receive inventory</span></button>}
              {canOperate && <button className={view === "scan" ? "nav-active" : ""} aria-current={view === "scan" ? "page" : undefined} onClick={() => void navigateTo("scan")}><OperationIcon name="scan" /><span>Scan station</span></button>}
              {canOperate && <button className={view === "load" ? "nav-active" : ""} aria-current={view === "load" ? "page" : undefined} onClick={() => void navigateTo("load")}><OperationIcon name="load" /><span>Load confirm</span></button>}
            </> : <>
            <button className={view === "overview" ? "nav-active" : ""} aria-current={view === "overview" ? "page" : undefined} onClick={() => void navigateTo("overview")}><OperationIcon name="overview" /><span>Supervisor</span></button>
            <button className={view === "inventory" ? "nav-active" : ""} aria-current={view === "inventory" ? "page" : undefined} onClick={() => void navigateTo("inventory")}><OperationIcon name="inventory" /><span>Inventory</span></button>
            {canManage && <button className={view === "import" ? "nav-active" : ""} aria-current={view === "import" ? "page" : undefined} onClick={() => void navigateTo("import")}><OperationIcon name="import" /><span>Import data</span></button>}
            {canManage && <button className={view === "manage" ? "nav-active" : ""} aria-current={view === "manage" ? "page" : undefined} onClick={() => void navigateTo("manage")}><OperationIcon name="manage" /><span>Maintain demand</span></button>}
            </>}
          </nav>
          <div className="operator-control"><span className="operator-avatar">OP</span><label><span>{localMode ? "Local operator" : role}</span><input value={operatorName} onChange={(event) => saveOperatorName(event.target.value)} aria-label="Operator name" disabled={!localMode || Boolean(activeCartKey) || receivingBusy} title={activeCartKey ? "Release the active picklist before changing operators." : undefined} /></label>{!localMode && <button className="sign-out" disabled={signingOut || scanBusy || receivingBusy} onClick={async () => { setSigningOut(true); try { await releaseCart(); const result = await fetch("/api/auth/logout", { method: "POST" }); if (!result.ok) throw new Error("Sign out failed. Try again."); window.location.assign("/"); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Sign out failed." }); setSigningOut(false); } }}>{signingOut ? "Signing out…" : "Sign out"}</button>}</div>
        </header>
        <div className="workspace-header"><div className="workspace-breadcrumb"><span>{handheldWorkspace ? "Handheld" : "Operations"}</span><span aria-hidden="true">/</span><strong>{{ overview: "Supervisor", receive: "Receive inventory", inventory: "Received inventory", scan: "Scan station", load: "Load confirmation", import: "Demand import", manage: "Demand maintenance" }[view]}</strong></div><div className="workspace-utilities">{handheldWorkspace && <button className="workspace-switch" disabled={cancelRequested} onClick={() => setCancelRequested(true)}>{cancelRequested ? "Canceling…" : "Cancel"}</button>}<span className={syncError ? "sync-state sync-state-error" : "sync-state"}><i aria-hidden="true" />{syncError ? "Updates paused" : lastSyncedAt ? `Updated ${formatCentralTime(lastSyncedAt)} CT` : "Connecting…"}</span>{canOperate && <button className="workspace-switch" disabled={scanBusy || Boolean(lockBusyKey) || loadBusy || receivingBusy} onClick={() => void navigateTo(handheldWorkspace ? "overview" : "scan")}>{handheldWorkspace ? "Supervisor workspace" : "Handheld workspace"}<span aria-hidden="true">↗</span></button>}</div></div>
        {localMode && <div className="environment-banner" role="status"><strong>Local workspace</strong><span>Development access · user authentication is disabled</span></div>}
        {testToolsEnabled && demandWorkspace && <div className={`work-scope-bar ${workScope === "test" ? "work-scope-test" : ""}`}><div role="group" aria-label="Work environment">{(["production", "test"] as const).map((scope) => <button key={scope} disabled={Boolean(activeCartKey) || scanBusy || Boolean(lockBusyKey)} aria-pressed={workScope === scope} onClick={() => { setWorkScope(scope); resetSupervisorFilters(); setScanPlant(null); setScanArea(null); }}>{scope === "production" ? "Production work" : "Test work"}</button>)}</div><span>{workScope === "test" ? "TEST work · excluded from production dashboard totals" : "Production demand · test projections are excluded"}</span></div>}
        </>}
        {simpleHandheld && demandWorkspace && workScope === "test" && <div className="handheld-test-banner" role="status">Test work</div>}
        {syncError && <div className="connection-banner" role="alert"><div><strong>Connection interrupted</strong><span>{simpleHandheld ? "Reconnect before continuing." : "The displayed queue may be out of date. Confirm status before repeating an action."}</span></div><button className="button button-secondary" onClick={() => void refreshState()}>Reconnect</button></div>}
        <main id="main-content" tabIndex={-1} className={view === "scan" && activeCart ? "main-scan" : "main-content"}>
          {simpleHandheld && handheldMenuOpen ? <section className="handheld-task handheld-menu"><h1>Station menu</h1>
            <label>Operator<input value={operatorName} onChange={(event) => saveOperatorName(event.target.value)} aria-label="Operator name" disabled={!localMode || Boolean(activeCartKey) || receivingBusy} /></label>
            {activeCartKey && <p>Release your picklist before changing operators.</p>}
            {receivingDirty && <p>Your unfinished inventory receipt is saved on this device.</p>}
            <button className="handheld-secondary" onClick={() => void navigateTo("receive")}>Receive inventory</button>
            <button className="handheld-secondary" onClick={() => { setHandheldMenuOpen(false); void navigateTo("scan"); }}>Pack picklist</button>
            <button className="handheld-secondary" onClick={() => void navigateTo("load")}>Confirm loading</button>
            <button className="handheld-secondary" onClick={() => void navigateTo("overview")}>Supervisor workspace</button>
            <button className="handheld-secondary" onClick={() => void refreshState()}>Refresh work</button>
            {testToolsEnabled && demandWorkspace && <details><summary>Test tools</summary><div className="handheld-menu-section"><div role="group" aria-label="Work environment">{(["production", "test"] as const).map((scope) => <button key={scope} disabled={Boolean(activeCartKey) || scanBusy || Boolean(lockBusyKey)} aria-pressed={workScope === scope} onClick={() => { setWorkScope(scope); resetSupervisorFilters(); setScanPlant(null); setScanArea(null); }}>{scope === "production" ? "Production work" : "Test work"}</button>)}</div><button className="handheld-secondary" disabled={Boolean(activeCartKey)} onClick={() => { setLoadDemandInitialTestSession(createClientSessionId()); setLoadDemandOpen(true); }}>Capture test inventory</button></div></details>}
            {localMode ? <p className="handheld-menu-note">Local preview. User authentication is disabled.</p> : <button className="handheld-secondary" disabled={signingOut || scanBusy || loadBusy || receivingBusy} onClick={async () => { setSigningOut(true); try { await releaseCart(); const result = await fetch("/api/auth/logout", { method: "POST" }); if (!result.ok) throw new Error("Sign out failed. Try again."); window.location.assign("/"); } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Sign out failed." }); setSigningOut(false); } }}>{signingOut ? "Signing out…" : "Sign out"}</button>}
          </section> : view === "receive" ? null : view === "inventory" ? <InventoryList revision={inventoryRevision} canManage={canManage} operatorName={operatorName} /> : loading && !state.lines.length ? <div className="loading-state"><span /><strong>Preparing today&apos;s queue</strong></div> : view === "overview" ? renderOverview() : view === "scan" ? renderScan() : view === "load" ? renderLoadConfirm() : view === "import" ? renderImport() : renderDemandMaintenance()}
          {canOperate && <div hidden={view !== "receive" || (simpleHandheld && handheldMenuOpen)}><ReceiveInventory partAttribute={settings.partAttribute} key={`${initialAccess?.principal?.id || "local"}:${dataResetRevision}`} operatorName={operatorName} ownerId={initialAccess?.principal?.id || "local"} active={view === "receive" && !(simpleHandheld && handheldMenuOpen)} onBusyChange={handleReceivingBusy} onDraftChange={setReceivingDirty} onReceived={handleInventoryReceived} /></div>}
        </main>
        {simpleHandheld && <nav className="handheld-bottom" aria-label="Handheld navigation"><button disabled={receivingBusy} aria-current={view === "receive" ? "page" : undefined} onClick={() => void navigateTo("receive")}>Receive</button><button disabled={receivingBusy} aria-current={view === "scan" ? "page" : undefined} onClick={() => void navigateTo("scan")}>Pack</button><button disabled={receivingBusy} aria-current={view === "load" ? "page" : undefined} onClick={() => void navigateTo("load")}>Load</button></nav>}
        {!simpleHandheld && view !== "scan" && <footer><span>PPA operations</span><span>Persistent database · Server-validated scans · Auto-renewing picklist leases</span></footer>}
      </div>

      {confirmation && <ConfirmationDialog confirmation={confirmation} onDecision={(approved) => { confirmationResolver.current?.(approved); confirmationResolver.current = null; setConfirmation(null); }} />}
      {notice && !handheldNoticeIsInline && <div className={`toast toast-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><span>{notice.tone === "success" ? "✓" : notice.tone === "error" ? "!" : "i"}</span>{notice.text}<button className="dismiss-notice" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}

      {testToolsEnabled && loadDemandOpen && <LoadDemandScanner
        initialTestSessionId={loadDemandInitialTestSession}
        operatorName={operatorName}
        onClose={() => setLoadDemandOpen(false)}
        onAdded={async (duplicate) => {
          setWorkScope("test");
          resetSupervisorFilters();
          setScanPlant(null);
          setScanArea(null);
          await refreshState(true);
          if (!duplicate) setNotice({ tone: "success", text: "Physical label saved as inventory. Its separate test demand remains pending until its inventory serial is scanned during packing." });
        }}
      />}

      {cameraOpen && activeTask && (
        <CameraScanner
          mode="serial"
          onClose={() => setCameraOpen(false)}
          onDetectedBatch={(values) => {
            setCameraOpen(false);
            if (values[0]) void submitScan(values[0]);
          }}
        />
      )}

    </>
  );
}
