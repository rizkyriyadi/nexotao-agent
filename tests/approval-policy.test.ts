import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { activityLog, approvals, projects } from "../lib/db/schema";
import { describeToolAction, evaluateExecutionPolicy, resolveExecutionApproval, modeToPolicy, modeSystemDirective } from "../lib/execution-policy";
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

test("agent (auto) mode auto-approves edits but still gates destructive actions", () => {
  const edit = describeToolAction("edit_file", { path: "src/app.ts", old_str: "a", new_str: "b" });
  const runCmd = describeToolAction("bash", { command: "npm test" });
  const destructive = describeToolAction("bash", { command: "rm -rf ./build" });
  // Auto mode: file edits and ordinary commands run without a prompt…
  assert.equal(evaluateExecutionPolicy(modeToPolicy("agent"), edit), "allow");
  assert.equal(evaluateExecutionPolicy(modeToPolicy("agent"), runCmd), "allow");
  // …but a destructive command is still escalated to an approval prompt.
  assert.equal(evaluateExecutionPolicy(modeToPolicy("agent"), destructive), "ask");
});

test("agent mode runs routine repo commands without a prompt, gates catastrophic ones", () => {
  const auto = modeToPolicy("agent");
  // The "pull repo" sync flow from the field report: composed git command that
  // fast-forwards a checkout to upstream via `git reset --hard`. Routine —
  // should run without an approval prompt in Agent mode.
  const pull = describeToolAction("bash", {
    command: 'git remote add upstream https://github.com/acme/repo.git && git fetch upstream && git reset --hard "upstream/main" && git status --short --branch',
  });
  assert.equal(pull.action, "exec");
  assert.equal(pull.risk, "high"); // still flagged in the audit trail…
  assert.equal(evaluateExecutionPolicy(auto, pull), "allow"); // …but not gated.
  assert.equal(evaluateExecutionPolicy(auto, describeToolAction("bash", { command: "git clean -fd" })), "allow");

  // Catastrophic, out-of-tree commands stay gated even in Agent mode.
  for (const command of ["rm -rf ./build", "sudo shutdown -h now", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda"]) {
    const details = describeToolAction("bash", { command });
    assert.equal(details.action, "destructive", command);
    assert.equal(evaluateExecutionPolicy(auto, details), "ask", command);
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
