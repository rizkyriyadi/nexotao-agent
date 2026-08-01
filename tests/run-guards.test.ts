import test from "node:test";
import assert from "node:assert/strict";
import { agentWriteGuard, isProhibitedAgentMarkdown } from "../lib/run-guards";

const guard = agentWriteGuard();

test("an agent may commit and push", async () => {
  // The deliberate inversion of the old rule. Runs work in the user's own
  // folder now, and a tool that can rewrite every file but not record the
  // result is a strange half-thing. There is no "verified integration flow"
  // left for commits to be restricted to.
  await guard({ name: "bash", input: { command: "git commit -m 'feat: add a thing'" } });
  await guard({ name: "bash", input: { command: "git push origin main" } });
  await guard({ name: "bash", input: { command: "git add -A && git commit --amend --no-edit && git push -f" } });
});

test("agent instruction Markdown still cannot be written by a run", async () => {
  for (const file of ["CLAUDE.md", "AGENTS.md", "agent.md", "codex.md", ".claude/settings.md", ".agents/lead.md", "nested/deep/AGENTS.md"]) {
    await assert.rejects(
      guard({ name: "write_file", input: { path: file } }),
      /local-only/,
      `${file} must be refused`,
    );
    await assert.rejects(guard({ name: "edit_file", input: { path: file } }), /local-only/);
  }
});

test("a user's own Markdown is theirs to write", async () => {
  // Every one of these tripped the substring rule this list replaced.
  for (const file of [
    "docs/instructions.md", "travel-agent.md", "blog/prompt-engineering.md", "RUNBOOK.md",
    ".claude/kb/guides/testing.md", "README.md", "src/agents/overview.md",
  ]) {
    await guard({ name: "write_file", input: { path: file } });
  }
});

test("the ban is on Markdown, not on every file in an agent directory", async () => {
  await guard({ name: "write_file", input: { path: ".claude/settings.json" } });
  assert.equal(isProhibitedAgentMarkdown(".claude/settings.json"), false);
  assert.equal(isProhibitedAgentMarkdown("agents.txt"), false);
});

test("a missing or odd path is not a crash", async () => {
  await guard({ name: "write_file", input: {} });
  await guard({ name: "write_file", input: null });
  await guard({ name: "read_file", input: { path: "CLAUDE.md" } });
  // Windows separators reach the guard verbatim from some tool payloads.
  await assert.rejects(guard({ name: "write_file", input: { path: ".claude\\rules.md" } }), /local-only/);
});
