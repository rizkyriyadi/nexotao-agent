import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import {
  approvals, costEvents, documentRevisions, heartbeatRuns, issueDocuments,
} from "@/lib/db/schema";
import { createIssue, getIssue, listAgents, listIssues } from "@/lib/issues";
import { getActiveProject } from "@/lib/store";

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
  const runIds = runs.map((run) => run.id);
  const usage = runIds.length
    ? database.read((db) => db.select().from(costEvents).where(inArray(costEvents.runId, runIds)).orderBy(asc(costEvents.createdAt)).all())
    : [];
  const branch = await fs.readFile(path.join(project.path, ".git", "HEAD"), "utf8")
    .then((head) => head.trim().replace(/^ref: refs\/heads\//, ""))
    .catch(() => null);

  return NextResponse.json({
    issue,
    project: { id: project.id, name: project.name, path: project.path, branch },
    agents,
    issues: allIssues,
    children: allIssues.filter((candidate) => candidate.parentId === id),
    blockedBy: allIssues.filter((candidate) => issue.blockedBy.includes(candidate.id)),
    blocking: allIssues.filter((candidate) => candidate.blockedBy.includes(id)),
    comments,
    documents,
    approvals: approvalRows,
    runs,
    activity,
    usage,
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

  if (body.action === "approval" && typeof body.approvalId === "string" && (body.decision === "approved" || body.decision === "rejected")) {
    const updated = await database.write((db) => {
      const current = db.select().from(approvals).where(and(eq(approvals.id, body.approvalId as string), eq(approvals.issueId, id))).get();
      if (!current || current.status !== "pending") return null;
      db.update(approvals).set({
        status: body.decision as string,
        decisionNote: typeof body.note === "string" ? body.note : null,
        decidedAt: Date.now(),
      }).where(eq(approvals.id, current.id)).run();
      return db.select().from(approvals).where(eq(approvals.id, current.id)).get();
    });
    if (!updated) return NextResponse.json({ error: "Approval is no longer pending" }, { status: 409 });
    return NextResponse.json({ approval: updated });
  }

  return NextResponse.json({ error: "Unsupported issue action" }, { status: 400 });
}
