"use client";

import { useRef, useState } from "react";
import { InventoryImport } from "@/app/inventory-import";
import { useLiveInventory } from "@/app/use-live-inventory";
import { OperationIcon } from "@/app/operation-icon";
import { ConfirmationDialog } from "@/app/confirmation-dialog";
import { request } from "@/lib/client-request";
import { publishInventoryUpdate } from "@/lib/live-inventory";
import type { InventoryItem } from "@/lib/inventory-types";

export function InventoryList({ revision = 0, canManage = false, operatorName = "" }: { revision?: number; canManage?: boolean; operatorName?: string }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [deleted, setDeleted] = useState(false);
  const [pending, setPending] = useState<{ item: InventoryItem; deleted: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [labelsBusy, setLabelsBusy] = useState(false);
  const labelsBusyRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const { data, loading, error, refresh } = useLiveInventory({ query, page, revision, deleted });

  async function printLabels() {
    if (labelsBusyRef.current) return;
    labelsBusyRef.current = true;
    setLabelsBusy(true); setActionError(""); setActionMessage("");
    try {
      const response = await request("/api/inventory/labels");
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || "Unable to prepare inventory labels. Please try again.");
      }
      const disposition = response.headers.get("content-disposition") || "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
      const filename = encodedName ? decodeURIComponent(encodedName) : quotedName || "ppa-inventory-labels.pdf";
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setActionMessage("Inventory labels are ready to print, with original container quantities and one container per PDF page.");
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Unable to prepare inventory labels. Please try again.");
    } finally {
      labelsBusyRef.current = false;
      setLabelsBusy(false);
    }
  }

  async function changeInventory(approved: boolean) {
    const action = pending;
    setPending(null);
    if (!approved || !action || !canManage || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setActionError(""); setActionMessage("");
    try {
      const response = await request("/api/inventory", {
        method: action.deleted ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: action.item.id, operatorName, confirmation: action.deleted ? "DELETE_INVENTORY" : "RESTORE_INVENTORY" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to change this inventory container.");
      setActionMessage(`Container ${action.item.serial} ${action.deleted ? "deleted. You can restore it from Deleted inventory." : "restored to active inventory."}`);
      setPage(1); refresh(); publishInventoryUpdate();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Unable to change this inventory container.");
      refresh();
    } finally { busyRef.current = false; setBusy(false); }
  }

  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 50)));
  const exportUrl = `/api/inventory/export?${new URLSearchParams({ q: query })}`;
  const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  return <section className="inventory-page">
    <div className="page-heading">
      <div><p className="eyebrow">Inventory records</p><h1>{deleted ? "Deleted inventory" : "Inventory"}</h1><p className="heading-copy">{deleted ? "Deleted containers are excluded from active totals. Restore a container to bring it back." : "Each supplier and serial pair identifies a physical container. Follow expected receipts through available, packed, loaded and dispatched."}</p></div>
      <div className="heading-actions"><span className={`inventory-live-state${error ? " inventory-live-stale" : ""}`}>{error ? "Updates interrupted" : "Updates automatically"}</span><button className="button button-secondary" disabled={loading} onClick={refresh}><OperationIcon name="refresh" />{loading ? "Refreshing…" : "Refresh"}</button>{!deleted && <><button className="button button-secondary" disabled={labelsBusy} aria-busy={labelsBusy} title="All inventory containers, one label per page, with original container quantities" onClick={() => void printLabels()}>{labelsBusy ? "Preparing labels…" : "Print labels"}</button><a className="button button-secondary" href={exportUrl} download>Export inventory ↓</a></>}</div>
    </div>
    {canManage && !deleted && <InventoryImport operatorName={operatorName} onImported={() => { refresh(); publishInventoryUpdate(); }} />}
    {canManage && <div className="inventory-view-switch" role="group" aria-label="Inventory view">{[false, true].map((value) => <button key={String(value)} className="button button-secondary" aria-pressed={deleted === value} disabled={busy} onClick={() => { setDeleted(value); setPage(1); setActionMessage(""); setActionError(""); }}>{value ? "Deleted inventory" : "Active inventory"}</button>)}</div>}
    {actionMessage && <p className="inventory-action-message" role="status">{actionMessage}</p>}
    {actionError && <p className="inventory-error" role="alert">{actionError}</p>}
    <form className="inventory-search" onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}>
      <label htmlFor="inventory-search">Find a container</label><div><input id="inventory-search" type="search" placeholder="Serial, part number, color or pallet ID" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /><button className="button button-primary" type="submit">Search</button>{query && <button className="button button-secondary" type="button" onClick={() => { setSearch(""); setQuery(""); setPage(1); }}>Clear</button>}</div>
    </form>
    {error && <div className="inventory-error" role="alert"><strong>{error}</strong>{data && <p>Showing the last confirmed receipts. Retrying automatically.</p>}<button className="button button-secondary" onClick={refresh}>Try again</button></div>}
    {data && <div className="inventory-summary" aria-label={deleted ? "Deleted inventory totals" : "Inventory available now"}><div><span>{query ? deleted ? "Matching deleted containers" : "Matching available containers" : deleted ? "Deleted containers" : "Available containers"}</span><strong>{data.summary.containers.toLocaleString()}</strong></div><div><span>{query ? deleted ? "Matching deleted quantity" : "Matching remaining quantity" : deleted ? "Deleted quantity" : "Remaining available quantity"}</span><strong>{Object.entries(data.summary.quantitiesByUnit || { EA: data.summary.units }).map(([unit, quantity]) => `${quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${unit}`).join(" · ") || "0 EA"}</strong></div><p>{deleted ? "These containers are excluded from active inventory and dashboard totals." : "Available totals include unused quantity in partially consumed containers. Expected, fully consumed, deleted and test stock is excluded. Original quantities and fulfillment history remain below."}</p></div>}
    <article className="panel inventory-panel" aria-busy={loading}>
      <div className="panel-heading"><h2>Containers and fulfilment</h2><span className="panel-meta" role="status">{loading ? "Loading receipts…" : `${data?.total || 0} ${query ? "matching " : ""}containers`}</span></div>
      {data?.items.length ? <div className="inventory-table-wrap" role="region" aria-label="Received containers" tabIndex={0}>
        <table className={`inventory-table${canManage ? " inventory-table-managed" : ""}`}>
          <caption className="sr-only">{deleted ? "Deleted inventory containers" : "Production containers with original, consumed and remaining quantities"}</caption>
          <thead><tr><th scope="col">Container serial</th><th scope="col">Pallet ID</th><th scope="col">Supplier</th><th scope="col">Stage</th><th scope="col">Part number</th><th scope="col">Color</th><th scope="col">Original qty</th><th scope="col">Consumed qty</th><th scope="col">Remaining qty</th><th scope="col">Consumption status</th><th scope="col">Linked demand IDs</th><th scope="col">Recorded by / source</th><th scope="col">Receipt recorded at</th>{canManage && <th scope="col">Actions</th>}</tr></thead>
          <tbody>{data.items.map((item) => {
            const consumed = item.consumedQuantity || 0;
            const remaining = item.remainingQuantity ?? Math.max(0, item.quantity - consumed);
            const consumption = consumed <= 0 ? "not-consumed" : remaining > 0 ? "partial" : "consumed";
            const consumptionLabel = consumption === "not-consumed" ? "Not consumed" : consumption === "partial" ? "Partially consumed" : "Consumed";
            const stage = item.fulfillmentStage || (item.status === "expected" ? "expected" : consumed > 0 ? remaining > 0 ? "partially_consumed" : "packed" : "available");
            const stageLabel = stage === "available" ? "Received" : stage === "partially_consumed" ? "Partially packed" : stage;
            const loaded = item.loadedQuantity ?? 0;
            const departed = item.dispatchedQuantity ?? 0;
            const awaitingLoad = Math.max(0, consumed - loaded);
            const awaitingDeparture = Math.max(0, loaded - departed);
            const demandIds = item.fulfilledDemandIds || (item.fulfilledDemandId ? [item.fulfilledDemandId] : []);
            const quantity = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${item.unitOfMeasure || "EA"}`;
            return <tr key={item.id}>
              <td><strong>{item.serial}</strong></td><td>{item.palletId || "—"}</td><td>{item.supplierId || "—"}</td>
              <td><span className={`inventory-stage inventory-stage-${stage}`}>{stageLabel}</span>
                {awaitingLoad > 0 && <span className="inventory-milestone">{quantity(awaitingLoad)} awaiting loading</span>}
                {awaitingDeparture > 0 && <span className="inventory-milestone">{quantity(awaitingDeparture)} loaded, awaiting departure</span>}
                {departed > 0 && <span className="inventory-milestone">{quantity(departed)} departed</span>}
                {item.loadedAt && <span className="inventory-milestone">Fully loaded <time dateTime={item.loadedAt}>{formatTime(item.loadedAt)}</time></span>}
                {item.dispatchedAt && <span className="inventory-milestone">Fully departed <time dateTime={item.dispatchedAt}>{formatTime(item.dispatchedAt)}</time></span>}
              </td>
              <td>{item.partNumber}</td><td>{item.color || item.partMark || "No color"}</td>
              <td className="inventory-quantity">{quantity(item.quantity)}</td><td className="inventory-quantity">{quantity(consumed)}</td><td className="inventory-quantity inventory-remaining">{quantity(remaining)}</td>
              <td><span className={`inventory-consumption inventory-consumption-${consumption}`}>{consumptionLabel}</span></td>
              <td className="inventory-demand-links">{demandIds.length ? demandIds.map((demandId) => <span key={demandId}>{demandId}</span>) : "—"}</td><td>{item.receivedBy}<span className="inventory-milestone">{item.acquisitionMethod === "spreadsheet_import" ? "Spreadsheet import" : item.acquisitionMethod === "scanner_capture" ? "Label capture" : item.acquisitionMethod === "explicit_confirmation" ? "Receipt confirmation" : "Legacy source unknown"}</span>{item.sourceFile && <span className="inventory-milestone">{item.sourceFile}{item.sourceRow ? ` · row ${item.sourceRow}` : ""}</span>}</td>
              <td>{item.receivedAt ? <time dateTime={item.receivedAt}>{formatTime(item.receivedAt)}</time> : "Receipt pending"}</td>
              {canManage && <td><button className={`text-button${deleted ? "" : " text-danger"}`} disabled={busy || loading || (!deleted && (item.status !== "available" || consumed > 0))} title={item.status === "expected" ? "Expected stock must be received before inventory deletion is available." : consumed > 0 ? "Consumed inventory is retained with its linked demand records." : undefined} aria-label={`${deleted ? "Restore" : "Delete"} container ${item.serial}`} onClick={() => setPending({ item, deleted: !deleted })}>{deleted ? "Restore" : "Delete"}</button></td>}
            </tr>;
          })}</tbody>
        </table>
      </div> : !loading && !error && <div className="inventory-empty"><h2>{query ? "No matching containers" : deleted ? "No deleted inventory" : "No inventory recorded yet"}</h2><p>{query ? "Try another serial, part number, color or pallet ID." : deleted ? "Deleted containers will appear here for restoration." : "Use Receive on a handheld to scan a container’s serial, part, optional color, and quantity."}</p></div>}
      {data && data.total > 0 && <div className="inventory-pagination"><span>Page {data.page} of {pages}</span><div><button className="button button-secondary" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="button button-secondary" disabled={loading || page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
    </article>
    {pending && <ConfirmationDialog confirmation={{ title: pending.deleted ? "Delete inventory container?" : "Restore inventory container?",
      confirmLabel: pending.deleted ? "Delete inventory" : "Restore inventory", destructive: pending.deleted,
      message: pending.deleted ? `Delete ${pending.item.serial} (${pending.item.quantity} ${pending.item.unitOfMeasure || "EA"} of ${pending.item.partNumber}) from active inventory? It will leave the live totals and can be restored from Deleted inventory.`
        : `Restore ${pending.item.serial} (${pending.item.quantity} ${pending.item.unitOfMeasure || "EA"}) to active inventory and the live totals?`,
    }} onDecision={(approved) => void changeInventory(approved)} />}
  </section>;
}
