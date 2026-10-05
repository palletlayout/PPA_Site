"use client";

import { useRef, useState } from "react";
import { parseInventorySpreadsheet, type InventoryImportRow } from "@/lib/inventory-import";
import { request } from "@/lib/client-request";
import { publishInventoryUpdate } from "@/lib/live-inventory";

type PendingImport = { id: string; name: string; rows: InventoryImportRow[]; offset: number; receiptKind: "received" | "expected" };

export function InventoryImport({ operatorName, onImported }: { operatorName: string; onImported?: () => void }) {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [receiptKind, setReceiptKind] = useState<"received" | "expected">("received");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);

  async function importRows(initial: PendingImport) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    let current = initial;
    try {
      while (current.offset < current.rows.length) {
        setMessage(`${current.receiptKind === "expected" ? "Registering expected" : "Receiving"} ${current.offset} of ${current.rows.length} containers…`);
        const response = await request("/api/inventory/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ importId: current.id, fileName: current.name, receiptKind: current.receiptKind, startRow: current.offset,
            rows: current.rows.slice(current.offset, current.offset + 10), operatorName }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`${result.rowNumber ? `Row ${result.rowNumber}: ` : ""}${result.error || "Unable to receive inventory."} Earlier rows are saved. Retrying will not duplicate them.`);
        current = { ...current, offset: Math.min(current.rows.length, current.offset + 10) };
        setPending(current);
        publishInventoryUpdate();
        onImported?.();
      }
      setMessage(`${current.name}: ${current.rows.length} containers ${current.receiptKind === "expected" ? "registered as expected; confirm physical receipt before packing" : "imported; rows marked expected still require physical receipt"}. Check each container’s stage in inventory. Existing supplier/serial pairs were kept once.`);
      setPending(null);
    } catch (cause) {
      setPending(current);
      setError(cause instanceof Error ? cause.message : "Import stopped. Retry to confirm saved inventory.");
      setMessage(`${current.offset} of ${current.rows.length} rows confirmed.`);
      publishInventoryUpdate();
      onImported?.();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function selectFile(file?: File) {
    if (!file || running.current) return;
    setBusy(true);
    setError("");
    setMessage("Checking inventory file…");
    try {
      const rows = await parseInventorySpreadsheet(await file.arrayBuffer(), file.name);
      const next = { id: crypto.randomUUID(), name: file.name, rows, offset: 0, receiptKind };
      setPending(next);
      await importRows(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read this inventory file.");
      setMessage("");
    } finally { setBusy(false); if (input.current) input.current.value = ""; }
  }

  return <section className="inventory-import" aria-label="Import inventory">
    <label className="inventory-receipt-kind">Inventory in this file<select value={receiptKind} disabled={busy || Boolean(pending)} onChange={(event) => setReceiptKind(event.target.value as "received" | "expected")}><option value="received">Physically received and available</option><option value="expected">Expected from supplier; receipt pending</option></select></label>
    <div className="toolbar-actions">
      <button type="button" className="button secondary" disabled={busy || !operatorName.trim()} onClick={() => input.current?.click()}>
        {busy ? "Importing inventory…" : "Upload inventory"}
      </button>
      <a className="button secondary" href="/ppa-demo-inventory.csv" download>Example inventory</a>
      {pending && !busy && <button type="button" className="button secondary" onClick={() => void importRows(pending)}>Retry import</button>}
      <input ref={input} type="file" accept=".csv,.xlsx,.xls" hidden onChange={(event) => void selectFile(event.target.files?.[0])} />
    </div>
    <p>Upload part, color, quantity, unit of measure, supplier ID, pallet ID and serial number from Excel or CSV. Color, supplier and pallet ID may be blank. Store pallet IDs as text to keep leading zeroes. Pallet ID records the file’s pallet reference. Quantity uses EA when no unit is supplied. Expected containers stay unavailable until physical receipt is confirmed. Use the example inventory with the example demand.</p>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </section>;
}
