// Milestone 4 governance (NEXA-16): redacted log/event retention and local
// user-data export/delete controls. The append-only activity feed itself lives
// in the lifecycle services (issue-lifecycle, agent-lifecycle, execution-policy)
// and repositories; this module governs how long redacted records are kept and
// how a user takes their data out or removes it. Everything returned here is
// passed through `redactValue` so secrets never reach an export, an audit
// summary, or a deletion report.
import { promises as fs } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "./db/database";
import {
  activityLog, agentRuns, agents, approvals, documentRevisions,
  documents, gitWorkspaces, heartbeatRuns, issueComments, issueDependencies, issueDocuments,
  issueMutationRequests, issues, projects, runEvents, runRecords, sessions, tasks, wakeupRequests,
} from "./db/schema";
import { redactValue } from "./redact";

const DAY_MS = 86_400_000;

export type RetentionPolicy = { runEventDays?: number | null; auditDays?: number | null };

// Audit actions that are load-bearing for other invariants and must survive
// retention regardless of age, even when older than the audit window. Empty for
// now — no action currently gates another invariant — but the planner keeps
// honoring this set so a future integrity-required action is protected as soon
// as it is listed here.
export const INTEGRITY_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([]);

function cutoff(now: number, days?: number | null): number | null {
  if (days === null || days === undefined || !Number.isFinite(days) || days <= 0) return null;
  return now - days * DAY_MS;
}

export type RetentionPlan = {
  runEvents: Array<{ runId: string; seq: number }>;
  activity: string[];
  keptForIntegrity: number;
};

/** Deterministic retention planner: given the same records, policy, and `now`
 * it always selects the same rows. Kept pure so the "which rows get pruned"
 * decision is unit-testable without a database. Redacted run events strictly
 * older than the event window are dropped; audit rows older than the audit
 * window are dropped unless their action is integrity-required. */
export function planRetention(input: {
  now: number;
  policy: RetentionPolicy;
  runEvents: Array<{ runId: string; seq: number; createdAt: number }>;
  activity: Array<{ id: string; action: string; createdAt: number }>;
}): RetentionPlan {
  const eventCutoff = cutoff(input.now, input.policy.runEventDays);
  const auditCutoff = cutoff(input.now, input.policy.auditDays);
  const runEventRows = eventCutoff === null
    ? []
    : input.runEvents.filter((event) => event.createdAt < eventCutoff);
  const runEventTargets = runEventRows
    .map((event) => ({ runId: event.runId, seq: event.seq }))
    .sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq);
  const activity: string[] = [];
  let keptForIntegrity = 0;
  if (auditCutoff !== null) {
    for (const row of [...input.activity].sort((a, b) => a.id.localeCompare(b.id))) {
      if (row.createdAt >= auditCutoff) continue;
      if (INTEGRITY_REQUIRED_ACTIONS.has(row.action)) { keptForIntegrity += 1; continue; }
      activity.push(row.id);
    }
  }
  return { runEvents: runEventTargets, activity, keptForIntegrity };
}

export type RetentionOutcome = {
  appliedAt: number;
  policy: RetentionPolicy;
  removedRunEvents: number;
  removedActivity: number;
  keptForIntegrity: number;
};

/** Apply a retention policy across the whole local database. Only redacted run
 * events and non-integrity audit rows are removed; issues, runs, and the audit
 * records other invariants depend on are left intact, so referential integrity
 * is preserved (both target tables carry no inbound foreign keys). */
export async function applyRetention(database: AppDatabase, policy: RetentionPolicy, now = Date.now()): Promise<RetentionOutcome> {
  const snapshot = database.read((db) => ({
    runEvents: db.select({ runId: runEvents.runId, seq: runEvents.seq, createdAt: runEvents.createdAt }).from(runEvents).all(),
    activity: db.select({ id: activityLog.id, action: activityLog.action, createdAt: activityLog.createdAt }).from(activityLog).all(),
  }));
  const plan = planRetention({ now, policy, runEvents: snapshot.runEvents, activity: snapshot.activity });
  await database.write((db) => {
    for (const event of plan.runEvents) {
      db.delete(runEvents).where(and(eq(runEvents.runId, event.runId), eq(runEvents.seq, event.seq))).run();
    }
    for (let i = 0; i < plan.activity.length; i += 200) {
      db.delete(activityLog).where(inArray(activityLog.id, plan.activity.slice(i, i + 200))).run();
    }
  });
  return {
    appliedAt: now,
    policy,
    removedRunEvents: plan.runEvents.length,
    removedActivity: plan.activity.length,
    keptForIntegrity: plan.keptForIntegrity,
  };
}

function chunk<T>(values: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Collect every record that belongs to a project so a user can take their
 * local data with them. The whole bundle is redacted before it is returned, so
 * no gateway key, bearer token, or secret-shaped field ever leaves in an
 * export — even ones an adapter or run event happened to persist. */
export function exportProjectData(database: AppDatabase, projectId: string, now = Date.now()) {
  const bundle = database.read((db) => {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get() ?? null;
    if (!project) return null;
    const agentRows = db.select().from(agents).where(eq(agents.projectId, projectId)).all();
    const issueRows = db.select().from(issues).where(eq(issues.projectId, projectId)).all();
    const agentIds = agentRows.map((row) => row.id);
    const issueIds = issueRows.map((row) => row.id);
    const runRows = agentIds.length
      ? chunk(agentIds).flatMap((ids) => db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, ids)).all())
      : [];
    const runIds = runRows.map((row) => row.id);
    const documentLinks = issueIds.length
      ? chunk(issueIds).flatMap((ids) => db.select().from(issueDocuments).where(inArray(issueDocuments.issueId, ids)).all())
      : [];
    const documentIds = documentLinks.map((link) => link.documentId);
    const scopedActivityIds = [...issueIds, ...agentIds];
    const approvalRows = db.select().from(approvals).where(eq(approvals.projectId, projectId)).all();
    const activityIds = [...scopedActivityIds, ...approvalRows.map((row) => row.id)];
    return {
      project,
      agents: agentRows,
      issues: issueRows,
      issueDependencies: issueIds.length ? chunk(issueIds).flatMap((ids) => db.select().from(issueDependencies).where(inArray(issueDependencies.issueId, ids)).all()) : [],
      issueMutationRequests: db.select().from(issueMutationRequests).where(eq(issueMutationRequests.projectId, projectId)).all(),
      comments: issueIds.length ? chunk(issueIds).flatMap((ids) => db.select().from(issueComments).where(inArray(issueComments.issueId, ids)).all()) : [],
      documents: documentIds.length ? chunk(documentIds).flatMap((ids) => db.select().from(documents).where(inArray(documents.id, ids)).all()) : [],
      documentLinks,
      documentRevisions: documentIds.length ? chunk(documentIds).flatMap((ids) => db.select().from(documentRevisions).where(inArray(documentRevisions.documentId, ids)).all()) : [],
      heartbeatRuns: runRows,
      wakeupRequests: agentIds.length ? chunk(agentIds).flatMap((ids) => db.select().from(wakeupRequests).where(inArray(wakeupRequests.agentId, ids)).all()) : [],
      runEvents: runIds.length ? chunk(runIds).flatMap((ids) => db.select().from(runEvents).where(inArray(runEvents.runId, ids)).all()) : [],
      approvals: approvalRows,
      activity: activityIds.length ? chunk(activityIds).flatMap((ids) => db.select().from(activityLog).where(inArray(activityLog.entityId, ids)).all()) : [],
      gitWorkspaces: db.select().from(gitWorkspaces).where(eq(gitWorkspaces.projectId, projectId)).all(),
      sessions: db.select().from(sessions).where(eq(sessions.projectId, projectId)).all(),
      tasks: db.select().from(tasks).where(eq(tasks.projectId, projectId)).all(),
      agentRuns: db.select().from(agentRuns).where(eq(agentRuns.projectId, projectId)).all(),
      runRecords: db.select().from(runRecords).where(eq(runRecords.projectId, projectId)).all(),
    };
  });
  if (!bundle) return null;
  const counts = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1]));
  return redactValue({ format: "nexotao.project-export/v1", exportedAt: now, projectId, counts, data: bundle });
}

export type DeletionOutcome = {
  projectId: string;
  confirmedAt: number;
  deleted: Record<string, number>;
  retained: Record<string, number>;
  integrityNote: string;
};

export class DataControlError extends Error {
  constructor(readonly code: "not_found" | "confirmation_required", message: string) {
    super(message);
    this.name = "DataControlError";
  }
}

/** Everything a project leaves outside its database rows. Injectable so the
 *  tests exercise the real code path against a throwaway directory. */
export type PurgeDeps = {
  graphDir?: (projectId: string) => string;
  dropCodeIndex?: (projectId: string) => Promise<boolean>;
};

/**
 * Remove a deleted project's on-disk artifacts: the work-history graph it wrote
 * under `~/.nexotao/graph/<projectId>/`, and the symbol index the code layer
 * keeps in the CLI's shared cache. Neither cascades off the project row, so
 * before this both survived a deletion the user was told was complete — and the
 * code index is a symbol-level map of their source sitting in a directory
 * outside NEXOTAO_DATA_DIR entirely.
 *
 * Each step is independently guarded and this never throws. A cache file held
 * open by another process must not turn a confirmed deletion into a failure;
 * the counts simply report 0 and the rows are gone regardless.
 *
 * Worktrees are deliberately NOT removed: `~/.nexotao/worktrees/<repoHash>/` is
 * keyed by repository, so two projects on one repo share it, and deleting it
 * without `git worktree prune` strands the repo's own registry. The note says
 * so by name rather than leaving the user to discover the directory.
 */
export async function purgeProjectArtifacts(
  projectId: string,
  deps: PurgeDeps = {},
): Promise<{ deleted: Record<string, number>; note: string }> {
  const deleted: Record<string, number> = { workGraph: 0, codeIndex: 0 };

  try {
    const dir = deps.graphDir ? deps.graphDir(projectId) : (await import("./graph-data")).graphDir(projectId);
    await fs.stat(dir); // count only what was actually there
    await fs.rm(dir, { recursive: true, force: true });
    deleted.workGraph = 1;
  } catch { /* never built, already gone, or unreadable — all the same outcome */ }

  try {
    const drop = deps.dropCodeIndex ?? (await import("./code-memory")).dropCodeIndex;
    if (await drop(projectId)) deleted.codeIndex = 1;
  } catch { /* the index is optional; its absence is the normal case */ }

  return {
    deleted,
    note: " Local graph files and the code index for this project were removed. Git worktrees under ~/.nexotao/worktrees/ are shared per repository and are left in place; remove them with `git worktree prune` if no other project uses that repository.",
  };
}

/** Delete all deletable local data for a project and report exactly what was
 * removed and what was intentionally kept. Requires explicit confirmation.
 *
 * Most tables clear through `ON DELETE CASCADE` off the project row. Two do not
 * and are removed by hand to avoid orphans: `run_events` (keyed by run id, no
 * foreign key) and `documents`/`document_revisions` (only the join row cascades
 * from an issue). The append-only `activity_log` is deliberately RETAINED — it
 * is the durable audit trail — so the outcome reports it under `retained`.
 *
 * On-disk artifacts are purged after the write, not inside it: `database.write`
 * takes a synchronous callback, so filesystem work cannot live in there. */
export async function deleteProjectData(
  database: AppDatabase,
  projectId: string,
  options: { confirm: boolean; purge?: PurgeDeps },
  now = Date.now(),
): Promise<DeletionOutcome> {
  if (!options.confirm) throw new DataControlError("confirmation_required", "Deletion requires explicit confirmation");
  const outcome = await database.write((db) => {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new DataControlError("not_found", "Project not found");

    const agentRows = db.select({ id: agents.id }).from(agents).where(eq(agents.projectId, projectId)).all();
    const issueRows = db.select({ id: issues.id }).from(issues).where(eq(issues.projectId, projectId)).all();
    const agentIds = agentRows.map((row) => row.id);
    const issueIds = issueRows.map((row) => row.id);
    const runRows = agentIds.length ? chunk(agentIds).flatMap((ids) => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, ids)).all()) : [];
    const runIds = runRows.map((row) => row.id);
    const documentLinks = issueIds.length ? chunk(issueIds).flatMap((ids) => db.select().from(issueDocuments).where(inArray(issueDocuments.issueId, ids)).all()) : [];
    const documentIds = documentLinks.map((link) => link.documentId);
    const approvalRows = db.select({ id: approvals.id }).from(approvals).where(eq(approvals.projectId, projectId)).all();
    const scopedActivityIds = [...issueIds, ...agentIds, ...approvalRows.map((row) => row.id)];

    const inSet = <T>(ids: string[], select: (part: string[]) => T[]): number =>
      ids.length ? chunk(ids).reduce((total, part) => total + select(part).length, 0) : 0;

    const deleted: Record<string, number> = {
      agents: agentIds.length,
      issues: issueIds.length,
      heartbeatRuns: runIds.length,
      runEvents: inSet(runIds, (ids) => db.select({ runId: runEvents.runId }).from(runEvents).where(inArray(runEvents.runId, ids)).all()),
      documents: documentIds.length,
      documentRevisions: inSet(documentIds, (ids) => db.select({ id: documentRevisions.id }).from(documentRevisions).where(inArray(documentRevisions.documentId, ids)).all()),
      comments: inSet(issueIds, (ids) => db.select({ id: issueComments.id }).from(issueComments).where(inArray(issueComments.issueId, ids)).all()),
      dependencies: inSet(issueIds, (ids) => db.select({ id: issueDependencies.issueId }).from(issueDependencies).where(inArray(issueDependencies.issueId, ids)).all()),
      approvals: approvalRows.length,
      wakeupRequests: inSet(agentIds, (ids) => db.select({ id: wakeupRequests.id }).from(wakeupRequests).where(inArray(wakeupRequests.agentId, ids)).all()),
      gitWorkspaces: db.select({ id: gitWorkspaces.id }).from(gitWorkspaces).where(eq(gitWorkspaces.projectId, projectId)).all().length,
      sessions: db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectId)).all().length,
      tasks: db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)).all().length,
      agentRuns: db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.projectId, projectId)).all().length,
      runRecords: db.select({ id: runRecords.id }).from(runRecords).where(eq(runRecords.projectId, projectId)).all().length,
    };
    const retainedActivity = inSet(scopedActivityIds, (ids) => db.select({ id: activityLog.id }).from(activityLog).where(inArray(activityLog.entityId, ids)).all());

    // Explicit orphan cleanup for the two tables the project cascade misses.
    for (const ids of chunk(runIds)) db.delete(runEvents).where(inArray(runEvents.runId, ids)).run();
    for (const ids of chunk(documentIds)) db.delete(documentRevisions).where(inArray(documentRevisions.documentId, ids)).run();
    for (const ids of chunk(documentIds)) db.delete(documents).where(inArray(documents.id, ids)).run();
    // Cascades the rest: agents, issues (+ links, comments, deps, mutation
    // requests), heartbeat runs, wakeups, approvals, config revisions, git
    // workspaces, sessions, tasks, agent runs, run records.
    db.delete(projects).where(eq(projects.id, projectId)).run();

    return {
      projectId,
      confirmedAt: now,
      deleted,
      retained: { activityLog: retainedActivity },
      integrityNote:
        "Append-only audit activity is retained after deletion as the durable record of what happened. " +
        "All other project records are removed, including redacted run events and document history.",
    } satisfies DeletionOutcome;
  });

  const purged = await purgeProjectArtifacts(projectId, options.purge);
  return {
    ...outcome,
    deleted: { ...outcome.deleted, ...purged.deleted },
    integrityNote: outcome.integrityNote + purged.note,
  };
}

function clipValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}… (${value.length} chars)`;
  return value;
}

/** Redacted, bounded before/after diff of an agent configuration change — the
 * safe summary that lets an audit entry show which fields moved (permissions,
 * adapter config, …) without leaking a secret an adapter config or permission
 * map might hold. */
export function configActivityDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const fields: string[] = [];
  const beforeChanged: Record<string, unknown> = {};
  const afterChanged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    fields.push(key);
    beforeChanged[key] = clipValue(before[key]);
    afterChanged[key] = clipValue(after[key]);
  }
  return { fields: fields.sort(), before: redactValue(beforeChanged), after: redactValue(afterChanged) };
}
