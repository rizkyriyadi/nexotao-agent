import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/lib/db/database";
import { resolveExecutionApproval } from "@/lib/execution-policy";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import {
  approvals, documentRevisions, heartbeatRuns, issueDocuments,
} from "@/lib/db/schema";
import { createIssue, getIssue, listAgents, listIssues } from "@/lib/issues";
import { getActiveProject } from "@/lib/store";
import { readPendingWakeups, resolveBlockedAttention } from "@/lib/blocker-attention-source";
import { changedSince } from "@/lib/run-snapshot";
import { expandHome } from "@/lib/paths";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const [project, issue] = await Promise.all([getActiveProject(), getIssue(id)]);
  if (!project || !issue || issue.projectId !== project.id) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  const database = await getDatabase();
  const repositories = new ControlPlaneRepositories(database);
  const [agents, allIssues] = await Promise.all([listAgents(project.id), listIssues(project.id)]);
  const comments = repositories.listComments(id);
  const approvalRows = repositories.listApprovals(id);
  const activity = repositories.listActivity("issue", id);
  const runs = database.read((db) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, id)).orderBy(desc(heartbeatRuns.startedAt)).all());
  const links = database.read((db) => db.select().from(issueDocuments).where(eq(issueDocuments.issueId, id)).all());
  const documents = database.read((db) => links.map((link) => {
    const revision = db.select().from(documentRevisions).where(eq(documentRevisions.documentId, link.documentId)).orderBy(desc(documentRevisions.revision)).get();
    return { key: link.key, ...revision };
  }));
  const branch = await fs.readFile(path.join(project.path, ".git", "HEAD"), "utf8")
    .then((head) => head.trim().replace(/^ref: refs\/heads\//, ""))
    .catch(() => null);

  // Whether this task's blocked-ness is healthy, and if not, who moves it next.
  // Computed server-side so every surface tells the same story.
  const blockedAttention = resolveBlockedAttention(
    id, allIssues, agents, readPendingWakeups(database, allIssues.map((candidate) => candidate.id)),
  );

  // A count, not the diff. This response is polled every couple of seconds and
  // a hundred files of before-and-after text has no business riding along with
  // it; the panel fetches the real diff from `/changes` when it is opened.
  //
  // Sent whatever the status is. A task in `auto` mode finishes as `done` and
  // still has changes to show and revert, and `in_review` is also where a run
  // that merely ran out of steps lands, with nothing to decide at all — so the
  // client must never infer one from the other.
  const snapshotRun = repositories.latestSnapshotForIssue(id);
  const changes = snapshotRun?.snapshotCommit
    ? await changedSince(expandHome(project.path), snapshotRun.snapshotCommit, snapshotRun.id)
      .then((files) => ({ available: true, fileCount: files.length, runId: snapshotRun.id }))
      .catch(() => ({ available: false, fileCount: 0, runId: snapshotRun.id }))
    : null;

  return NextResponse.json({
    issue,
    changes,
    project: { id: project.id, name: project.name, path: project.path, branch },
    agents,
    issues: allIssues,
    blockedAttention,
    children: allIssues.filter((candidate) => candidate.parentId === id),
    blockedBy: allIssues.filter((candidate) => issue.blockedBy.includes(candidate.id)),
    blocking: allIssues.filter((candidate) => candidate.blockedBy.includes(id)),
    comments,
    documents,
    approvals: approvalRows,
    runs,
    activity,
  });
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const issue = await getIssue(id);
  if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const database = await getDatabase();
  const repositories = new ControlPlaneRepositories(database);

  if (body.action === "comment" && typeof body.body === "string" && body.body.trim()) {
    const comment = await repositories.addComment({ issueId: id, authorType: "user", body: body.body.trim() });
    return NextResponse.json({ comment }, { status: 201 });
  }

  if (body.action === "document" && typeof body.key === "string" && typeof body.body === "string") {
    const revision = await repositories.putDocument({ issueId: id, key: body.key, body: body.body, createdByType: "user" });
    return NextResponse.json({ revision }, { status: 201 });
  }

  if (body.action === "child" && typeof body.title === "string" && body.title.trim()) {
    const child = await createIssue({
      projectId: issue.projectId,
      parentId: issue.id,
      title: body.title.trim(),
      assigneeAgentId: typeof body.assigneeAgentId === "string" ? body.assigneeAgentId : null,
      priority: typeof body.priority === "string" ? body.priority : "medium",
      status: "backlog",
      actor: { type: "user" },
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    });
    return NextResponse.json({ child }, { status: 201 });
  }

  // Keep / Revert / Revert & retry live at `/changes`, next to the diff they act
  // on. They used to be here as `approve` / `request-changes`, back when the
  // decision was about a commit waiting to land rather than files already in the
  // user's folder.

  if (body.action === "approval" && typeof body.approvalId === "string" && (body.decision === "approved" || body.decision === "rejected")) {
    const current = database.read((db) => db.select().from(approvals).where(and(eq(approvals.id, body.approvalId as string), eq(approvals.issueId, id))).get());
    if (!current) return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    if (current.type === "execution") {
      const result = await resolveExecutionApproval({
        approvalId: current.id, decision: body.decision === "approved" ? "allow" : "deny",
        note: typeof body.note === "string" ? body.note : undefined,
      }, database);
      if (result.state === "expired") return NextResponse.json({ error: "Run is no longer waiting" }, { status: 409 });
      return NextResponse.json({ approval: result.approval, idempotent: result.state === "already_resolved" });
    }
    const updated = await database.write((db) => {
      const pending = db.select().from(approvals).where(eq(approvals.id, current.id)).get();
      if (!pending || pending.status !== "pending") return pending ?? null;
      db.update(approvals).set({ status: body.decision as string, decisionNote: typeof body.note === "string" ? body.note : null, decidedAt: Date.now() }).where(eq(approvals.id, current.id)).run();
      return db.select().from(approvals).where(eq(approvals.id, current.id)).get();
    });
    return NextResponse.json({ approval: updated, idempotent: current.status !== "pending" });
  }

  return NextResponse.json({ error: "Unsupported issue action" }, { status: 400 });
}
