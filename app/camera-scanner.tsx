"use client";

import { useEffect, useRef, useState } from "react";
import { captureLabelBarcode, sameLabelBarcode } from "@/lib/label-capture";
import { announceScan } from "@/lib/scan-audio";
import {
  DEMAND_SCAN_LABELS,
  DEMAND_SCAN_PREFIXES,
  detectDemandBarcode,
  type DemandScanField,
} from "@/lib/scan-values";

type CameraScannerProps = {
  initialValues?: Partial<Record<DemandScanField, string>>;
  mode?: "capture" | "serial";
  onClose: () => void;
  onDetectedBatch: (values: string[]) => void;
};

type SourceBox = { x: number; y: number; width: number; height: number };
type TrackedBox = SourceBox & { field: DemandScanField; rawValue: string; lastSeen: number };
type CameraRead = { rawValue: string; box: SourceBox };
type DetectorBarcode = {
  rawValue: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
};
type DetectorConstructor = new () => { detect: (source: HTMLVideoElement) => Promise<DetectorBarcode[]> };

const CAMERA_FIELD_ORDER: DemandScanField[] = ["partNumber", "color", "quantity", "aiagSerial"];
const FALLBACK_REGIONS = [
  { x: 0, y: 0, width: 1, height: 0.35 },
  { x: 0, y: 0.2, width: 0.62, height: 0.48 },
  { x: 0.38, y: 0.2, width: 0.62, height: 0.48 },
  { x: 0, y: 0.55, width: 1, height: 0.45 },
] as const;

function cameraMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Camera permission was denied. Allow camera access in your browser settings, then try again.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No camera was found on this device.";
  }
  return "The camera could not be started. Close this window and try again.";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fallbackBox(
  resultPoints: Array<{ getX: () => number; getY: () => number }>,
  region: (typeof FALLBACK_REGIONS)[number],
  canvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
): SourceBox {
  if (!resultPoints.length) {
    return {
      x: region.x * sourceWidth,
      y: region.y * sourceHeight,
      width: region.width * sourceWidth,
      height: region.height * sourceHeight,
    };
  }
  const xs = resultPoints.map((point) => point.getX());
  const ys = resultPoints.map((point) => point.getY());
  const scaleX = region.width * sourceWidth / canvas.width;
  const scaleY = region.height * sourceHeight / canvas.height;
  const x = region.x * sourceWidth + Math.min(...xs) * scaleX;
  const centerY = region.y * sourceHeight + (ys.reduce((sum, value) => sum + value, 0) / ys.length) * scaleY;
  const width = Math.max((Math.max(...xs) - Math.min(...xs)) * scaleX, region.width * sourceWidth * 0.25);
  const height = Math.max(sourceHeight * 0.07, region.height * sourceHeight * 0.24);
  return { x, y: centerY - height / 2, width, height };
}

export function CameraScanner({ initialValues = {}, mode = "capture", onClose, onDetectedBatch }: CameraScannerProps) {
  const cameraFields = mode === "serial" ? ["aiagSerial"] as const : CAMERA_FIELD_ORDER;
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const onDetectedBatchRef = useRef(onDetectedBatch);
  const initialValuesRef = useRef(initialValues);
  const cameraFieldsRef = useRef<readonly DemandScanField[]>(cameraFields);
  const collectedRef = useRef<Partial<Record<DemandScanField, string>>>({ ...initialValues });
  const candidatesRef = useRef<Partial<Record<DemandScanField, { value: string; count: number; seenAt: number }>>>({});
  const trackedBoxesRef = useRef<Partial<Record<DemandScanField, TrackedBox>>>({});
  const completedRef = useRef(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [decodeIssue, setDecodeIssue] = useState("");
  const [engine, setEngine] = useState<"multi" | "fallback" | "">("");
  const [collected, setCollected] = useState<Partial<Record<DemandScanField, string>>>({ ...initialValues });
  const [trackedBoxes, setTrackedBoxes] = useState<TrackedBox[]>([]);
  const [videoSize, setVideoSize] = useState({ sourceWidth: 1, sourceHeight: 1, viewportWidth: 1, viewportHeight: 1 });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
    onDetectedBatchRef.current = onDetectedBatch;
  }, [onClose, onDetectedBatch]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const videoElement = videoRef.current;
    let cancelled = false;
    let frameId = 0;
    let stream: MediaStream | null = null;
    let lastScanAt = 0;
    let scanRunning = false;
    let noResultTimer: number | null = null;
    let completionTimer: number | null = null;

    const updateVideoSize = () => {
      const video = videoRef.current;
      if (!video) return;
      setVideoSize({
        sourceWidth: Math.max(1, video.videoWidth),
        sourceHeight: Math.max(1, video.videoHeight),
        viewportWidth: Math.max(1, video.clientWidth),
        viewportHeight: Math.max(1, video.clientHeight),
      });
    };

    const processReads = (reads: CameraRead[]) => {
      if (cancelled || completedRef.current || !videoRef.current) return;
      const now = Date.now();
      const frameFields = new Set<DemandScanField>();

      reads.forEach((read) => {
        const detected = detectDemandBarcode(read.rawValue);
        if (!detected?.value || !cameraFieldsRef.current.includes(detected.field) || frameFields.has(detected.field)
          || captureLabelBarcode({}, read.rawValue).status !== "accepted") return;
        frameFields.add(detected.field);
        const previousBox = trackedBoxesRef.current[detected.field];
        const existing = collectedRef.current[detected.field];
        if (existing && sameLabelBarcode(existing, read.rawValue) && (!previousBox || now - previousBox.lastSeen > 1000)) {
          announceScan("duplicate");
        }
        trackedBoxesRef.current[detected.field] = {
          ...read.box,
          field: detected.field,
          rawValue: read.rawValue,
          lastSeen: now,
        };

        if (collectedRef.current[detected.field]) return;
        const candidate = candidatesRef.current[detected.field];
        const count = candidate && sameLabelBarcode(candidate.value, read.rawValue) && now - candidate.seenAt < 1800 ? candidate.count + 1 : 1;
        candidatesRef.current[detected.field] = { value: read.rawValue, count, seenAt: now };
        if (count >= 2) {
          collectedRef.current[detected.field] = read.rawValue;
          announceScan(detected.field);
        }
      });

      Object.entries(trackedBoxesRef.current).forEach(([field, box]) => {
        if (box && now - box.lastSeen > 900) delete trackedBoxesRef.current[field as DemandScanField];
      });
      setTrackedBoxes(Object.values(trackedBoxesRef.current).filter((box): box is TrackedBox => Boolean(box)));
      setCollected({ ...collectedRef.current });

      const complete = cameraFieldsRef.current.every((field) => Boolean(collectedRef.current[field]));
      if (!complete) return;
      completedRef.current = true;
      setSubmitting(true);
      setDecodeIssue("");
      const newValues = cameraFieldsRef.current
        .filter((field) => !initialValuesRef.current[field])
        .map((field) => collectedRef.current[field])
        .filter((value): value is string => Boolean(value));
      completionTimer = window.setTimeout(() => onDetectedBatchRef.current(newValues), 500);
    };

    const scanWithNativeDetector = async (Detector: DetectorConstructor, video: HTMLVideoElement) => {
      const detector = new Detector();
      setEngine("multi");
      const scanFrame = async (time: number) => {
        if (cancelled || completedRef.current) return;
        frameId = window.requestAnimationFrame(scanFrame);
        if (scanRunning || time - lastScanAt < 120 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        scanRunning = true;
        lastScanAt = time;
        try {
          const barcodes = await detector.detect(video);
          processReads(barcodes
            .filter((barcode) => barcode.rawValue && barcode.boundingBox)
            .map((barcode) => ({ rawValue: barcode.rawValue, box: barcode.boundingBox! })));
        } catch {
          // Individual frames can fail while the camera is moving.
        } finally {
          scanRunning = false;
        }
      };
      frameId = window.requestAnimationFrame(scanFrame);
    };

    const scanWithZxingFallback = async (video: HTMLVideoElement) => {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      setEngine("fallback");
      const canvases = FALLBACK_REGIONS.map(() => document.createElement("canvas"));
      const scanFrame = async (time: number) => {
        if (cancelled || completedRef.current) return;
        frameId = window.requestAnimationFrame(scanFrame);
        if (scanRunning || time - lastScanAt < 240 || !video.videoWidth || !video.videoHeight) return;
        scanRunning = true;
        lastScanAt = time;
        try {
          const reads: CameraRead[] = [];
          for (let index = 0; index < FALLBACK_REGIONS.length; index += 1) {
            const region = FALLBACK_REGIONS[index];
            const canvas = canvases[index];
            const sourceWidth = video.videoWidth;
            const sourceHeight = video.videoHeight;
            const cropWidth = Math.max(1, Math.round(sourceWidth * region.width));
            const cropHeight = Math.max(1, Math.round(sourceHeight * region.height));
            const outputWidth = Math.min(1280, cropWidth);
            const outputHeight = Math.max(1, Math.round(cropHeight * outputWidth / cropWidth));
            canvas.width = outputWidth;
            canvas.height = outputHeight;
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) continue;
            context.drawImage(
              video,
              region.x * sourceWidth,
              region.y * sourceHeight,
              cropWidth,
              cropHeight,
              0,
              0,
              outputWidth,
              outputHeight,
            );
            try {
              const result = reader.decodeFromCanvas(canvas);
              reads.push({
                rawValue: result.getText(),
                box: fallbackBox(result.getResultPoints(), region, canvas, sourceWidth, sourceHeight),
              });
            } catch {
              // This tile did not contain a readable barcode in the current frame.
            }
          }
          processReads(reads);
        } finally {
          scanRunning = false;
        }
      };
      frameId = window.requestAnimationFrame(scanFrame);
    };

    const start = async () => {
      if (!window.isSecureContext) {
        setError("Phone camera access requires HTTPS. A plain http:// local-network address cannot use the camera.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !videoElement) {
        setError("This browser does not provide camera access. Use current Safari or Chrome, or connect a barcode scanner.");
        return;
      }

      try {
        const acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            height: { ideal: 1080 },
            width: { ideal: 1920 },
          },
        });
        if (cancelled) {
          acquiredStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquiredStream;
        const video = videoElement;
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;
        updateVideoSize();
        video.addEventListener("resize", updateVideoSize);
        window.addEventListener("resize", updateVideoSize);
        setReady(true);
        const Detector = (window as typeof window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
        if (Detector) await scanWithNativeDetector(Detector, video);
        else await scanWithZxingFallback(video);
        noResultTimer = window.setTimeout(() => {
          if (!cancelled && !Object.keys(collectedRef.current).length) {
            setDecodeIssue("No label barcodes tracked yet. Fill the frame with the complete label, reduce glare, and hold still.");
          }
        }, 3500);
      } catch (cameraError) {
        if (!cancelled) setError(cameraMessage(cameraError));
      }
    };

    void start();
    return () => {
      const video = videoElement;
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      if (noResultTimer !== null) window.clearTimeout(noResultTimer);
      if (completionTimer !== null) window.clearTimeout(completionTimer);
      video?.removeEventListener("resize", updateVideoSize);
      window.removeEventListener("resize", updateVideoSize);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, []);

  const foundCount = cameraFields.filter((field) => Boolean(collected[field])).length;

  return (
    <div className="camera-backdrop" role="presentation">
      <section ref={dialogRef} className="camera-dialog camera-multi-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-title">
        <div className="camera-heading">
          <div>
            <p className="eyebrow">{mode === "serial" ? "Inventory lookup" : "Physical label intake"}</p>
            <h2 id="camera-title">{mode === "serial" ? "Scan container serial" : "Capture inventory label"}</h2>
          </div>
          <button ref={closeButtonRef} className="camera-close" onClick={onClose} aria-label="Close camera scanner">×</button>
        </div>

        {error ? (
          <div className="camera-error" role="alert">
            <span>!</span>
            <div><strong>Camera unavailable</strong><p>{error}</p></div>
          </div>
        ) : (
          <>
            <div className="camera-viewfinder camera-multi-viewfinder">
              <video ref={videoRef} muted playsInline aria-label="Live camera view with tracked barcode outlines" />
              <span className="camera-label-target" aria-hidden="true" />
              <div className="camera-tracking-layer" aria-hidden="true">
                {trackedBoxes.map((box) => {
                  const scale = Math.min(videoSize.viewportWidth / videoSize.sourceWidth, videoSize.viewportHeight / videoSize.sourceHeight);
                  const renderedWidth = videoSize.sourceWidth * scale;
                  const renderedHeight = videoSize.sourceHeight * scale;
                  const offsetX = (videoSize.viewportWidth - renderedWidth) / 2;
                  const offsetY = (videoSize.viewportHeight - renderedHeight) / 2;
                  const left = clamp(((box.x * scale + offsetX) / videoSize.viewportWidth) * 100, 0, 100);
                  const top = clamp(((box.y * scale + offsetY) / videoSize.viewportHeight) * 100, 0, 100);
                  const viewport = {
                    left,
                    top,
                    width: clamp((box.width * scale / videoSize.viewportWidth) * 100, 4, 100 - left),
                    height: clamp((box.height * scale / videoSize.viewportHeight) * 100, 4, 100 - top),
                  };
                  return (
                    <span
                      className="camera-barcode-box"
                      key={box.field}
                      style={{ left: `${viewport.left}%`, top: `${viewport.top}%`, width: `${viewport.width}%`, height: `${viewport.height}%` }}
                    >
                      <b>✓ {DEMAND_SCAN_PREFIXES[box.field]}</b>
                    </span>
                  );
                })}
              </div>
              <p className={decodeIssue ? "camera-status-error" : submitting ? "camera-status-complete" : ""} role="status" aria-live="polite">
                {!ready
                  ? "Starting camera…"
                  : submitting
                    ? mode === "serial" ? "Serial captured · checking inventory…" : "Label captured · ready to receive…"
                    : decodeIssue || `${foundCount} of ${cameraFields.length} collected · ${mode === "serial" ? "Hold the 1S serial barcode steady" : "Hold the full label steady"}`}
              </p>
            </div>

            <div className="camera-capture-strip" aria-label={`${foundCount} of ${cameraFields.length} barcodes collected`}>
              {cameraFields.map((field) => (
                <span className={collected[field] ? "camera-capture-done" : ""} key={field}>
                  <b>{collected[field] ? "✓" : DEMAND_SCAN_PREFIXES[field]}</b>
                  <small>{DEMAND_SCAN_LABELS[field]}</small>
                </span>
              ))}
            </div>
          </>
        )}

        <div className="camera-help camera-multi-help">
          <span className="camera-help-mark">⌁</span>
          <p>{mode === "serial" ? <><strong>Show the 1S serial barcode.</strong> PPA checks that serial against inventory and fulfills the displayed demand only when part, color, and quantity match.</> : <><strong>Show the complete label.</strong> Green outlines follow each recognized barcode. Capture part (P), optional color (C or 2P), quantity (Q), and serial (1S). Choose No color if the label has none{engine === "fallback" ? "; move slowly while fallback tracking collects each row" : ""}.</>}</p>
        </div>
        {mode === "capture" && !collected.color && <button className="button button-secondary button-full" disabled={!ready || submitting} onClick={() => {
          collectedRef.current.color = "C";
          setCollected({ ...collectedRef.current });
        }}>No color</button>}
        <button className="button button-secondary button-full" onClick={onClose} disabled={submitting}>Cancel camera scan</button>
      </section>
    </div>
  );
}
