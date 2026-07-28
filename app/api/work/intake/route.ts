import { NextResponse } from "next/server";
import { listIssues, updateIssue } from "@/lib/issues";
import { HttpError, readJsonObject, stringField } from "@/lib/http";
import { updateIssueWorkFields } from "@/lib/work-model";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/* Triage for work that arrived from outside the board. Intake is off by default —
   an issue only reaches this queue if something set `intakeStatus: "pending"` on
   it — so the existing agent flow, where `delegate` produces work that is ready
   immediately, is unchanged. */

/** What each decision does to the work item. The lifecycle owns `status`, so a
 *  decline is a real `cancelled` transition rather than a flag the scheduler
 *  cannot see; snoozing leaves the item where it is and only clears it from the
 *  queue.
 *
 *  Accepting changes no status at all. A pending item already sits somewhere in
 *  the workflow — intake is a flag beside the status, not a state in front of it
 *  — so accepting one that has reached `in_review` would demote work already
 *  underway, and the lifecycle refuses that move regardless. What accept means
 *  is "this belongs here": the queue clears, the work stays where it got to. */
const DECISIONS = {
  accept: { intakeStatus: "accepted", status: null },
  decline: { intakeStatus: "declined", status: "cancelled" },
  duplicate: { intakeStatus: "duplicate", status: "cancelled" },
  snooze: { intakeStatus: "snoozed", status: null },
} as const;

type Decision = keyof typeof DECISIONS;
const isDecision = (value: string): value is Decision => value in DECISIONS;

export async function GET() {
  try {
    const project = await requireProject();
    const issues = await listIssues(project.id);
    return NextResponse.json({
      pending: issues.filter((issue) => issue.intakeStatus === "pending"),
      // The recently triaged, so a mis-click is visible and reversible rather
      // than vanishing the moment it is decided.
      recent: issues.filter((issue) => issue.intakeStatus && issue.intakeStatus !== "pending")
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20),
    });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const issueId = stringField(body, "issueId", { required: true, max: 100 })!;
    const decision = stringField(body, "decision", { required: true, max: 20 })!;
    if (!isDecision(decision)) throw new HttpError(`Unknown intake decision: ${decision}`);

    const issue = (await listIssues(project.id)).find((candidate) => candidate.id === issueId);
    if (!issue) throw new HttpError("Work item not found", 404);

    const { intakeStatus, status } = DECISIONS[decision];
    // Status first: if the lifecycle refuses the transition, the item stays in the
    // queue rather than being marked triaged with nothing having happened.
    if (status && issue.status !== status) await updateIssue(issueId, { status }, { type: "user" });
    await updateIssueWorkFields(issueId, { intakeStatus });

    const updated = (await listIssues(project.id)).find((candidate) => candidate.id === issueId);
    return NextResponse.json({ issue: updated });
  } catch (error) { return workError(error); }
}
