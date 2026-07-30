import { NextResponse } from "next/server";
import { listAgents, createIssue, updateIssue, listIssues, seedAgents } from "@/lib/issues";
import { tick } from "@/lib/executor";
import { HttpError, numberField, readJsonObject, stringField, stringsField } from "@/lib/http";
import {
  ensureWorkflowStates, listCycles, listLabels, listModules, moveIssueToState,
  setIssueLabels, setIssueModules, updateIssueWorkFields,
} from "@/lib/work-model";
import { buildView } from "@/lib/work-view";
import { parseViewConfig, requireProject, workError } from "../shared";

export const runtime = "nodejs";

/** Everything the work surface needs to render, in one request: the grouped view
 *  plus the vocabularies its pickers offer. Sent together because the board is
 *  useless without its columns, and four round-trips to draw one screen is four
 *  chances to render a half-built board. */
export async function GET(req: Request) {
  try {
    const project = await requireProject();
    const config = parseViewConfig(new URL(req.url).searchParams);
    // Seeded on read as well as on create: a project that predates the migration
    // would otherwise open on a board with no columns to drop onto.
    const [states, issues, labels, cycles, modules] = await Promise.all([
      ensureWorkflowStates(project.id), listIssues(project.id), listLabels(project.id),
      listCycles(project.id), listModules(project.id),
    ]);
    let agents = await listAgents(project.id);
    if (!agents.length) agents = await seedAgents(project.id);
    const view = buildView(issues, config, { states, labels, cycles, modules, agents });
    return NextResponse.json({ projectId: project.id, view, issues, states, labels, cycles, modules, agents });
  } catch (error) { return workError(error); }
}

/** Create a work item by hand. Status defaults to `backlog` rather than `todo`:
 *  a card typed into the board is not yet a request for an agent to start. */
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const labelIds = stringsField(body, "labelIds");
    const moduleIds = stringsField(body, "moduleIds");
    const issue = await createIssue({
      projectId: project.id,
      title: stringField(body, "title", { required: true, max: 500 })!,
      detail: stringField(body, "detail", { max: 100_000 }) ?? "",
      status: "backlog",
      priority: stringField(body, "priority", { max: 20 }) ?? "medium",
      assigneeAgentId: stringField(body, "assigneeAgentId", { max: 100 }) ?? null,
      parentId: stringField(body, "parentId", { max: 100 }) ?? null,
      stateId: stringField(body, "stateId", { max: 200 }) ?? null,
      cycleId: stringField(body, "cycleId", { max: 100 }) ?? null,
      estimatePoint: numberField(body, "estimatePoint", null),
      startDate: numberField(body, "startDate", null),
      targetDate: numberField(body, "targetDate", null),
      sequence: numberField(body, "sequence", null),
      intakeSource: stringField(body, "intakeSource", { max: 20 }) ?? "user",
      idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
      actor: { type: "user" },
    });
    if (labelIds.length) await setIssueLabels(issue.id, labelIds);
    if (moduleIds.length) await setIssueModules(issue.id, moduleIds);
    return NextResponse.json({ issue }, { status: 201 });
  } catch (error) { return workError(error); }
}

/** Edit one work item.
 *
 *  Nothing here writes `status` or `stateId` directly. A column change goes
 *  through `moveIssueToState`, which asks the lifecycle for the transition and
 *  rolls the card back if it is refused; the rest go through `updateIssue`,
 *  which owns assignment and dependencies. Writing the columns straight from
 *  here would give the board a second source of truth and let it show work the
 *  engine never agreed to start. */
export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    const id = stringField(body, "id", { required: true, max: 100 })!;
    const project = await requireProject();
    const actor = { type: "user" as const };

    if (body.stateId !== undefined) {
      const stateId = stringField(body, "stateId", { required: true, max: 200 })!;
      await moveIssueToState(id, stateId, actor, numberField(body, "sequence", null) ?? undefined);
    } else if (body.sequence !== undefined) {
      // A pure reorder inside a column: no transition to ask for.
      await updateIssueWorkFields(id, { sequence: numberField(body, "sequence", null) });
    }

    const lifecyclePatch = {
      ...(body.title !== undefined ? { title: stringField(body, "title", { required: true, max: 500 })! } : {}),
      ...(body.detail !== undefined ? { detail: stringField(body, "detail", { max: 100_000 }) ?? "" } : {}),
      ...(body.priority !== undefined ? { priority: stringField(body, "priority", { max: 20 })! } : {}),
      ...(body.assigneeAgentId !== undefined ? { assigneeAgentId: body.assigneeAgentId === null ? null : stringField(body, "assigneeAgentId", { max: 100 })! } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId === null ? null : stringField(body, "parentId", { max: 100 })! } : {}),
      ...(body.blockedBy !== undefined ? { blockedBy: stringsField(body, "blockedBy") } : {}),
    };
    if (Object.keys(lifecyclePatch).length) await updateIssue(id, lifecyclePatch, actor);

    const workPatch = {
      ...(body.cycleId !== undefined ? { cycleId: body.cycleId === null ? null : stringField(body, "cycleId", { max: 100 })! } : {}),
      ...(body.estimatePoint !== undefined ? { estimatePoint: numberField(body, "estimatePoint", null) } : {}),
      ...(body.startDate !== undefined ? { startDate: numberField(body, "startDate", null) } : {}),
      ...(body.targetDate !== undefined ? { targetDate: numberField(body, "targetDate", null) } : {}),
      ...(body.intakeStatus !== undefined ? { intakeStatus: body.intakeStatus === null ? null : stringField(body, "intakeStatus", { max: 20 })! } : {}),
    };
    if (Object.keys(workPatch).length) await updateIssueWorkFields(id, workPatch);

    if (body.labelIds !== undefined) await setIssueLabels(id, stringsField(body, "labelIds"));
    if (body.moduleIds !== undefined) await setIssueModules(id, stringsField(body, "moduleIds"));

    const issue = (await listIssues(project.id)).find((candidate) => candidate.id === id);
    if (!issue) throw new HttpError("Work item not found", 404);
    // A card that just became runnable should not wait for the next poll.
    if (issue.status === "todo") await tick(project.id);
    return NextResponse.json({ issue });
  } catch (error) { return workError(error); }
}
