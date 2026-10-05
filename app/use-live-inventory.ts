"use client";

import { useEffect, useState } from "react";
import { request } from "@/lib/client-request";
import { subscribeInventoryUpdates } from "@/lib/live-inventory";
import type { InventoryListResult } from "@/lib/inventory-types";

export function useLiveInventory({ query = "", page = 1, pageSize = 50, revision = 0, deleted = false } = {}) {
  const [data, setData] = useState<InventoryListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async (initial = false) => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      if (initial) setLoading(true);
      try {
        if (!navigator.onLine) throw new Error("Connection interrupted. Inventory updates will resume when you reconnect.");
        const params = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize) });
        if (deleted) params.set("status", "deleted");
        const response = await request(`/api/inventory?${params}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to update received inventory.");
        if (!controller.signal.aborted) {
          setData(payload as InventoryListResult);
          setUpdatedAt(new Date().toISOString());
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to update received inventory.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load(true);
    const unsubscribe = subscribeInventoryUpdates(() => void load());
    return () => { unsubscribe(); controller.abort(); };
  }, [query, page, pageSize, revision, refresh, deleted]);

  return { data, loading, error, updatedAt, refresh: () => setRefresh((value) => value + 1) };
}
