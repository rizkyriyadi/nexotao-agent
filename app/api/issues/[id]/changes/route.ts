import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDatabase } from "@/lib/db/database";
import { ControlPlaneRepositories } from "@/lib/db/repositories";
import { getIssue, reopenIssue, updateIssue } from "@/lib/issues";
import { getActiveProject } from "@/lib/store";
import { expandHome } from "@/lib/paths";
import { tick } from "@/lib/executor";
import { IssueDomainError } from "@/lib/issue-lifecycle";
import {
  changedSince, commitsSince, dropSnapshot, fileAtSnapshot, restore, type ChangedFile,
} from "@/lib/run-snapshot";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** How much of a run's changes the panel will render. A refactor that touches
 *  every file in a repository is real, and shipping all of it down a JSON
 *  response would stall the browser for a diff nobody scrolls to the end of. */
const FILE_CAP = 100;
/** Per side, per file. Past this the row still appears with its status; only the
 *  text is withheld, so "this file changed" is never lost. */
const BYTE_CAP = 256_000;

export type ChangeFileView = {
  path: string;
  oldPath?: string;
  status: ChangedFile["status"];
  oldText: string;
  newText: string;
  binary?: boolean;
  truncated?: boolean;
};

/** A NUL byte in the first few KB, the same test `git diff` uses and the same
 *  one the folder panel's preview uses. Right far more often than the
 *  extension. */
function looksBinary(text: string) {
  return text.slice(0, 8_000).includes("\0");
}

/** Let a run's safety net go, in both places that describe it.
 *
 *  The ref and the row are one fact stored twice: the ref keeps the commit
 *  reachable, the row is how the panel finds it. Dropping either alone leaves
 *  the pair disagreeing — a Revert button pointed at a commit git is free to
 *  collect, or a ref nothing will ever offer. */
async function release(root: string, repositories: ControlPlaneRepositories, runId: string) {
  await dropSnapshot(root, runId).catch(() => undefined);
  repositories.clearSnapshot(runId);
}

async function readWorking(root: string, file: string) {
  const target = path.resolve(root, file);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { text: "", missing: true };
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) return { text: "", missing: true };
  if (stat.size > BYTE_CAP) return { text: "", missing: false, oversize: true };
  return { text: await fs.readFile(target, "utf8").catch(() => ""), missing: false };
}

/** The run whose snapshot this task's Revert would go back to, plus the folder
 *  it applies to. Resolved together because every caller needs both and neither
 *  is meaningful alone. */
async function resolveTarget(issueId: string) {
  const [project, issue] = await Promise.all([getActiveProject(), getIssue(issueId)]);
  if (!project || !issue || issue.projectId !== project.id) return { error: "Issue not found" as const };
  const repositories = new ControlPlaneRepositories(await getDatabase());
  const run = repositories.latestSnapshotForIssue(issueId);
  return { project, issue, repositories, run, root: expandHome(project.path) };
}

/** The diff between the folder as this task's last run found it and the folder
 *  as it stands right now.
 *
 *  Computed live on every request rather than stored at the end of the run. That
 *  costs a tree hash per call and buys honesty: the user edits this folder too,
 *  in their own editor, while the panel is open. A stored diff would show them
 *  the run's changes as if their own subsequent edits had not happened, and then
 *  Revert would quietly take those edits with it. */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const target = await resolveTarget(id);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 404 });
  const { run, root } = target;

  if (!run?.snapshotCommit) {
    return NextResponse.json({
      snapshot: { available: false, reason: "no_run" }, runId: run?.id ?? null,
      files: [], truncated: false, commits: null,
    });
  }

  try {
    const changes = await changedSince(root, run.snapshotCommit, run.id);
    const shown = changes.slice(0, FILE_CAP);
    const files: ChangeFileView[] = [];
    for (const change of shown) {
      const source = change.oldPath ?? change.path;
      const before = change.status === "A" ? "" : (await fileAtSnapshot(root, run.snapshotCommit, source) ?? "");
      const after = change.status === "D" ? { text: "", missing: false } : await readWorking(root, change.path);
      const binary = looksBinary(before) || looksBinary(after.text);
      const truncated = before.length > BYTE_CAP || Boolean(after.oversize);
      files.push({
        path: change.path,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        status: change.status,
        oldText: binary || truncated ? "" : before,
        newText: binary || truncated ? "" : after.text,
        ...(binary ? { binary: true } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    }
    return NextResponse.json({
      snapshot: { available: true }, runId: run.id, files,
      truncated: changes.length > shown.length,
      commits: await commitsSince(root, run.snapshotHead).catch(() => null),
    });
  } catch (error) {
    return NextResponse.json({
      snapshot: { available: false, reason: "capture_failed", detail: String(error) },
      runId: run.id, files: [], truncated: false, commits: null,
    });
  }
}

/** Keep the changes, undo them, or undo them and tell the agent what to do
 *  differently.
 *
 *  None of the three moves files into the project — the run already wrote them
 *  there. What they decide is whether the folder stays that way and where the
 *  task goes. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const action = String(body.action ?? "");
  if (action !== "keep" && action !== "revert" && action !== "revert-retry") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  const target = await resolveTarget(id);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 404 });
  const { issue, repositories, run, root } = target;

  // Asked before anything is restored, so a rejected request leaves the folder
  // exactly as the user found it.
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (action === "revert-retry" && !reason) {
    return NextResponse.json({ error: "Tell the agent what to change" }, { status: 400 });
  }
  if (!run?.snapshotCommit) {
    return NextResponse.json({ error: "This task has no snapshot to act on" }, { status: 400 });
  }

  try {
    if (action === "keep") {
      // Nothing to do to the folder. The snapshot is released here rather than
      // left to age out because holding it is precisely what "still waiting for
      // you" means, and this is the user saying they are done looking.
      await updateIssue(id, { status: "done" }, { type: "user" });
      await release(root, repositories, run.id);
      return NextResponse.json({ issue: await getIssue(id), kept: true });
    }

    const result = await restore(root, run.snapshotCommit, run.id, run.snapshotHead);

    if (action === "revert") {
      const summary = [issue.summary, `Reverted — ${result.restored.length + result.removed.length} file(s) put back as they were before this run.`]
        .filter(Boolean).join("\n\n");
      await updateIssue(id, { status: "done", summary }, { type: "user" });
      await release(root, repositories, run.id);
      return NextResponse.json({ issue: await getIssue(id), reverted: result });
    }

    // revert-retry: the folder is back as it was, and the task goes round again
    // with the user's note as the next run's first piece of context.
    await repositories.addComment({ issueId: id, authorType: "user", body: reason });
    await reopenIssue(id, { type: "user" });
    await dropSnapshot(root, run.id).catch(() => undefined);
    // Reopening alone only changes the row; the tick is what wakes the lead.
    await tick(issue.projectId);
    return NextResponse.json({ issue: await getIssue(id), reverted: result }, { status: 201 });
  } catch (error) {
    if (error instanceof IssueDomainError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: String((error as Error).message ?? error) }, { status: 500 });
  }
}
