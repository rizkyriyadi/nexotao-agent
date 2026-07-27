/* Data access for the work-management model: board columns, labels, cycles,
   modules, relations, saved views and pages.

   The load-bearing rule lives here in `moveIssueToState`. A workflow state is a
   *presentation* concept — it decides which column a card renders in — while
   `issues.status` remains the only thing the agent engine reads (see
   lib/issue-lifecycle.ts and the `tick` scan in lib/executor.ts). Every state
   carries a `statusGroup` naming the canonical status it stands for, so moving a
   card is translated into a real lifecycle transition rather than a raw write.
   That keeps two states in the same group possible ("Code Review" and "QA" can
   both be `in_review`) without giving the scheduler a second source of truth. */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDatabase, DEFAULT_WORKFLOW_STATES, STATUS_TO_DEFAULT_STATE, defaultStateId } from "./db/database";
import {
  cycles, issueLabels, issueRelations, issues, labels, moduleIssues, modules,
  pages, savedViews, workflowStates, documents, documentRevisions,
} from "./db/schema";
import { ISSUE_STATUSES, IssueDomainError, type IssueStatus } from "./issue-lifecycle";
import { getIssue, updateIssue } from "./issues";
import type { IssueActor } from "./issue-lifecycle";

export type WorkflowState = { id: string; projectId: string; name: string; statusGroup: IssueStatus; color: string; position: number; isDefault: boolean };
export type Label = { id: string; projectId: string; name: string; color: string; createdAt: number };
export type Cycle = { id: string; projectId: string; name: string; description: string; startDate: number | null; endDate: number | null; completedAt: number | null; createdAt: number; updatedAt: number };
export type Module = { id: string; projectId: string; name: string; description: string; leadAgentId: string | null; targetDate: number | null; status: string; completedAt: number | null; createdAt: number; updatedAt: number };
export type RelationType = "relates_to" | "duplicate";
export type IssueRelation = { issueId: string; relatedIssueId: string; relationType: RelationType };
export type SavedView = { id: string; projectId: string; name: string; config: Record<string, unknown>; createdAt: number; updatedAt: number };
export type Page = { id: string; projectId: string; title: string; documentId: string; archivedAt: number | null; createdAt: number; updatedAt: number };

const isStatus = (value: string): value is IssueStatus => (ISSUE_STATUSES as readonly string[]).includes(value);

const stateFromRow = (row: typeof workflowStates.$inferSelect): WorkflowState => ({
  id: row.id, projectId: row.projectId, name: row.name, statusGroup: row.statusGroup as IssueStatus,
  color: row.color, position: row.position, isDefault: row.isDefault,
});

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

/* ---------- workflow states ---------- */

/** Create the default columns for a project if it has none. Idempotent: the ids are
 *  derived from the project id, so a re-run inserts nothing. Called when a project
 *  is created and again on read, so a project that predates a failed migration
 *  still gets its columns rather than rendering an empty board. */
export async function ensureWorkflowStates(projectId: string): Promise<WorkflowState[]> {
  const database = await getDatabase();
  const existing = database.read((db) => db.select().from(workflowStates).where(eq(workflowStates.projectId, projectId)).orderBy(asc(workflowStates.position)).all());
  if (existing.length) return existing.map(stateFromRow);
  const now = Date.now();
  await database.write((db) => {
    for (const state of DEFAULT_WORKFLOW_STATES) {
      db.insert(workflowStates).values({
        id: defaultStateId(projectId, state.key), projectId, name: state.name, statusGroup: state.group,
        color: state.color, position: state.position, isDefault: true, createdAt: now, updatedAt: now,
      }).onConflictDoNothing().run();
    }
    // Place any issue that has no column yet — rows created between the migration
    // and this call, or by a code path that does not set `stateId`.
    for (const [status, key] of Object.entries(STATUS_TO_DEFAULT_STATE)) {
      db.update(issues).set({ stateId: defaultStateId(projectId, key) })
        .where(and(eq(issues.projectId, projectId), eq(issues.status, status))).run();
    }
  });
  return listWorkflowStates(projectId);
}

export async function listWorkflowStates(projectId: string): Promise<WorkflowState[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(workflowStates).where(eq(workflowStates.projectId, projectId)).orderBy(asc(workflowStates.position)).all().map(stateFromRow));
}

export async function getWorkflowState(id: string): Promise<WorkflowState | null> {
  const database = await getDatabase();
  const row = database.read((db) => db.select().from(workflowStates).where(eq(workflowStates.id, id)).get());
  return row ? stateFromRow(row) : null;
}

export async function createWorkflowState(input: { projectId: string; name: string; statusGroup: string; color?: string; position?: number }): Promise<WorkflowState> {
  if (!isStatus(input.statusGroup)) throw new IssueDomainError("validation", `Unknown status group: ${input.statusGroup}`);
  const name = input.name.trim();
  if (!name) throw new IssueDomainError("validation", "A workflow state needs a name");
  const database = await getDatabase();
  const now = Date.now();
  const id = randomUUID();
  await database.write((db) => {
    const last = db.select().from(workflowStates).where(eq(workflowStates.projectId, input.projectId)).orderBy(asc(workflowStates.position)).all().at(-1);
    db.insert(workflowStates).values({
      id, projectId: input.projectId, name, statusGroup: input.statusGroup, color: input.color ?? "#6b7280",
      position: input.position ?? (last ? last.position + 1 : 1), isDefault: false, createdAt: now, updatedAt: now,
    }).run();
  });
  return (await getWorkflowState(id))!;
}

export async function updateWorkflowState(id: string, patch: { name?: string; statusGroup?: string; color?: string; position?: number }): Promise<WorkflowState | null> {
  if (patch.statusGroup !== undefined && !isStatus(patch.statusGroup)) throw new IssueDomainError("validation", `Unknown status group: ${patch.statusGroup}`);
  const database = await getDatabase();
  await database.write((db) => {
    db.update(workflowStates).set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.statusGroup !== undefined ? { statusGroup: patch.statusGroup } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      updatedAt: Date.now(),
    }).where(eq(workflowStates.id, id)).run();
  });
  return getWorkflowState(id);
}

/** Delete a column, refusing while cards still live in it. Reassigning them
 *  silently would move work between status groups without a lifecycle check. */
export async function deleteWorkflowState(id: string): Promise<void> {
  const database = await getDatabase();
  const occupants = database.read((db) => db.select({ id: issues.id }).from(issues).where(eq(issues.stateId, id)).all());
  if (occupants.length) throw new IssueDomainError("conflict", `${occupants.length} work item(s) still use this state`);
  await database.write((db) => db.delete(workflowStates).where(eq(workflowStates.id, id)).run());
}

/* ---------- moving a card ---------- */

/** Move an issue into a column, translating the column's status group into a real
 *  lifecycle transition. Returns the updated issue.
 *
 *  Rejections are deliberate, not gaps:
 *  - `in_progress` is reachable only through `checkout()` by the assigned agent on
 *    a live run, so dropping a card there by hand cannot be honoured.
 *  - moving into a `todo` column while blockers are unmet is refused by the
 *    lifecycle, which is the same rule the scheduler applies. */
export async function moveIssueToState(issueId: string, stateId: string, actor: IssueActor = { type: "user" }, sequence?: number) {
  const issue = await getIssue(issueId);
  if (!issue) throw new IssueDomainError("not_found", "Work item not found");
  const state = await getWorkflowState(stateId);
  if (!state) throw new IssueDomainError("not_found", "Workflow state not found");
  if (state.projectId !== issue.projectId) throw new IssueDomainError("forbidden", "State belongs to another project");

  if (state.statusGroup === "in_progress" && issue.status !== "in_progress") {
    throw new IssueDomainError("invalid_transition", "Work enters In Progress when an agent picks it up, not by hand");
  }

  const database = await getDatabase();
  await database.write((db) => {
    db.update(issues).set({
      stateId, ...(sequence !== undefined ? { sequence } : {}), updatedAt: Date.now(),
    }).where(eq(issues.id, issueId)).run();
  });

  // Only ask the lifecycle for a transition when the group actually differs;
  // reordering inside a column must not churn status or clear checkout locks.
  if (state.statusGroup !== issue.status && state.statusGroup !== "in_progress") {
    try {
      await updateIssue(issueId, { status: state.statusGroup }, actor);
    } catch (error) {
      // Put the card back where it was so the board never shows a column the
      // engine disagrees with.
      await database.write((db) => db.update(issues).set({ stateId: issue.stateId ?? null }).where(eq(issues.id, issueId)).run());
      throw error;
    }
  }
  return getIssue(issueId);
}

/** Update the work-management fields that carry no lifecycle meaning. */
export async function updateIssueWorkFields(issueId: string, patch: {
  cycleId?: string | null; estimatePoint?: number | null; startDate?: number | null;
  targetDate?: number | null; sequence?: number | null; intakeStatus?: string | null; intakeSource?: string | null;
}) {
  const database = await getDatabase();
  await database.write((db) => {
    db.update(issues).set({
      ...(patch.cycleId !== undefined ? { cycleId: patch.cycleId } : {}),
      ...(patch.estimatePoint !== undefined ? { estimatePoint: patch.estimatePoint } : {}),
      ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
      ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
      ...(patch.sequence !== undefined ? { sequence: patch.sequence } : {}),
      ...(patch.intakeStatus !== undefined ? { intakeStatus: patch.intakeStatus } : {}),
      ...(patch.intakeSource !== undefined ? { intakeSource: patch.intakeSource } : {}),
      updatedAt: Date.now(),
    }).where(eq(issues.id, issueId)).run();
  });
  return getIssue(issueId);
}

/* ---------- labels ---------- */

export async function listLabels(projectId: string): Promise<Label[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(labels).where(eq(labels.projectId, projectId)).orderBy(asc(labels.name)).all());
}

export async function createLabel(input: { projectId: string; name: string; color?: string }): Promise<Label> {
  const name = input.name.trim();
  if (!name) throw new IssueDomainError("validation", "A label needs a name");
  const database = await getDatabase();
  const label: Label = { id: randomUUID(), projectId: input.projectId, name, color: input.color ?? "#6b7280", createdAt: Date.now() };
  await database.write((db) => db.insert(labels).values(label).run());
  return label;
}

export async function updateLabel(id: string, patch: { name?: string; color?: string }): Promise<Label | null> {
  const database = await getDatabase();
  return database.write((db) => {
    db.update(labels).set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    }).where(eq(labels.id, id)).run();
    return db.select().from(labels).where(eq(labels.id, id)).get() ?? null;
  });
}

export async function deleteLabel(id: string): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => db.delete(labels).where(eq(labels.id, id)).run());
}

/** Replace an issue's labels wholesale — the shape the label picker sends. */
export async function setIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
  const database = await getDatabase();
  const unique = [...new Set(labelIds)];
  await database.write((db) => {
    db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run();
    for (const labelId of unique) db.insert(issueLabels).values({ issueId, labelId }).run();
    db.update(issues).set({ updatedAt: Date.now() }).where(eq(issues.id, issueId)).run();
  });
}

/* ---------- cycles ---------- */

export async function listCycles(projectId: string): Promise<Cycle[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(cycles).where(eq(cycles.projectId, projectId)).orderBy(asc(cycles.createdAt)).all());
}

export async function getCycle(id: string): Promise<Cycle | null> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(cycles).where(eq(cycles.id, id)).get() ?? null);
}

export async function createCycle(input: { projectId: string; name: string; description?: string; startDate?: number | null; endDate?: number | null }): Promise<Cycle> {
  const name = input.name.trim();
  if (!name) throw new IssueDomainError("validation", "A cycle needs a name");
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new IssueDomainError("validation", "A cycle cannot end before it starts");
  const database = await getDatabase();
  const now = Date.now();
  const cycle: Cycle = {
    id: randomUUID(), projectId: input.projectId, name, description: input.description ?? "",
    startDate: input.startDate ?? null, endDate: input.endDate ?? null, completedAt: null, createdAt: now, updatedAt: now,
  };
  await database.write((db) => db.insert(cycles).values(cycle).run());
  return cycle;
}

export async function updateCycle(id: string, patch: Partial<Pick<Cycle, "name" | "description" | "startDate" | "endDate" | "completedAt">>): Promise<Cycle | null> {
  const database = await getDatabase();
  await database.write((db) => {
    db.update(cycles).set({ ...patch, updatedAt: Date.now() }).where(eq(cycles.id, id)).run();
  });
  return getCycle(id);
}

export async function deleteCycle(id: string): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => {
    db.update(issues).set({ cycleId: null }).where(eq(issues.cycleId, id)).run();
    db.delete(cycles).where(eq(cycles.id, id)).run();
  });
}

/* ---------- modules ---------- */

export async function listModules(projectId: string): Promise<Module[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(modules).where(eq(modules.projectId, projectId)).orderBy(asc(modules.createdAt)).all());
}

export async function getModule(id: string): Promise<Module | null> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(modules).where(eq(modules.id, id)).get() ?? null);
}

export async function createModule(input: { projectId: string; name: string; description?: string; leadAgentId?: string | null; targetDate?: number | null }): Promise<Module> {
  const name = input.name.trim();
  if (!name) throw new IssueDomainError("validation", "A module needs a name");
  const database = await getDatabase();
  const now = Date.now();
  const record: Module = {
    id: randomUUID(), projectId: input.projectId, name, description: input.description ?? "",
    leadAgentId: input.leadAgentId ?? null, targetDate: input.targetDate ?? null, status: "planned",
    completedAt: null, createdAt: now, updatedAt: now,
  };
  await database.write((db) => db.insert(modules).values(record).run());
  return record;
}

export async function updateModule(id: string, patch: Partial<Pick<Module, "name" | "description" | "leadAgentId" | "targetDate" | "status" | "completedAt">>): Promise<Module | null> {
  const database = await getDatabase();
  await database.write((db) => {
    db.update(modules).set({ ...patch, updatedAt: Date.now() }).where(eq(modules.id, id)).run();
  });
  return getModule(id);
}

export async function deleteModule(id: string): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => db.delete(modules).where(eq(modules.id, id)).run());
}

export async function setIssueModules(issueId: string, moduleIds: string[]): Promise<void> {
  const database = await getDatabase();
  const unique = [...new Set(moduleIds)];
  await database.write((db) => {
    db.delete(moduleIssues).where(eq(moduleIssues.issueId, issueId)).run();
    for (const moduleId of unique) db.insert(moduleIssues).values({ moduleId, issueId }).run();
    db.update(issues).set({ updatedAt: Date.now() }).where(eq(issues.id, issueId)).run();
  });
}

export async function moduleIssueIds(moduleId: string): Promise<string[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(moduleIssues).where(eq(moduleIssues.moduleId, moduleId)).all().map((row) => row.issueId));
}

/* ---------- relations ---------- */

/** Link two issues. Soft links only — symmetric, so both directions are stored and
 *  either side shows the relation. Blocking is not expressible here on purpose. */
export async function addIssueRelation(issueId: string, relatedIssueId: string, relationType: RelationType): Promise<void> {
  if (issueId === relatedIssueId) throw new IssueDomainError("validation", "An item cannot relate to itself");
  const database = await getDatabase();
  const both = database.read((db) => db.select().from(issues).where(inArray(issues.id, [issueId, relatedIssueId])).all());
  if (both.length !== 2) throw new IssueDomainError("not_found", "Both work items must exist");
  if (both[0].projectId !== both[1].projectId) throw new IssueDomainError("forbidden", "Work items must be in the same project");
  const createdAt = Date.now();
  await database.write((db) => {
    db.insert(issueRelations).values({ issueId, relatedIssueId, relationType, createdAt }).onConflictDoNothing().run();
    db.insert(issueRelations).values({ issueId: relatedIssueId, relatedIssueId: issueId, relationType, createdAt }).onConflictDoNothing().run();
  });
}

export async function removeIssueRelation(issueId: string, relatedIssueId: string, relationType: RelationType): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => {
    db.delete(issueRelations).where(and(eq(issueRelations.issueId, issueId), eq(issueRelations.relatedIssueId, relatedIssueId), eq(issueRelations.relationType, relationType))).run();
    db.delete(issueRelations).where(and(eq(issueRelations.issueId, relatedIssueId), eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.relationType, relationType))).run();
  });
}

export async function issueRelationsOf(issueId: string): Promise<IssueRelation[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(issueRelations).where(eq(issueRelations.issueId, issueId)).all().map((row) => ({
    issueId: row.issueId, relatedIssueId: row.relatedIssueId, relationType: row.relationType,
  })));
}

/* ---------- saved views ---------- */

export async function listSavedViews(projectId: string): Promise<SavedView[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(savedViews).where(eq(savedViews.projectId, projectId)).orderBy(asc(savedViews.createdAt)).all().map((row) => ({
    id: row.id, projectId: row.projectId, name: row.name, config: row.config, createdAt: row.createdAt, updatedAt: row.updatedAt,
  })));
}

export async function saveView(input: { projectId: string; name: string; config: Record<string, unknown> }): Promise<SavedView> {
  const name = input.name.trim();
  if (!name) throw new IssueDomainError("validation", "A view needs a name");
  const database = await getDatabase();
  const now = Date.now();
  const id = randomUUID();
  await database.write((db) => {
    db.insert(savedViews).values({ id, projectId: input.projectId, name, config: input.config, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [savedViews.projectId, savedViews.name], set: { config: input.config, updatedAt: now } }).run();
  });
  return (await listSavedViews(input.projectId)).find((view) => view.name === name) ?? { id, projectId: input.projectId, name, config: input.config, createdAt: now, updatedAt: now };
}

export async function deleteSavedView(id: string): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => db.delete(savedViews).where(eq(savedViews.id, id)).run());
}

/* ---------- pages ---------- */

export async function listPages(projectId: string): Promise<Page[]> {
  const database = await getDatabase();
  return database.read((db) => db.select().from(pages).where(eq(pages.projectId, projectId)).orderBy(asc(pages.updatedAt)).all());
}

/** A page and the body of its newest revision. */
export async function getPage(id: string): Promise<(Page & { body: string; revision: number }) | null> {
  const database = await getDatabase();
  return database.read((db) => {
    const page = db.select().from(pages).where(eq(pages.id, id)).get();
    if (!page) return null;
    const latest = db.select().from(documentRevisions).where(eq(documentRevisions.documentId, page.documentId)).orderBy(asc(documentRevisions.revision)).all().at(-1);
    return { ...page, body: latest?.body ?? "", revision: latest?.revision ?? 0 };
  });
}

export async function createPage(input: { projectId: string; title: string; body?: string; authorType?: string; authorId?: string | null }): Promise<Page> {
  const database = await getDatabase();
  const now = Date.now();
  const documentId = randomUUID();
  const page: Page = { id: randomUUID(), projectId: input.projectId, title: input.title.trim() || "Untitled", documentId, archivedAt: null, createdAt: now, updatedAt: now };
  await database.write((db) => {
    db.insert(documents).values({ id: documentId, createdAt: now, updatedAt: now }).run();
    db.insert(documentRevisions).values({
      id: randomUUID(), documentId, revision: 1, body: input.body ?? "",
      createdByType: input.authorType ?? "user", createdById: input.authorId ?? null, createdAt: now,
    }).run();
    db.insert(pages).values(page).run();
  });
  return page;
}

/** Save a page. A body change appends a revision rather than overwriting, so the
 *  history that `document_revisions` already provides stays intact. */
export async function updatePage(id: string, patch: { title?: string; body?: string; archivedAt?: number | null; authorType?: string; authorId?: string | null }) {
  const database = await getDatabase();
  const now = Date.now();
  await database.write((db) => {
    const page = db.select().from(pages).where(eq(pages.id, id)).get();
    if (!page) return;
    if (patch.body !== undefined) {
      const revisions = db.select().from(documentRevisions).where(eq(documentRevisions.documentId, page.documentId)).all();
      const next = revisions.reduce((max, row) => Math.max(max, row.revision), 0) + 1;
      db.insert(documentRevisions).values({
        id: randomUUID(), documentId: page.documentId, revision: next, body: patch.body,
        createdByType: patch.authorType ?? "user", createdById: patch.authorId ?? null, createdAt: now,
      }).run();
      db.update(documents).set({ updatedAt: now }).where(eq(documents.id, page.documentId)).run();
    }
    db.update(pages).set({
      ...(patch.title !== undefined ? { title: patch.title.trim() || "Untitled" } : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      updatedAt: now,
    }).where(eq(pages.id, id)).run();
  });
  return getPage(id);
}

export async function deletePage(id: string): Promise<void> {
  const database = await getDatabase();
  await database.write((db) => {
    const page = db.select().from(pages).where(eq(pages.id, id)).get();
    db.delete(pages).where(eq(pages.id, id)).run();
    if (page) db.delete(documents).where(eq(documents.id, page.documentId)).run();
  });
}
