import { and, desc, eq, inArray, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/db/database";
import { expireInvalidExecutionApprovals } from "@/lib/execution-policy";
import { selectAttentionRuns } from "@/lib/inbox-signal";
import { agents, approvals, heartbeatRuns, issues, runRecords } from "@/lib/db/schema";
import { getActiveProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ approvals: [], issues: [], runs: [] });
  const database = await getDatabase();
  await expireInvalidExecutionApprovals(project.id, database);
  const now = Date.now();
  const data = database.read((db) => {
    const projectIssues = db.select().from(issues).where(eq(issues.projectId, project.id)).all();
    const issueById = new Map(projectIssues.map((issue) => [issue.id, issue]));
    const projectAgents = db.select().from(agents).where(eq(agents.projectId, project.id)).all();
    const agentIds = projectAgents.map((agent) => agent.id);
    const pending = db.select().from(approvals).where(and(eq(approvals.projectId, project.id), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)).all();
    const relevantRuns = agentIds.length
      ? db.select().from(heartbeatRuns).where(and(inArray(heartbeatRuns.agentId, agentIds), or(eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.status, "waiting")))).orderBy(desc(heartbeatRuns.startedAt)).all()
      : [];
    const legacyRuns = db.select().from(runRecords).where(eq(runRecords.projectId, project.id)).orderBy(desc(runRecords.updatedAt)).all();
    return {
      approvals: pending.map((approval) => ({
        id: approval.id, action: approval.action, target: approval.target, risk: approval.risk, preview: approval.preview,
        runId: approval.runId, issueId: approval.issueId, createdAt: approval.createdAt,
        issue: approval.issueId ? issueById.get(approval.issueId)?.identifier ?? null : null,
        href: approval.issueId ? `/board/${approval.issueId}` : `/inbox?approval=${approval.id}`,
      })),
      issues: projectIssues.filter((issue) => issue.status === "blocked" || issue.status === "in_review").map((issue) => ({
        id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status, priority: issue.priority,
        updatedAt: issue.updatedAt, href: `/board/${issue.id}`,
      })),
      runs: selectAttentionRuns({ now, heartbeats: relevantRuns, records: legacyRuns }),
    };
  });
  return NextResponse.json(data);
}
