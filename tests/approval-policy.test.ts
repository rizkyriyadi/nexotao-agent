import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { activityLog, approvals, projects } from "../lib/db/schema";
import { describeToolAction, evaluateExecutionPolicy, expireInvalidExecutionApprovals, resolveExecutionApproval, modeToPolicy, modeSystemDirective } from "../lib/execution-policy";
import { createRun } from "../lib/run-manager";

test("shared policy covers network, destructive, and unknown bypass attempts", () => {
  assert.equal(describeToolAction("web_fetch", { url: "https://example.test" }).action, "network");
  assert.equal(describeToolAction("bash", { command: "rm -rf ./build" }).action, "destructive");
  const unknown = describeToolAction("custom_shell_handler", { command: "whoami" });
  assert.equal(unknown.risk, "high");
  assert.equal(evaluateExecutionPolicy("ask", unknown), "ask");
  assert.equal(evaluateExecutionPolicy("deny", describeToolAction("read_file", { path: "README.md" })), "allow");
});

test("run modes map to the expected execution policy", () => {
  assert.equal(modeToPolicy("agent"), "allow");
  assert.equal(modeToPolicy("plan"), "deny");
  assert.equal(modeToPolicy("ask"), "deny");
});

/* Agent mode does not stop and ask. These are agents: a run that halts halfway
 * to wait for a click nobody is watching for is a worse outcome than the command
 * it was worried about, and the user already has the control they need — Ask and
 * Plan mode, chosen per run, deny every mutation outright. The classification
 * survives (a destructive command is still recorded as destructive and high
 * risk, so the audit trail reads the same); only the interruption is gone. */
test("agent mode runs without prompting, including destructive commands", () => {
  const auto = modeToPolicy("agent");
  const edit = describeToolAction("edit_file", { path: "src/app.ts", old_str: "a", new_str: "b" });
  assert.equal(evaluateExecutionPolicy(auto, edit), "allow");
  assert.equal(evaluateExecutionPolicy(auto, describeToolAction("bash", { command: "npm test" })), "allow");

  // The "pull repo" sync flow from the field report: composed git command that
  // fast-forwards a checkout to upstream via `git reset --hard`.
  const pull = describeToolAction("bash", {
    command: 'git remote add upstream https://github.com/acme/repo.git && git fetch upstream && git reset --hard "upstream/main" && git status --short --branch',
  });
  assert.equal(pull.action, "exec");
  assert.equal(pull.risk, "high"); // still flagged in the audit trail…
  assert.equal(evaluateExecutionPolicy(auto, pull), "allow"); // …but not gated.
  assert.equal(evaluateExecutionPolicy(auto, describeToolAction("bash", { command: "git clean -fd" })), "allow");

  for (const command of ["rm -rf ./build", "sudo shutdown -h now", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda"]) {
    const details = describeToolAction("bash", { command });
    // Still named for what it is — the audit trail and the previews rely on it…
    assert.equal(details.action, "destructive", command);
    assert.equal(details.risk, "high", command);
    // …and it runs, because that is what Agent mode means.
    assert.equal(evaluateExecutionPolicy(auto, details), "allow", command);
    // Ask and Plan are the opt-out, and they refuse the same command outright.
    assert.equal(evaluateExecutionPolicy(modeToPolicy("ask"), details), "deny", command);
    assert.equal(evaluateExecutionPolicy(modeToPolicy("plan"), details), "deny", command);
  }
});

test("plan and ask modes deny every mutation while allowing read-only tools", () => {
  const edit = describeToolAction("write_file", { path: "x.ts", content: "y" });
  const read = describeToolAction("read_file", { path: "README.md" });
  for (const mode of ["plan", "ask"] as const) {
    assert.equal(evaluateExecutionPolicy(modeToPolicy(mode), edit), "deny");
    assert.equal(evaluateExecutionPolicy(modeToPolicy(mode), read), "allow");
  }
  assert.match(modeSystemDirective("plan"), /PLAN MODE/);
  assert.match(modeSystemDirective("ask"), /ASK MODE/);
  assert.equal(modeSystemDirective("agent"), "");
});

/* ── read-only means every read-only tool ───────────────────────────────────
 * Plan and Ask deny mutations by denying everything that is not classified as a
 * read. Two families of tool that change nothing were missing that
 * classification, so the run was denied the tools its own system prompt had just
 * told it to use — which the user saw as a red "Denied" chip on the first line
 * of a run that had not done anything wrong. */

test("the graph tools are reads, so a plan run may consult the graph", () => {
  // baseSystem tells every agent to call graph_query *before* reading files.
  for (const name of ["graph_query", "graph_path", "graph_explain"]) {
    const details = describeToolAction(name, { question: "how does billing work" });
    assert.equal(details.action, "read", name);
    assert.equal(details.risk, "low", name);
    for (const mode of ["plan", "ask"] as const) {
      assert.equal(evaluateExecutionPolicy(modeToPolicy(mode), details), "allow", `${name} in ${mode}`);
    }
  }
  // An unknown tool still falls through to the guarded default — the check above
  // must not have opened a hole for anything that merely looks read-ish.
  assert.equal(describeToolAction("graphify_delete_everything".replace("graph", "xgraph"), {}).action, "exec");
});

test("looking something up is allowed in ask mode, which promises it", () => {
  // ASK MODE's directive names web_search and web_fetch outright.
  assert.match(modeSystemDirective("ask"), /web_search/);
  for (const name of ["web_search", "web_fetch"]) {
    const details = describeToolAction(name, { query: "q", url: "https://example.test" });
    assert.equal(details.action, "network", name);
    assert.equal(evaluateExecutionPolicy(modeToPolicy("ask"), details), "allow", name);
  }
  // Reaching the network still changes nothing on disk, so the mutation ban is
  // untouched: a write in the same mode is still refused.
  assert.equal(evaluateExecutionPolicy(modeToPolicy("ask"), describeToolAction("write_file", { path: "x", content: "y" })), "deny");
  // And "ask" the *policy* (approve-each-call) still prompts rather than allows.
  assert.equal(evaluateExecutionPolicy("ask", describeToolAction("web_fetch", { url: "https://example.test" })), "ask");
});

test("approval previews redact secrets", () => {
  const secret = "sk-verysecretvalue123";
  const details = describeToolAction("bash", { command: `curl -H 'Authorization: Bearer ${secret}' https://example.test` });
  assert.doesNotMatch(details.preview, /verysecretvalue123/);
  assert.match(details.preview, /REDACTED/);
});

test("approval resolution is persistent, idempotent, and resumes once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-approval-test-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  try {
    await database.write((db) => db.insert(projects).values({ id: "p", name: "P", path: dir, mode: "single", agentSpecs: [], createdAt: 1 }).run());
    const repositories = new ControlPlaneRepositories(database);
    const run = createRun("run-active", undefined, { projectId: "p" });
    const approval = await repositories.createApproval({
      type: "execution", projectId: "p", issueId: null, runId: run.id, toolCallId: "tool-1", action: "exec", target: "npm test",
      risk: "medium", preview: "npm test", payload: {}, status: "pending", expiresAt: Date.now() + 60_000,
    });
    const waiting = run.awaitApproval("tool-1");
    const first = await resolveExecutionApproval({ approvalId: approval.id, decision: "allow" }, database);
    const second = await resolveExecutionApproval({ approvalId: approval.id, decision: "deny" }, database);
    assert.equal(first.state, "resolved");
    assert.equal(second.state, "already_resolved");
    assert.equal(await waiting, "allow");
    assert.equal(database.read((db) => db.select().from(approvals).where(eq(approvals.id, approval.id)).get())?.status, "approved");
    assert.equal(database.read((db) => db.select().from(activityLog).where(eq(activityLog.entityId, approval.id)).all()).filter((row) => row.action === "approval.approved").length, 1);

    const late = await repositories.createApproval({
      type: "execution", projectId: "p", issueId: null, runId: "missing-after-restart", toolCallId: "tool-2", action: "write", target: "x",
      risk: "medium", preview: "x", payload: {}, status: "pending", expiresAt: Date.now() + 60_000,
    });
    assert.equal((await resolveExecutionApproval({ approvalId: late.id, decision: "allow" }, database)).state, "expired");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The sweep is named for execution approvals and must stay scoped to them. A
// plan approval carries no runId, so a sweep over every pending row expired it
// on the first inbox load and the non-execution decision path never saw one.
test("expiring stale execution approvals leaves non-execution approvals pending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-approval-scope-"));
  const database = await openDatabase(path.join(dir, "db.sqlite"), { migrateJson: false });
  try {
    await database.write((db) => db.insert(projects).values({ id: "p", name: "P", path: dir, mode: "single", agentSpecs: [], createdAt: 1 }).run());
    const repositories = new ControlPlaneRepositories(database);
    const plan = await repositories.createApproval({
      type: "plan", projectId: "p", issueId: null, payload: { summary: "Approve the rollout" }, status: "pending",
    });
    const orphaned = await repositories.createApproval({
      type: "execution", projectId: "p", issueId: null, runId: "gone-after-restart", toolCallId: "tool-1",
      action: "exec", target: "npm test", risk: "medium", preview: "npm test", payload: {}, status: "pending",
    });

    assert.equal(await expireInvalidExecutionApprovals("p", database), 1);
    const statusOf = (id: string) => database.read((db) => db.select().from(approvals).where(eq(approvals.id, id)).get())?.status;
    assert.equal(statusOf(orphaned.id), "expired");
    assert.equal(statusOf(plan.id), "pending");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
