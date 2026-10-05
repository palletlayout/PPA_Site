"use client";

import { useId, useRef, useState } from "react";
import { request } from "@/lib/client-request";
import { partAttributeLabels, validateFulfillmentSettings, type FulfillmentSettings } from "@/lib/fulfillment-settings";
import "./fulfillment-settings.css";

export type FulfillmentSettingsValue = FulfillmentSettings;

type SettingsResponse = { settings?: FulfillmentSettingsValue; error?: string };

export function FulfillmentSettingsPanel({ settings, onSaved, disabled = false }: {
  settings: FulfillmentSettingsValue;
  onSaved: (settings: FulfillmentSettingsValue) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [changes, setChanges] = useState<Partial<FulfillmentSettingsValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busyRef = useRef(false);
  const draft = { ...settings, ...changes };
  const dirty = draft.packingMode !== settings.packingMode || draft.inventoryMode !== settings.inventoryMode;
  const attribute = partAttributeLabels(draft.partAttribute).label.toLowerCase();

  function choose<Key extends keyof FulfillmentSettingsValue>(key: Key, value: FulfillmentSettingsValue[Key]) {
    setChanges((previous) => ({ ...previous, [key]: value }));
    setError("");
    setMessage("");
  }

  async function save() {
    if (busyRef.current || disabled || !dirty) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await request("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json() as SettingsResponse;
      if (!response.ok) throw new Error(result.error || "Fulfillment settings could not be saved.");
      if (!result.settings || !["exact", "multiple"].includes(result.settings.packingMode)
        || !["uploaded", "scan"].includes(result.settings.inventoryMode)) {
        throw new Error("The settings could not be confirmed. Refresh the work queue before trying again.");
      }
      setChanges({});
      setMessage("Fulfillment settings saved.");
      onSaved(validateFulfillmentSettings(result.settings));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Fulfillment settings could not be saved.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <section className="panel fulfillment-settings" aria-labelledby={`${id}-title`}>
    <div className="panel-heading"><div><p className="eyebrow">Supervisor configuration</p><h2 id={`${id}-title`}>Fulfillment settings</h2></div></div>
    <form className="fulfillment-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={busy}>
      <p className="fulfillment-settings-intro">Choose how operators match containers to demand. These settings apply to all packing stations.</p>
      <fieldset disabled={busy || disabled}>
        <legend>Packing option</legend>
        <div className="fulfillment-settings-options">
          <label className={`fulfillment-settings-option${draft.packingMode === "exact" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-packing`} value="exact" checked={draft.packingMode === "exact"} onChange={() => choose("packingMode", "exact")} />
            <span><strong>Option 1 · Exact quantity</strong><small>One whole container fulfills one matching demand line anywhere on the picklist. Part, {attribute} and container quantity must match.</small></span>
          </label>
          <label className={`fulfillment-settings-option${draft.packingMode === "multiple" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-packing`} value="multiple" checked={draft.packingMode === "multiple"} onChange={() => choose("packingMode", "multiple")} />
            <span><strong>Option 2 · Multiple or partial containers</strong><small>Combine containers to fulfill a demand line. Use only the quantity still required and retain unused stock for another line.</small></span>
          </label>
        </div>
      </fieldset>
      <fieldset disabled={busy || disabled}>
        <legend>Inventory verification</legend>
        <div className="fulfillment-settings-options">
          <label className={`fulfillment-settings-option${draft.inventoryMode === "uploaded" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-inventory`} value="uploaded" checked={draft.inventoryMode === "uploaded"} onChange={() => choose("inventoryMode", "uploaded")} />
            <span><strong>Use recorded inventory</strong><small>Scan any container serial. Known inventory is checked against the picklist. For an unknown serial, scan its part, {attribute} and quantity.</small></span>
          </label>
          <label className={`fulfillment-settings-option${draft.inventoryMode === "scan" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-inventory`} value="scan" checked={draft.inventoryMode === "scan"} onChange={() => choose("inventoryMode", "scan")} />
            <span><strong>Scan container labels while packing</strong><small>No inventory upload is required. Start with any container serial, then scan part, {attribute} and quantity if that serial is unknown.</small></span>
          </label>
        </div>
      </fieldset>
      <p className="fulfillment-settings-note">Color is optional. Scan part number, color when present, then quantity. For a label without color, scan quantity directly after part number or choose No color. A blank color must match blank color on the picklist.</p>
      <p className="fulfillment-settings-note">Existing packing work can prevent a change. The current settings remain in place until your change is accepted.</p>
      {error && <p className="fulfillment-settings-error" role="alert">{error}</p>}
      {message && <p className="fulfillment-settings-success" role="status">{message}</p>}
      <div className="fulfillment-settings-actions"><button className="button button-primary" type="submit" disabled={busy || disabled || !dirty}>{busy ? "Saving settings…" : "Save fulfillment settings"}</button>{dirty && <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setChanges({}); setError(""); setMessage(""); }}>Discard changes</button>}</div>
    </form>
  </section>;
}
