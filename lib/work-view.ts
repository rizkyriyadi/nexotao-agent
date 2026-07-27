/* Pure view logic for the work surface: which column a card belongs in, then
   filtering, grouping, ordering, and the fractional index a drag-reorder writes.

   This module has no runtime imports at all — the two type imports are erased at
   compile time. That is deliberate: the API routes and the client layouts both
   call these functions, so a single `import` of the database here would drag
   sql.js into the browser bundle and let the two surfaces disagree about what
   the board shows. Keep it that way. */

import type { Issue, IssueStatus } from "./issues";
import type { Cycle, Label, Module, WorkflowState } from "./work-model";

/* Every project gets these five board columns, and every issue is placed in the
   column matching its current status.

   `blocked` and `cancelled` have no column of their own: blocked work still
   belongs under Todo (it is waiting, not elsewhere) and cancelled work under
   Done (it is finished, just not successfully). Their `status` is untouched —
   only the column they render in is decided here. */
export const DEFAULT_WORKFLOW_STATES = [
  { key: "backlog", name: "Backlog", group: "backlog", color: "#94a3b8", position: 1 },
  { key: "todo", name: "Todo", group: "todo", color: "#6366f1", position: 2 },
  { key: "in_progress", name: "In Progress", group: "in_progress", color: "#f59e0b", position: 3 },
  { key: "in_review", name: "In Review", group: "in_review", color: "#8b5cf6", position: 4 },
  { key: "done", name: "Done", group: "done", color: "#10b981", position: 5 },
] as const;

/** Which default column an existing status renders in. */
export const STATUS_TO_DEFAULT_STATE: Record<string, string> = {
  backlog: "backlog", todo: "todo", blocked: "todo", in_progress: "in_progress",
  in_review: "in_review", done: "done", cancelled: "done",
};

/** Deterministic id so the seed is idempotent across re-runs and re-installs. */
export const defaultStateId = (projectId: string, key: string) => `${projectId}:state:${key}`;

/** Which column an issue actually belongs in.
 *
 *  The lifecycle changes `status` on its own — checkout moves work to
 *  `in_progress`, `wakeDependents` promotes `blocked → todo`, a run finishes into
 *  `done` — and none of those paths know about board columns. Reconciling here
 *  instead of writing `stateId` from inside the lifecycle keeps the engine free of
 *  presentation concerns and means the board can never show a column that
 *  contradicts the status: a stored column is honoured only while its group still
 *  matches, so a user's custom "Code Review" column survives, but a stale one is
 *  replaced by the default column for the current status. */
export function resolveStateId(issue: { status: string; stateId: string | null; projectId: string }, states: WorkflowState[]): string | null {
  const stored = issue.stateId ? states.find((state) => state.id === issue.stateId) : undefined;
  if (stored && stored.statusGroup === issue.status) return stored.id;
  const key = STATUS_TO_DEFAULT_STATE[issue.status];
  const fallback = states.find((state) => state.id === defaultStateId(issue.projectId, key))
    ?? states.find((state) => state.statusGroup === issue.status);
  return fallback?.id ?? stored?.id ?? null;
}

export type Layout = "list" | "board" | "spreadsheet" | "calendar" | "gantt";
export type GroupBy = "state" | "priority" | "assignee" | "label" | "cycle" | "module" | "none";
export type OrderBy = "manual" | "priority" | "updated" | "created" | "target_date";

/** Highest first. `urgent` and `none` are not written by anything yet; they are
 *  here so a card that acquires one still sorts sensibly rather than falling to
 *  the bottom as an unknown value. */
export const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_RANK: Record<string, number> = Object.fromEntries(PRIORITY_ORDER.map((name, index) => [name, index]));
const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444", high: "#f97316", medium: "#eab308", low: "#64748b", none: "#94a3b8",
};
const priorityRank = (priority: string) => PRIORITY_RANK[priority] ?? PRIORITY_ORDER.length;

/** The fields the view engine reads. `Issue` satisfies it structurally, so
 *  callers pass issues straight through while tests can build small literals. */
export type ViewIssue = Pick<Issue,
  | "id" | "projectId" | "ref" | "title" | "detail" | "status" | "priority" | "parentId"
  | "assigneeAgentId" | "stateId" | "cycleId" | "moduleIds" | "labelIds"
  | "estimatePoint" | "startDate" | "targetDate" | "sequence" | "intakeStatus"
  | "createdAt" | "updatedAt">;

/* Every key is an AND against the others; the values inside one key are an OR.
   An absent or empty key is no constraint at all — that is what lets the UI send
   a partially-filled filter object without special-casing each field. `null`
   inside `assigneeIds` / `cycleIds` selects the unassigned/unscheduled work. */
export type Filters = {
  search?: string;
  stateIds?: string[];
  statuses?: string[];
  priorities?: string[];
  assigneeIds?: Array<string | null>;
  labelIds?: string[];
  cycleIds?: Array<string | null>;
  moduleIds?: string[];
  intakeStatuses?: Array<string | null>;
  targetDateFrom?: number | null;
  targetDateTo?: number | null;
};

export type ViewConfig = { layout: Layout; groupBy: GroupBy; orderBy: OrderBy; filters: Filters };
export const DEFAULT_VIEW_CONFIG: ViewConfig = { layout: "board", groupBy: "state", orderBy: "manual", filters: {} };

/** What grouping needs to name and colour its columns. Every list is optional so
 *  a caller that only groups by priority need not load labels and cycles. */
export type ViewContext = {
  states?: WorkflowState[];
  labels?: Label[];
  cycles?: Cycle[];
  modules?: Module[];
  agents?: Array<{ id: string; name: string }>;
};

export type IssueGroup = { key: string; label: string; color: string | null; issues: ViewIssue[] };
export type ViewModel = { config: ViewConfig; total: number; groups: IssueGroup[] };

/** Bucket for work the grouping axis has no value for — unassigned, no cycle,
 *  no label. Not a valid id in any table, so it cannot collide with one. */
export const UNGROUPED = "__none__";

const allows = (allowed: ReadonlyArray<unknown> | undefined, value: unknown) => !allowed?.length || allowed.includes(value);
const allowsAny = (allowed: ReadonlyArray<unknown> | undefined, values: readonly string[]) =>
  !allowed?.length || values.some((value) => allowed.includes(value));

export function applyFilters(list: readonly ViewIssue[], filters: Filters = {}): ViewIssue[] {
  const search = filters.search?.trim().toLowerCase();
  return list.filter((issue) => {
    if (search && ![issue.ref, issue.title, issue.detail].some((field) => field?.toLowerCase().includes(search))) return false;
    if (!allows(filters.statuses, issue.status)) return false;
    if (!allows(filters.stateIds, issue.stateId)) return false;
    if (!allows(filters.priorities, issue.priority)) return false;
    if (!allows(filters.assigneeIds, issue.assigneeAgentId)) return false;
    if (!allows(filters.cycleIds, issue.cycleId)) return false;
    if (!allows(filters.intakeStatuses, issue.intakeStatus)) return false;
    if (!allowsAny(filters.labelIds, issue.labelIds)) return false;
    if (!allowsAny(filters.moduleIds, issue.moduleIds)) return false;
    // A date bound excludes undated work rather than sweeping it in: "due this
    // week" should not surface everything with no due date at all.
    if (filters.targetDateFrom != null && (issue.targetDate == null || issue.targetDate < filters.targetDateFrom)) return false;
    if (filters.targetDateTo != null && (issue.targetDate == null || issue.targetDate > filters.targetDateTo)) return false;
    return true;
  });
}

/* Comparators return a total order — every one ends in an `id` tie-break — so
   the result never depends on the order rows came back from the database. */
type Comparator = (a: ViewIssue, b: ViewIssue) => number;
const byId: Comparator = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Ascending with nulls last, whichever direction the caller wants. */
const nullsLast = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b);
const then = (...comparators: Comparator[]): Comparator => (a, b) => {
  for (const compare of comparators) { const result = compare(a, b); if (result !== 0) return result; }
  return 0;
};

const COMPARATORS: Record<OrderBy, Comparator> = {
  manual: then((a, b) => nullsLast(a.sequence, b.sequence), (a, b) => a.createdAt - b.createdAt, byId),
  priority: then((a, b) => priorityRank(a.priority) - priorityRank(b.priority), (a, b) => b.updatedAt - a.updatedAt, byId),
  updated: then((a, b) => b.updatedAt - a.updatedAt, byId),
  created: then((a, b) => b.createdAt - a.createdAt, byId),
  target_date: then((a, b) => nullsLast(a.targetDate, b.targetDate), byId),
};

export function orderIssues(list: readonly ViewIssue[], orderBy: OrderBy = "manual"): ViewIssue[] {
  return [...list].sort(COMPARATORS[orderBy] ?? COMPARATORS.manual);
}

/* A grouping axis: the columns that must exist regardless of whether anything
   sits in them, and where a given issue lands. `keysOf` returns more than one
   key for the many-to-many axes — an issue with two labels appears under both,
   the same way Plane renders it. */
type Axis = { columns: Array<{ key: string; label: string; color: string | null }>; keysOf: (issue: ViewIssue) => string[] };

function axisFor(groupBy: GroupBy, context: ViewContext): Axis {
  const fallback = (label: string) => ({ key: UNGROUPED, label, color: null });
  switch (groupBy) {
    case "state": {
      const states = [...(context.states ?? [])].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
      return {
        columns: states.map((state) => ({ key: state.id, label: state.name, color: state.color })),
        // Resolved rather than read: the lifecycle moves work between statuses
        // without touching `stateId`, so a stale column must not strand a card.
        keysOf: (issue) => [resolveStateId(issue, states) ?? UNGROUPED],
      };
    }
    case "priority":
      return {
        columns: PRIORITY_ORDER.map((name) => ({ key: name, label: name, color: PRIORITY_COLOR[name] })),
        keysOf: (issue) => [issue.priority],
      };
    case "assignee":
      return {
        columns: [...(context.agents ?? []).map((agent) => ({ key: agent.id, label: agent.name, color: null })), fallback("Unassigned")],
        keysOf: (issue) => [issue.assigneeAgentId ?? UNGROUPED],
      };
    case "label":
      return {
        columns: [...(context.labels ?? []).map((label) => ({ key: label.id, label: label.name, color: label.color })), fallback("No label")],
        keysOf: (issue) => (issue.labelIds.length ? issue.labelIds : [UNGROUPED]),
      };
    case "cycle":
      return {
        columns: [...(context.cycles ?? []).map((cycle) => ({ key: cycle.id, label: cycle.name, color: null })), fallback("No cycle")],
        keysOf: (issue) => [issue.cycleId ?? UNGROUPED],
      };
    case "module":
      return {
        columns: [...(context.modules ?? []).map((module) => ({ key: module.id, label: module.name, color: null })), fallback("No module")],
        keysOf: (issue) => (issue.moduleIds.length ? issue.moduleIds : [UNGROUPED]),
      };
    default:
      return { columns: [{ key: "all", label: "All work items", color: null }], keysOf: () => ["all"] };
  }
}

/** Groups an issue list along one axis.
 *
 *  Columns the context declares are always returned, empty or not — a kanban
 *  board with a hidden "In Review" column is a board you cannot drop onto. A key
 *  an issue carries that the context does not declare (a label loaded before it
 *  was deleted, say) is appended rather than dropped, so no work vanishes. */
export function groupIssues(list: readonly ViewIssue[], groupBy: GroupBy = "state", context: ViewContext = {}): IssueGroup[] {
  const axis = axisFor(groupBy, context);
  const groups = new Map<string, IssueGroup>(axis.columns.map((column) => [column.key, { ...column, issues: [] }]));
  for (const issue of list) {
    for (const key of axis.keysOf(issue)) {
      let group = groups.get(key);
      if (!group) { group = { key, label: key, color: null, issues: [] }; groups.set(key, group); }
      group.issues.push(issue);
    }
  }
  return [...groups.values()];
}

export function buildView(list: readonly ViewIssue[], config: Partial<ViewConfig> = {}, context: ViewContext = {}): ViewModel {
  const resolved: ViewConfig = { ...DEFAULT_VIEW_CONFIG, ...config, filters: config.filters ?? {} };
  const visible = applyFilters(list, resolved.filters);
  const groups = groupIssues(visible, resolved.groupBy, context)
    .map((group) => ({ ...group, issues: orderIssues(group.issues, resolved.orderBy) }));
  // Counted before grouping: an issue with two labels is one work item, not two.
  return { config: resolved, total: visible.length, groups };
}

/** The gap between two sequences when there is nothing to sit between. */
export const SEQUENCE_STEP = 1;

/** The `sequence` to write for a card dropped between two neighbours.
 *
 *  Fractional indexing: the midpoint means a drag rewrites one row instead of
 *  renumbering the whole column. Repeatedly dropping into the same gap halves it
 *  each time, so after ~50 consecutive insertions the midpoint stops being
 *  distinct from its neighbours; ordering stays deterministic anyway because
 *  every comparator ends in an id tie-break. */
export function nextSequence(before: number | null | undefined, after: number | null | undefined): number {
  if (before == null && after == null) return SEQUENCE_STEP;
  if (before == null) return after! - SEQUENCE_STEP;
  if (after == null) return before + SEQUENCE_STEP;
  return (before + after) / 2;
}

export type { IssueStatus };
