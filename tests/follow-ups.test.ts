import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db/database";
import { ControlPlaneRepositories } from "../lib/db/repositories";
import { projects } from "../lib/db/schema";
import { IssueLifecycleService } from "../lib/issue-lifecycle";
import { hasUnansweredFollowUp, openConversation } from "../lib/follow-ups";
import { settledIssueStatus } from "../lib/run-transcript";

/* A task is a conversation, and the thing a conversation must never do is drop
   a message. The run used to decide what it was answering by comparing message
   timestamps against a clock read taken well after it was handed the task, so
   anything that landed in between belonged to neither side: not in the prompt,
   not counted as waiting. These tests pin the two halves of the fix — the run
   answers a named set of messages, and anything outside that set reopens the
   task no matter how the run ended. */

const ISSUE = { title: "Add search", detail: "Add search to the sidebar", summary: "Added it." };

test("a run answers the messages it was given, by name and in order", () => {
  const { messages, answered } = openConversation(ISSUE, [
    { id: "c2", authorType: "user", body: "make it fuzzy", createdAt: 20 },
    { id: "c1", authorType: "user", body: "and case-insensitive", createdAt: 10 },
    { id: "c3", authorType: "agent", body: "working on it", createdAt: 15 },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "Add search to the sidebar" },
    // The previous run's answer, so the agent continues rather than restarts.
    { role: "assistant", content: "Added it." },
    { role: "user", content: "and case-insensitive" },
    { role: "user", content: "make it fuzzy" },
  ]);
  assert.deepEqual([...answered].sort(), ["c1", "c2"], "the agent's own comments are not messages it owes a reply to");
});

test("a task with no follow-ups is just the request", () => {
  const { messages, answered } = openConversation(ISSUE, []);
  assert.deepEqual(messages, [{ role: "user", content: "Add search to the sidebar" }]);
  assert.equal(answered.size, 0);
  assert.equal(hasUnansweredFollowUp([], answered), false);
});

test("a message the run never saw is owed a reply, whenever it arrived", () => {
  const early = { id: "c1", authorType: "user", body: "one", createdAt: 10 };
  const { answered } = openConversation(ISSUE, [early]);

  // The regression this replaces: `late` is newer than the prompt but older
  // than the clock read the old check used, so it counted as neither.
  const late = { id: "c2", authorType: "user", body: "two", createdAt: 11 };
  assert.equal(hasUnansweredFollowUp([early, late], answered), true);
  assert.equal(hasUnansweredFollowUp([early], answered), false);

  // Identity, not time: a message stamped *before* the prompt was built still
  // reopens the task if the prompt did not contain it. Two writers on one
  // clock make this reachable, and "impossible" is not a guarantee worth
  // resting a lost message on.
  assert.equal(hasUnansweredFollowUp([early, { ...late, createdAt: 1 }], answered), true);

  // An agent posting to the thread is not a question, and must not requeue.
  assert.equal(hasUnansweredFollowUp([early, { id: "c3", authorType: "agent", body: "done", createdAt: 12 }], answered), false);
});

test("a follow-up that arrived during a run that then failed is not lost", () => {
  // The run failed, so the task goes to review either way — but the message is
  // still unanswered, and the executor used to hardcode `requeue: false` on
  // this path, leaving the follow-up in a thread nothing would ever read again.
  assert.equal(settledIssueStatus({ ok: false, truncated: false, requeue: true }), "in_review");
  assert.equal(settledIssueStatus({ ok: true, truncated: false, requeue: true }), "todo");
});

/* ── the last window: a message that lands as the run is writing its result ─ */

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-follow-up-"));
  const database = await openDatabase(path.join(dir, "nexotao.sqlite"), { migrateJson: false });
  await database.write((db) => db.insert(projects).values({ id: "p", name: "Chat", path: dir, createdAt: 1 }).run());
  const repositories = new ControlPlaneRepositories(database);
  await repositories.agents.insert({ id: "a", projectId: "p", name: "Agent", role: "lead", scope: "x", createdAt: 2, updatedAt: 2 });
  await repositories.issues.insert({ id: "i", projectId: "p", identifier: "NX-1", title: "Task", status: "todo", assigneeAgentId: "a", createdAt: 3, updatedAt: 3 });
  return { dir, database, repositories, lifecycle: new IssueLifecycleService(database) };
}

test("a message that lands after the run stops looking still reopens the finished task", async () => {
  const f = await fixture();
  try {
    await f.repositories.checkoutIssue("i", "a", "run-1");
    const { answered } = openConversation({ title: "Task" }, f.repositories.listComments("i"));

    // The message arrives while the run is settling: too late for the check,
    // early enough that `reopen` still sees `in_progress` and defers to a run
    // that has already made up its mind.
    await f.repositories.addComment({ issueId: "i", authorType: "user", body: "one more thing" });
    const deferred = await f.lifecycle.reopen("i", { type: "user" });
    assert.equal(deferred.status, "in_progress", "reopen leaves a live run alone — which is what makes the sweep below necessary");

    // The run closes the task out as done…
    await f.lifecycle.transition("i", "done", { type: "agent", id: "a", runId: "run-1" });
    // …then looks once more, now that a reopen would stick.
    assert.equal(hasUnansweredFollowUp(f.repositories.listComments("i"), answered), true);
    const reopened = await f.lifecycle.reopen("i", { type: "system", runId: "run-1" });
    assert.equal(reopened.status, "todo", "the task is runnable again instead of sitting done with an unread message");
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.checkoutRunId, null, "and is free for the next run to claim");
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a finished task with nothing waiting stays finished", async () => {
  const f = await fixture();
  try {
    await f.repositories.addComment({ issueId: "i", authorType: "user", body: "please do it" });
    await f.repositories.checkoutIssue("i", "a", "run-1");
    const { answered, messages } = openConversation({ title: "Task" }, f.repositories.listComments("i"));
    assert.equal(messages.length, 2, "the follow-up is in the prompt");

    await f.lifecycle.transition("i", "done", { type: "agent", id: "a", runId: "run-1" });
    // Nothing arrived that this run did not already answer, so no sweep fires
    // and the task is not bounced back to todo in an endless loop.
    assert.equal(hasUnansweredFollowUp(f.repositories.listComments("i"), answered), false);
    assert.equal(f.repositories.issues.get("i")?.status, "done");
  } finally {
    await f.database.close();
    await rm(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
