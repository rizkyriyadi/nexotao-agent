import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DIR } from "./config";
import type { ControlPlaneRepositories, GitWorkspaceRow } from "./db/repositories";

const CONVENTIONAL_SUBJECT = /^(feat|fix|refactor|test|docs|build|ci|chore)(\([a-z0-9][a-z0-9._/-]*\))?!?: [a-z0-9].{0,100}$/;
const ATTRIBUTION = /(?:^|\n)\s*(?:co-authored-by|generated-by|signed-off-by):|\b(?:paperclip|codex|claude)\b/i;
const MANAGED_STATES = new Set(["active", "orphaned", "recovered"]);
let provisionQueue: Promise<unknown> = Promise.resolve();

export type GitIdentity = { name: string; email: string };
export type WorkspaceAssignment = GitWorkspaceRow;
export type OrphanedWorkspace = WorkspaceAssignment & { dirty: boolean; status: string };

function safePart(value: string, fallback: string) {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return result || fallback;
}

function within(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function command(commandName: string, args: string[], cwd: string, options: { shell?: boolean; timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd, shell: options.shell ?? false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (target === "stdout" && stdout.length < 2_000_000) stdout += value.slice(0, 2_000_000 - stdout.length);
      if (target === "stderr" && stderr.length < 2_000_000) stderr += value.slice(0, 2_000_000 - stderr.length);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error((stderr || stdout || `${commandName} exited with ${code}`).trim()));
    });
  });
}

async function git(cwd: string, ...args: string[]) {
  return command("git", args, cwd);
}

export function isProhibitedAgentMarkdown(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const base = parts.at(-1) ?? "";
  if (!base.endsWith(".md")) return false;
  if (["agents.md", "agent.md", "claude.md", "codex.md"].includes(base)) return true;
  if (parts.some((part) => [".agents", "agents", ".agent", "agent"].includes(part))) return true;
  return /(?:agent|prompt|instruction|runbook)/.test(base);
}

export function assertProfessionalCommit(message: string) {
  const subject = message.split(/\r?\n/, 1)[0];
  if (!CONVENTIONAL_SUBJECT.test(subject)) throw new Error(`Commit subject is not Conventional Commits compliant: ${subject}`);
  if (ATTRIBUTION.test(message)) throw new Error("Commit message contains prohibited agent or vendor attribution");
}

export function assertAllowedPaths(files: string[]) {
  const prohibited = files.filter(isProhibitedAgentMarkdown);
  if (prohibited.length) throw new Error(`Agent instruction Markdown is local-only and cannot be committed: ${prohibited.join(", ")}`);
}

async function repositoryIdentity(repositoryPath: string): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    git(repositoryPath, "config", "--get", "user.name"),
    git(repositoryPath, "config", "--get", "user.email"),
  ]);
  if (!name.stdout || !email.stdout) throw new Error("Repository-approved Git identity is not configured");
  return { name: name.stdout, email: email.stdout };
}

async function changedPaths(workspacePath: string) {
  const outputs = await Promise.all([
    git(workspacePath, "diff", "--name-only", "-z"),
    git(workspacePath, "diff", "--cached", "--name-only", "-z"),
    git(workspacePath, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  return [...new Set(outputs.flatMap((result) => result.stdout.split("\0").filter(Boolean)))];
}

export async function inspectOutgoingCommits(repositoryPath: string, baseCommit: string, headCommit: string, approved?: GitIdentity) {
  const identity = approved ?? await repositoryIdentity(repositoryPath);
  const paths = (await git(repositoryPath, "diff", "--name-only", "-z", `${baseCommit}..${headCommit}`)).stdout.split("\0").filter(Boolean);
  assertAllowedPaths(paths);
  if (baseCommit === headCommit) return { commits: 0, paths };
  const format = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%s%x00%b%x1e";
  const raw = (await git(repositoryPath, "log", `--format=${format}`, `${baseCommit}..${headCommit}`)).stdout;
  const records = raw.split("\x1e").map((record) => record.trim()).filter(Boolean);
  for (const record of records) {
    const [commit, authorName, authorEmail, committerName, committerEmail, subject, body = ""] = record.split("\0");
    if (authorName !== identity.name || authorEmail !== identity.email || committerName !== identity.name || committerEmail !== identity.email) {
      throw new Error(`Commit author or committer is not the repository-approved identity: ${subject}`);
    }
    assertProfessionalCommit(body ? `${subject}\n${body}` : subject);
    const commitPaths = (await git(repositoryPath, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit))
      .stdout.split("\0").filter(Boolean);
    assertAllowedPaths(commitPaths);
  }
  return { commits: records.length, paths };
}

export class GitWorkspaceManager {
  readonly managedRoot: string;

  constructor(private readonly repositories: ControlPlaneRepositories, managedRoot = path.join(DIR, "worktrees")) {
    this.managedRoot = path.resolve(managedRoot);
  }

  async provision(input: { projectId: string; issueId: string; identifier: string; runId: string; repositoryPath: string }) {
    const existing = this.repositories.getWorkspace(input.runId);
    if (existing) {
      if (existing.state === "orphaned") await this.repositories.markWorkspaceState(input.runId, "recovered", "Reclaimed by the original durable run");
      await this.validate(input.issueId, input.runId);
      return this.repositories.getWorkspace(input.runId)!;
    }
    const operation = provisionQueue.then(() => this.provisionLocked(input));
    provisionQueue = operation.catch(() => undefined);
    return operation;
  }

  private async provisionLocked(input: { projectId: string; issueId: string; identifier: string; runId: string; repositoryPath: string }) {
    const repositoryPath = await fs.realpath(path.resolve(input.repositoryPath));
    const topLevel = await fs.realpath((await git(repositoryPath, "rev-parse", "--show-toplevel")).stdout);
    if (topLevel !== repositoryPath) throw new Error(`Project path must be the Git worktree root: ${repositoryPath}`);
    const targetBranch = (await git(repositoryPath, "symbolic-ref", "--short", "HEAD")).stdout;
    const baseCommit = (await git(repositoryPath, "rev-parse", "HEAD")).stdout;
    const repoKey = createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16);
    const runKey = safePart(input.runId, randomUUID().slice(0, 8));
    const branch = `nexotao/${safePart(input.identifier, "issue")}/${runKey}`;
    const workspacePath = path.join(this.managedRoot, repoKey, `${safePart(input.identifier, "issue")}-${runKey}`);
    if (!within(this.managedRoot, workspacePath)) throw new Error("Resolved worktree path escapes the managed workspace root");
    await fs.mkdir(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
    await git(repositoryPath, "check-ref-format", "--branch", branch);
    await git(repositoryPath, "worktree", "add", "-b", branch, workspacePath, baseCommit);
    try {
      return await this.repositories.assignWorkspace({
        id: randomUUID(), projectId: input.projectId, issueId: input.issueId, runId: input.runId,
        repositoryPath, workspacePath, branch, targetBranch, baseCommit,
      });
    } catch (error) {
      throw new Error(`Worktree was preserved for recovery at ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async validate(issueId: string, runId: string) {
    const assignment = this.repositories.getWorkspace(runId);
    const issue = this.repositories.issues.get(issueId);
    const heartbeat = this.repositories.getHeartbeat(runId);
    if (!assignment || assignment.issueId !== issueId) throw new Error("No persisted workspace assignment for this issue and run");
    if (!issue || issue.checkoutRunId !== runId || issue.workspacePath !== assignment.workspacePath || issue.workspaceBranch !== assignment.branch) {
      throw new Error("Issue checkout no longer owns the persisted workspace");
    }
    if (!heartbeat || heartbeat.issueId !== issueId || heartbeat.workspacePath !== assignment.workspacePath || heartbeat.workspaceBranch !== assignment.branch) {
      throw new Error("Heartbeat workspace identity does not match the persisted assignment");
    }
    if (!["running", "waiting"].includes(heartbeat.status)) throw new Error("Heartbeat is not active; workspace writes are rejected");
    if (!MANAGED_STATES.has(assignment.state)) throw new Error(`Workspace state ${assignment.state} does not allow writes`);
    const realWorkspace = await fs.realpath(assignment.workspacePath);
    if (!within(this.managedRoot, realWorkspace)) throw new Error("Workspace is outside the managed worktree root");
    const [topLevel, branch] = await Promise.all([
      git(realWorkspace, "rev-parse", "--show-toplevel"),
      git(realWorkspace, "symbolic-ref", "--short", "HEAD"),
    ]);
    if (await fs.realpath(topLevel.stdout) !== realWorkspace || branch.stdout !== assignment.branch) {
      throw new Error("Git worktree path or branch no longer matches the persisted assignment");
    }
    await this.repositories.touchWorkspace(runId);
    return assignment;
  }

  mutationGuard(issueId: string, runId: string) {
    return async (tool: { name: string; input: unknown }) => {
      await this.validate(issueId, runId);
      if ((tool.name === "write_file" || tool.name === "edit_file") && isProhibitedAgentMarkdown(String((tool.input as { path?: unknown })?.path ?? ""))) {
        throw new Error("Agent instruction Markdown is local-only and cannot be written by issue runs");
      }
      if (tool.name === "bash") {
        const shellCommand = String((tool.input as { command?: unknown })?.command ?? "");
        if (/\bgit\b[\s\S]*\b(?:commit|push)\b/i.test(shellCommand)) {
          throw new Error("Git commit and push are restricted to the verified integration flow");
        }
      }
    };
  }

  async preflightPush(runId: string) {
    const assignment = this.repositories.getWorkspace(runId);
    if (!assignment?.commitSha || assignment.state !== "verified") throw new Error("Only verified workspace commits may be pushed");
    await inspectOutgoingCommits(assignment.repositoryPath, assignment.baseCommit, assignment.commitSha);
    return assignment;
  }

  async finalizeCommit(issueId: string, runId: string, identifier: string) {
    const assignment = await this.validate(issueId, runId);
    const identity = await repositoryIdentity(assignment.repositoryPath);
    const paths = await changedPaths(assignment.workspacePath);
    assertAllowedPaths(paths);
    if (paths.length) {
      await git(assignment.workspacePath, "add", "--all");
      const staged = (await git(assignment.workspacePath, "diff", "--cached", "--name-only", "-z")).stdout.split("\0").filter(Boolean);
      assertAllowedPaths(staged);
      const message = `feat(workspace): complete ${identifier} changes`;
      assertProfessionalCommit(message);
      await git(assignment.workspacePath, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", message);
    }
    const head = (await git(assignment.workspacePath, "rev-parse", "HEAD")).stdout;
    await inspectOutgoingCommits(assignment.workspacePath, assignment.baseCommit, head, identity);
    await this.repositories.recordWorkspaceCommit(runId, head, "committed");
    return { commit: head, changedPaths: paths };
  }

  async cherryPickChildren(issueId: string, runId: string, children: Array<{ identifier: string; workspaceCommit?: string | null; workspaceBaseCommit?: string | null; verificationStatus?: string | null }>) {
    const assignment = await this.validate(issueId, runId);
    const reports: string[] = [];
    for (const child of children) {
      if (!child.workspaceCommit || !child.workspaceBaseCommit || !["committed", "verified"].includes(child.verificationStatus ?? "")) {
        await this.repositories.markWorkspaceState(runId, "rejected", `${child.identifier} has no policy-checked commit`);
        throw new Error(`Integration rejected: ${child.identifier} has no policy-checked commit`);
      }
      await inspectOutgoingCommits(assignment.repositoryPath, child.workspaceBaseCommit, child.workspaceCommit);
      if (child.workspaceCommit === child.workspaceBaseCommit) {
        reports.push(`${child.identifier}: no changes`);
        continue;
      }
      try {
        await git(assignment.workspacePath, "cherry-pick", child.workspaceCommit);
      } catch (error) {
        await git(assignment.workspacePath, "cherry-pick", "--abort").catch(() => undefined);
        await this.repositories.markWorkspaceState(runId, "rejected", `Conflict while integrating ${child.identifier}`);
        throw new Error(`Integration rejected due to conflict in ${child.identifier}: ${error instanceof Error ? error.message : String(error)}`);
      }
      reports.push((await git(assignment.workspacePath, "show", "--stat", "--oneline", "--summary", child.workspaceCommit)).stdout);
    }
    return reports;
  }

  async verifyAndPromote(issueId: string, runId: string, identifier: string, verificationCommands: string[]) {
    const finalized = await this.finalizeCommit(issueId, runId, identifier);
    const assignment = this.repositories.getWorkspace(runId)!;
    const logs: string[] = [];
    try {
      for (const verificationCommand of verificationCommands) {
        if (!verificationCommand.trim()) continue;
        const result = await command(verificationCommand, [], assignment.workspacePath, { shell: true, timeoutMs: 300_000 });
        logs.push(`$ ${verificationCommand}\n${result.stdout || result.stderr || "(no output)"}`);
      }
      await inspectOutgoingCommits(assignment.workspacePath, assignment.baseCommit, finalized.commit);
      const status = (await git(assignment.repositoryPath, "status", "--porcelain")).stdout;
      if (status) throw new Error("Target worktree has user changes; verified commits were preserved but not integrated");
      const currentBranch = (await git(assignment.repositoryPath, "symbolic-ref", "--short", "HEAD")).stdout;
      const currentHead = (await git(assignment.repositoryPath, "rev-parse", "HEAD")).stdout;
      if (currentBranch !== assignment.targetBranch || currentHead !== assignment.baseCommit) {
        throw new Error("Target branch moved during execution; verified commits were preserved but not integrated");
      }
      await git(assignment.repositoryPath, "merge", "--ff-only", assignment.branch);
      await this.repositories.recordWorkspaceCommit(runId, finalized.commit, "verified");
      return { ...finalized, logs };
    } catch (error) {
      await this.repositories.recordWorkspaceCommit(runId, finalized.commit, "rejected");
      throw error;
    }
  }

  async detectOrphans(projectId?: string): Promise<OrphanedWorkspace[]> {
    const orphaned: OrphanedWorkspace[] = [];
    for (const workspace of this.repositories.listWorkspaces(projectId)) {
      if (workspace.state !== "active") continue;
      const heartbeat = this.repositories.getHeartbeat(workspace.runId);
      if (heartbeat && ["running", "waiting"].includes(heartbeat.status)) continue;
      let status = "worktree path is missing";
      try { status = (await git(workspace.workspacePath, "status", "--porcelain")).stdout; } catch {}
      const dirty = Boolean(status && status !== "worktree path is missing");
      const note = dirty ? "Orphaned worktree contains uncommitted work and was preserved" : "Orphaned worktree was preserved for inspection";
      await this.repositories.markWorkspaceState(workspace.runId, "orphaned", note);
      orphaned.push({ ...workspace, state: "orphaned", recoveryNote: note, dirty, status });
    }
    return orphaned;
  }

  async recoverOrphan(runId: string) {
    const workspace = this.repositories.getWorkspace(runId);
    if (!workspace || workspace.state !== "orphaned") throw new Error("Orphaned workspace not found");
    try {
      const status = (await git(workspace.workspacePath, "status", "--porcelain")).stdout;
      await this.repositories.markWorkspaceState(runId, "recovered", "Workspace retained in place; inspect and resume or export the branch");
      return { path: workspace.workspacePath, branch: workspace.branch, available: true, dirty: Boolean(status), status };
    } catch {
      await this.repositories.markWorkspaceState(runId, "recovered", "Worktree path is unavailable; the Git branch was retained for manual recovery");
      return { path: workspace.workspacePath, branch: workspace.branch, available: false, dirty: false, status: "worktree path is missing" };
    }
  }

  async cleanupOrphan(runId: string) {
    const workspace = this.repositories.getWorkspace(runId);
    if (!workspace || workspace.state !== "orphaned") throw new Error("Orphaned workspace not found");
    let status = "";
    try {
      status = (await git(workspace.workspacePath, "status", "--porcelain", "--untracked-files=all")).stdout;
    } catch {
      await git(workspace.repositoryPath, "worktree", "prune");
      await this.repositories.markWorkspaceState(runId, "cleaned", "Missing worktree metadata pruned; branch retained for recovery");
      return { path: workspace.workspacePath, branch: workspace.branch, removed: false, branchRetained: true };
    }
    if (status) throw new Error("Orphaned workspace contains user work and cannot be cleaned automatically");
    await git(workspace.repositoryPath, "worktree", "remove", workspace.workspacePath);
    await this.repositories.markWorkspaceState(runId, "cleaned", "Clean orphaned worktree removed; branch retained for recovery");
    return { path: workspace.workspacePath, branch: workspace.branch, removed: true, branchRetained: true };
  }
}
