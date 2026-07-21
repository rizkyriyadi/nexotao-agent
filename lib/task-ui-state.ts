export type RemoteState = "loading" | "online" | "disconnected" | "error";
export type BoardSurface = "loading" | "empty" | "ready" | "error" | "disconnected";

export function boardSurface(state: RemoteState, visibleItems: number): BoardSurface {
  if (state === "loading") return "loading";
  if (state === "error") return "error";
  if (state === "disconnected") return visibleItems > 0 ? "disconnected" : "error";
  return visibleItems > 0 ? "ready" : "empty";
}

export function detailSurface(state: RemoteState, hasCanonicalState: boolean) {
  if (state === "loading") return "loading";
  if (!hasCanonicalState) return "error";
  return state === "disconnected" ? "disconnected" : "ready";
}
