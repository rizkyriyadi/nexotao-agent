"use client";

import { useEffect, useState } from "react";

export type ModelOption = { id: string; name: string; ctx: number | null; tier: string; provider: string };

// The catalog is the same for every composer on every page and changes about as
// often as Nexotao ships a model, so it is fetched once per page load and shared
// — mounting a second composer must not cost a second round-trip.
let inflight: Promise<ModelOption[]> | undefined;

function loadModels(): Promise<ModelOption[]> {
  inflight ??= fetch("/api/models")
    .then((r) => r.json())
    .then((d) => (Array.isArray(d?.models) ? (d.models as ModelOption[]) : []))
    .catch(() => {
      // Don't cache a failure: the next mount should be free to try again.
      inflight = undefined;
      return [];
    });
  return inflight;
}

/** The models this app can run, or an empty list while loading / if the gateway
 *  is unreachable. An empty list hides the picker rather than blocking the
 *  composer — the run then uses the configured default, exactly as before. */
export function useModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let alive = true;
    loadModels().then((list) => { if (alive) setModels(list); });
    return () => { alive = false; };
  }, []);
  return models;
}
