"use client";

import { useLiveInventory } from "@/app/use-live-inventory";

export function InventoryLiveSummary({ revision, onOpenInventory }: { revision: number; onOpenInventory: () => void }) {
  const { data, error, updatedAt, refresh } = useLiveInventory({ pageSize: 5, revision });
  return <section className="panel inventory-live-panel" aria-labelledby="live-inventory-title">
    <div className="panel-heading">
      <div><p className="eyebrow">Receiving activity</p><h2 id="live-inventory-title">Live inventory</h2></div>
      <span className={`inventory-live-state${error ? " inventory-live-stale" : ""}`} role="status">{error ? "Updates interrupted" : updatedAt ? "Updates automatically" : "Connecting…"}</span>
      <button className="button button-secondary" onClick={onOpenInventory}>View inventory →</button>
    </div>
    {error && <div className="inventory-error" role="alert"><strong>{error}</strong><p>Showing the last confirmed receipts. Retrying automatically.</p><button className="button button-secondary" onClick={refresh}>Retry now</button></div>}
    <div className="inventory-live-content">
      <div className="inventory-live-totals" aria-label="Live available inventory totals" aria-live="polite" aria-atomic="true">
        <div><span>Available containers</span><strong>{data ? data.summary.containers.toLocaleString() : "—"}</strong></div>
        <div><span>Remaining available quantity</span><strong>{data ? Object.entries(data.summary.quantitiesByUnit || { EA: data.summary.units }).map(([unit, quantity]) => `${quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${unit}`).join(" · ") || "0 EA" : "—"}</strong></div>
        <p className="inventory-live-note">Includes unused stock in partially consumed containers.</p>
      </div>
      <div className="inventory-live-receipts"><h3>Latest inventory records</h3>
        {data?.items.length ? <ul>{data.items.map((item) => {
          const consumed = item.consumedQuantity || 0;
          const remaining = item.remainingQuantity ?? Math.max(0, item.quantity - consumed);
          const consumption = consumed <= 0 ? "Not consumed" : remaining > 0 ? "Partially consumed" : "Consumed";
          const stage = item.fulfillmentStage || (item.status === "expected" ? "expected" : consumed > 0 ? remaining > 0 ? "partially_consumed" : "packed" : "available");
          const stageLabel = stage === "available" ? "Received" : stage === "partially_consumed" ? "Partially packed" : stage;
          const loaded = item.loadedQuantity ?? 0;
          const departed = item.dispatchedQuantity ?? 0;
          const awaitingLoad = Math.max(0, consumed - loaded);
          const awaitingDeparture = Math.max(0, loaded - departed);
          const quantity = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${item.unitOfMeasure || "EA"}`;
          return <li key={item.id}>
            <div><strong>{item.serial}</strong><span>{item.partNumber} · {item.color || item.partLevel || item.partMark || "No color"}</span><span className="inventory-live-stage">{stageLabel} · {item.receivedBy}</span></div>
            <div><strong>{quantity(remaining)} remaining</strong><span>Original {quantity(item.quantity)} · Consumed {quantity(consumed)}</span><span>{consumption}</span>
              {awaitingLoad > 0 && <span>{quantity(awaitingLoad)} awaiting loading</span>}
              {awaitingDeparture > 0 && <span>{quantity(awaitingDeparture)} loaded, awaiting departure</span>}
              {departed > 0 && <span>{quantity(departed)} departed</span>}
            </div>
          </li>;
        })}</ul> : <p>{data ? "New containers appear here as operators finish scanning." : "Loading receipts…"}</p>}
      </div>
    </div>
  </section>;
}
