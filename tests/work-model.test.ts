import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the store singleton at a throwaway dir before importing any lib module
// (the db is captured on first import). Each test uses a distinct projectId so
// writes never collide.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-work-model-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { eq } = await import("drizzle-orm");
const { getDatabase, DEFAULT_WORKFLOW_STATES, defaultStateId } = await import("../lib/db/database");
const schema = await import("../lib/db/schema");
const { IssueDomainError } = await import("../lib/issue-lifecycle");
const { createIssue, getIssue, updateIssue } = await import("../lib/issues");
const work = await import("../lib/work-model");

async function makeProject(id: string) {
  const db = await getDatabase();
  await db.write((d) => {
    d.insert(schema.projects).values({ id, name: "Nexotao", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run();
    d.insert(schema.agents).values({ id: `${id}-agent`, projectId: id, name: "Hutao", role: "lead", scope: "", status: "idle", createdAt: 1, updatedAt: 1 }).run();
  });
  return work.ensureWorkflowStates(id);
}

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

test("a project gets the five default board columns, and seeding twice adds nothing", async () => {
  const states = await makeProject("wm1");
  assert.deepEqual(states.map((state) => state.name), DEFAULT_WORKFLOW_STATES.map((state) => state.name));
  assert.deepEqual(states.map((state) => state.statusGroup), ["backlog", "todo", "in_progress", "in_review", "done"]);
  assert.ok(states.every((state) => state.isDefault));
  const again = await work.ensureWorkflowStates("wm1");
  assert.equal(again.length, 5, "the seed is idempotent");
  assert.deepEqual(again.map((state) => state.id), states.map((state) => state.id));
});

test("a new issue lands in the column matching the status it was created with", async () => {
  await makeProject("wm2");
  const backlog = await createIssue({ projectId: "wm2", title: "Backlog item", status: "backlog" });
  const todo = await createIssue({ projectId: "wm2", title: "Todo item", status: "todo" });
  assert.equal(backlog.stateId, defaultStateId("wm2", "backlog"));
  assert.equal(todo.stateId, defaultStateId("wm2", "todo"));
});

test("blocked work renders under Todo and cancelled work under Done, without touching status", async () => {
  const states = await makeProject("wm3");
  const blocker = await createIssue({ projectId: "wm3", title: "Blocker", status: "todo" });
  const dependent = await createIssue({ projectId: "wm3", title: "Dependent", status: "backlog", blockedBy: [blocker.id] });
  assert.equal(dependent.status, "blocked", "an unmet blocker makes the lifecycle park the issue");
  // `blocked` has no column of its own — it is waiting, not elsewhere.
  assert.equal(work.resolveStateId(dependent, states), defaultStateId("wm3", "todo"));
  const cancelled = await updateIssue(blocker.id, { status: "cancelled" }, { type: "user" });
  assert.equal(cancelled!.status, "cancelled", "the status the engine reads is unchanged");
  assert.equal(work.resolveStateId(cancelled!, states), defaultStateId("wm3", "done"));
});

test("a stored column survives only while its group still matches the status", async () => {
  const states = await makeProject("wm4");
  const review = await work.createWorkflowState({ projectId: "wm4", name: "Code Review", statusGroup: "in_review" });
  const all = [...states, review];
  // A custom column is honoured: two states may share `in_review`.
  assert.equal(work.resolveStateId({ projectId: "wm4", status: "in_review", stateId: review.id }, all), review.id);
  // A stale one is not: the lifecycle moved the issue on without knowing about columns.
  assert.equal(work.resolveStateId({ projectId: "wm4", status: "done", stateId: review.id }, all), defaultStateId("wm4", "done"));
});

test("moving a card into In Progress is refused — only checkout may put work there", async () => {
  await makeProject("wm5");
  const issue = await createIssue({ projectId: "wm5", title: "Manual start", status: "todo" });
  await assert.rejects(
    work.moveIssueToState(issue.id, defaultStateId("wm5", "in_progress")),
    (error: unknown) => error instanceof IssueDomainError && error.code === "invalid_transition",
  );
  const after = await getIssue(issue.id);
  assert.equal(after!.status, "todo", "the refusal leaves the issue where it was");
  assert.equal(after!.stateId, defaultStateId("wm5", "todo"), "and leaves it in its old column");
});

test("a refused transition rolls the card back rather than leaving the board ahead of the engine", async () => {
  await makeProject("wm6");
  // `backlog → done` is not in the transition table: work has to be picked up
  // before it can be finished.
  const issue = await createIssue({ projectId: "wm6", title: "Skip ahead", status: "backlog" });
  await assert.rejects(
    work.moveIssueToState(issue.id, defaultStateId("wm6", "done")),
    (error: unknown) => error instanceof IssueDomainError && error.code === "invalid_transition",
  );
  const after = await getIssue(issue.id);
  assert.equal(after!.status, "backlog");
  assert.equal(after!.stateId, defaultStateId("wm6", "backlog"), "the card did not stay in the column the engine rejected");
});

test("dragging blocked work into Todo is refused while its blockers are unmet", async () => {
  await makeProject("wm6b");
  const blocker = await createIssue({ projectId: "wm6b", title: "Blocker", status: "todo" });
  const dependent = await createIssue({ projectId: "wm6b", title: "Dependent", status: "backlog", blockedBy: [blocker.id] });
  assert.equal(dependent.status, "blocked");
  await assert.rejects(work.moveIssueToState(dependent.id, defaultStateId("wm6b", "todo")));
  assert.equal((await getIssue(dependent.id))!.status, "blocked", "the board cannot talk the scheduler into starting blocked work");
});

test("moving a card across groups asks the lifecycle for the transition", async () => {
  await makeProject("wm7");
  const issue = await createIssue({ projectId: "wm7", title: "Promote me", status: "backlog" });
  const moved = await work.moveIssueToState(issue.id, defaultStateId("wm7", "todo"), { type: "user" });
  assert.equal(moved!.status, "todo", "the engine now sees the work as ready");
  assert.equal(moved!.stateId, defaultStateId("wm7", "todo"));
});

test("reordering inside a column writes only the sequence", async () => {
  await makeProject("wm8");
  const issue = await createIssue({ projectId: "wm8", title: "Reorder", status: "todo" });
  const moved = await work.moveIssueToState(issue.id, defaultStateId("wm8", "todo"), { type: "user" }, 1.5);
  assert.equal(moved!.status, "todo");
  assert.equal(moved!.sequence, 1.5);
});

test("a column still holding work cannot be deleted", async () => {
  await makeProject("wm9");
  const state = await work.createWorkflowState({ projectId: "wm9", name: "QA", statusGroup: "in_review" });
  await work.deleteWorkflowState(state.id);
  assert.equal((await work.listWorkflowStates("wm9")).find((s) => s.name === "QA"), undefined);

  const occupied = await work.createWorkflowState({ projectId: "wm9", name: "QA2", statusGroup: "backlog" });
  const issue = await createIssue({ projectId: "wm9", title: "Sits in QA2", status: "backlog", stateId: occupied.id });
  assert.equal(issue.stateId, occupied.id);
  await assert.rejects(work.deleteWorkflowState(occupied.id), (error: unknown) => error instanceof IssueDomainError && error.code === "conflict");
});

test("a state cannot claim a status group the engine does not have", async () => {
  await makeProject("wm10");
  await assert.rejects(
    work.createWorkflowState({ projectId: "wm10", name: "Vibes", statusGroup: "shipping" }),
    (error: unknown) => error instanceof IssueDomainError && error.code === "validation",
  );
});

test("labels round-trip through the issue projection", async () => {
  await makeProject("wm11");
  const bug = await work.createLabel({ projectId: "wm11", name: "bug", color: "#ef4444" });
  const chore = await work.createLabel({ projectId: "wm11", name: "chore" });
  const issue = await createIssue({ projectId: "wm11", title: "Labelled", status: "backlog" });
  await work.setIssueLabels(issue.id, [bug.id, chore.id, bug.id]);
  const hydrated = await getIssue(issue.id);
  assert.deepEqual([...hydrated!.labelIds].sort(), [bug.id, chore.id].sort(), "duplicates collapse");
  await work.setIssueLabels(issue.id, [chore.id]);
  assert.deepEqual((await getIssue(issue.id))!.labelIds, [chore.id], "setting labels replaces rather than appends");
});

test("deleting a label detaches it from its issues", async () => {
  await makeProject("wm12");
  const label = await work.createLabel({ projectId: "wm12", name: "temp" });
  const issue = await createIssue({ projectId: "wm12", title: "Tagged", status: "backlog" });
  await work.setIssueLabels(issue.id, [label.id]);
  await work.deleteLabel(label.id);
  assert.deepEqual((await getIssue(issue.id))!.labelIds, []);
});

test("modules and cycles attach to issues and detach when removed", async () => {
  await makeProject("wm13");
  const cycle = await work.createCycle({ projectId: "wm13", name: "Sprint 1", startDate: 1000, endDate: 2000 });
  const workModule = await work.createModule({ projectId: "wm13", name: "Billing" });
  const issue = await createIssue({ projectId: "wm13", title: "Scoped", status: "backlog", cycleId: cycle.id });
  await work.setIssueModules(issue.id, [workModule.id]);

  const hydrated = await getIssue(issue.id);
  assert.equal(hydrated!.cycleId, cycle.id);
  assert.deepEqual(hydrated!.moduleIds, [workModule.id]);
  assert.deepEqual(await work.moduleIssueIds(workModule.id), [issue.id]);

  // Deleting the container must not delete the work inside it.
  await work.deleteCycle(cycle.id);
  await work.deleteModule(workModule.id);
  const orphaned = await getIssue(issue.id);
  assert.ok(orphaned, "the issue outlives its cycle and module");
  assert.equal(orphaned!.cycleId, null);
  assert.deepEqual(orphaned!.moduleIds, []);
});

test("a cycle cannot end before it starts", async () => {
  await makeProject("wm14");
  await assert.rejects(
    work.createCycle({ projectId: "wm14", name: "Backwards", startDate: 2000, endDate: 1000 }),
    (error: unknown) => error instanceof IssueDomainError && error.code === "validation",
  );
});

test("relations are symmetric, self-links are refused, and cross-project links are refused", async () => {
  await makeProject("wm15");
  await makeProject("wm16");
  const a = await createIssue({ projectId: "wm15", title: "A", status: "backlog" });
  const b = await createIssue({ projectId: "wm15", title: "B", status: "backlog" });
  const foreign = await createIssue({ projectId: "wm16", title: "Elsewhere", status: "backlog" });

  await work.addIssueRelation(a.id, b.id, "relates_to");
  assert.deepEqual((await work.issueRelationsOf(b.id)).map((r) => r.relatedIssueId), [a.id], "either side sees the link");
  await work.addIssueRelation(a.id, b.id, "relates_to");
  assert.equal((await work.issueRelationsOf(a.id)).length, 1, "adding twice does not duplicate");

  await assert.rejects(work.addIssueRelation(a.id, a.id, "relates_to"), (error: unknown) => error instanceof IssueDomainError && error.code === "validation");
  await assert.rejects(work.addIssueRelation(a.id, foreign.id, "duplicate"), (error: unknown) => error instanceof IssueDomainError && error.code === "forbidden");

  await work.removeIssueRelation(a.id, b.id, "relates_to");
  assert.deepEqual(await work.issueRelationsOf(b.id), [], "removal clears both directions");
});

test("saving a view under an existing name replaces its config instead of erroring", async () => {
  await makeProject("wm17");
  await work.saveView({ projectId: "wm17", name: "My board", config: { layout: "board" } });
  await work.saveView({ projectId: "wm17", name: "My board", config: { layout: "list" } });
  const views = await work.listSavedViews("wm17");
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].config, { layout: "list" });
});

test("editing a page appends a revision rather than overwriting history", async () => {
  await makeProject("wm18");
  const page = await work.createPage({ projectId: "wm18", title: "Spec", body: "first" });
  await work.updatePage(page.id, { body: "second" });
  const loaded = await work.getPage(page.id);
  assert.equal(loaded!.body, "second");
  assert.equal(loaded!.revision, 2, "the first draft is still in document_revisions");

  const db = await getDatabase();
  const revisions = db.read((d) => d.select().from(schema.documentRevisions).all()).filter((r) => r.documentId === page.documentId);
  assert.deepEqual(revisions.map((r) => r.body).sort(), ["first", "second"]);
});

test("an untitled page still gets a title, and renaming leaves the body alone", async () => {
  await makeProject("wm19");
  const page = await work.createPage({ projectId: "wm19", title: "   ", body: "notes" });
  assert.equal(page.title, "Untitled");
  await work.updatePage(page.id, { title: "Notes" });
  const loaded = await work.getPage(page.id);
  assert.equal(loaded!.title, "Notes");
  assert.equal(loaded!.body, "notes");
  assert.equal(loaded!.revision, 1, "a rename is not a new draft");
});

test("deleting an issue takes its labels and module links with it", async () => {
  await makeProject("wm20");
  const label = await work.createLabel({ projectId: "wm20", name: "x" });
  const workModule = await work.createModule({ projectId: "wm20", name: "M" });
  const issue = await createIssue({ projectId: "wm20", title: "Doomed", status: "backlog" });
  await work.setIssueLabels(issue.id, [label.id]);
  await work.setIssueModules(issue.id, [workModule.id]);

  const db = await getDatabase();
  await db.write((d) => d.delete(schema.issues).where(eq(schema.issues.id, issue.id)).run());
  assert.deepEqual(db.read((d) => d.select().from(schema.issueLabels).all()).filter((r) => r.issueId === issue.id), []);
  assert.deepEqual(await work.moduleIssueIds(workModule.id), []);
});
