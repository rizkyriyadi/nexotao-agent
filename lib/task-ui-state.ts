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

/**
 * Classifies an issue's dependencies from its blockers' statuses.
 *
 * A blocker stays "open" until it reaches `done` — this mirrors the lifecycle's
 * `hasUnmetBlockers` rule (status !== "done"), so the UI's blocked signal always
 * agrees with when the server actually holds an issue in the `blocked` state.
 */
export type DependencyState = { total: number; open: number; resolved: number; isBlocked: boolean };

export function dependencyState(blockerStatuses: string[]): DependencyState {
  const total = blockerStatuses.length;
  const open = blockerStatuses.filter((status) => status !== "done").length;
  return { total, open, resolved: total - open, isBlocked: open > 0 };
}
