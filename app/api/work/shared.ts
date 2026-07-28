/* Shared plumbing for the /api/work routes: error mapping, project resolution,
   and parsing a view config out of a query string.

   Not a route file — Next only treats `route.ts` as an endpoint, so a plain
   module beside them is fine. */
import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { HttpError, jsonError } from "@/lib/http";
import { IssueDomainError } from "@/lib/issue-lifecycle";
import type { Filters, GroupBy, Layout, OrderBy, ViewConfig } from "@/lib/work-view";

/** One mapping for both error families so every work route answers alike.
 *  `not_found` is a 404, `forbidden` a 403, and everything else a 409: the
 *  remaining domain codes all mean "the request was well-formed but the state
 *  says no", which is a conflict rather than a validation failure. */
export function workError(error: unknown) {
  if (error instanceof IssueDomainError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "validation" ? 400 : 409;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return jsonError(error);
}

/** The project a work request applies to. Every table in the work model is
 *  project-scoped, so a request with no active project has nothing to act on. */
export async function requireProject() {
  const project = await getActiveProject();
  if (!project) throw new HttpError("No active project", 400);
  return project;
}

const LAYOUTS: Layout[] = ["list", "board", "spreadsheet", "calendar", "gantt"];
const GROUP_BYS: GroupBy[] = ["state", "priority", "assignee", "label", "cycle", "module", "none"];
const ORDER_BYS: OrderBy[] = ["manual", "priority", "updated", "created", "target_date"];

/* Repeated params are the OR inside one filter key (`?priority=high&priority=low`),
   which is what a URLSearchParams-based UI produces naturally. The literal
   "none" selects work with no value at all — unassigned, unscheduled — because a
   query string cannot carry a real null. */
const list = (params: URLSearchParams, key: string) => params.getAll(key).filter(Boolean);
const nullable = (params: URLSearchParams, key: string) =>
  list(params, key).map((value) => (value === "none" ? null : value));
const number = (params: URLSearchParams, key: string) => {
  const raw = params.get(key);
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseFilters(params: URLSearchParams): Filters {
  return {
    ...(params.get("search") ? { search: params.get("search")! } : {}),
    stateIds: list(params, "stateId"), statuses: list(params, "status"),
    priorities: list(params, "priority"), labelIds: list(params, "labelId"),
    moduleIds: list(params, "moduleId"), assigneeIds: nullable(params, "assigneeId"),
    cycleIds: nullable(params, "cycleId"), intakeStatuses: nullable(params, "intakeStatus"),
    targetDateFrom: number(params, "targetDateFrom"), targetDateTo: number(params, "targetDateTo"),
  };
}

/** An unrecognised layout/grouping falls back to the default rather than 400ing:
 *  these come from a URL a user can edit or a saved view written by an older
 *  build, and a board that renders beats an error page. */
export function parseViewConfig(params: URLSearchParams): ViewConfig {
  const pick = <T extends string>(key: string, allowed: T[], fallback: T): T => {
    const value = params.get(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  };
  return {
    layout: pick("layout", LAYOUTS, "board"),
    groupBy: pick("groupBy", GROUP_BYS, "state"),
    orderBy: pick("orderBy", ORDER_BYS, "manual"),
    filters: parseFilters(params),
  };
}
