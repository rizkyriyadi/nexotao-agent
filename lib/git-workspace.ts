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

/** Lead with the line that says *why* the command failed. Git narrates progress
 *  on stderr ("Preparing worktree (new branch 'nexotao/nx-22/…')") before the
 *  `fatal:` line that actually explains the failure, so using stderr verbatim
 *  buries the cause behind noise — and any caller that truncates to one line
 *  (the inbox does) shows only the narration. Diagnostic lines are kept after
 *  the cause so nothing is lost. */
export function failureMessage(stderr: string, stdout: string, fallback: string) {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return fallback;
  const causeIndex = lines.findIndex((line) => /^(?:fatal|error):/i.test(line));
  if (causeIndex === -1) return lines.join("\n");
  return [lines[causeIndex], ...lines.slice(0, causeIndex), ...lines.slice(causeIndex + 1)].join("\n");
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
      else reject(new Error(failureMessage(stderr, stdout, `${commandName} exited with ${code}`)));
    });
  });
}

/** Windows refuses a path over 260 characters unless `core.longpaths` is on, and
 *  a managed worktree spends around a hundred of those before the repository's
 *  own files are appended. A large tree then checks out partway and dies with
 *  "Could not reset index file to revision 'HEAD'" — a message that names
 *  neither the path nor the limit. Passed per invocation rather than written
 *  into the user's config, because it is ours to need and not theirs to keep;
 *  the key is inert off Windows, so the platform check is only to keep the
 *  command line honest about what it is for. */
const GIT_PLATFORM_ARGS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

async function git(cwd: string, ...args: string[]) {
  return command("git", [...GIT_PLATFORM_ARGS, ...args], cwd);
}

/** The agent-instruction files that must stay out of a user's history.
 *
 *  Deliberately an exact list rather than a word match. The rule used to be
 *  `/(?:agent|prompt|instruction|runbook)/` over the basename, which reads as a
 *  reasonable generalisation right up until someone builds an ordinary website:
 *  `travel-agent.md`, `docs/instructions.md`, `blog/prompt-engineering.md` and
 *  `RUNBOOK.md` are all a user's own content, and every one of them tripped it.
 *  These file names are a convention with a fixed spelling; matching them by
 *  substring buys nothing and claims files we have no business claiming. */
export function isProhibitedAgentMarkdown(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const base = parts.at(-1) ?? "";
  if (!base.endsWith(".md")) return false;
  if (["agents.md", "agent.md", "claude.md", "codex.md"].includes(base)) return true;
  return parts.slice(0, -1).some((part) => [".agents", ".agent", ".claude"].includes(part));
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
  if (baseCommit === headCommit) return { commits: 0, paths: [] as string[] };
  // Only vet commits authored locally in this workspace: reachable from head, but
  // from neither the base nor any remote-tracking branch. History imported by
  // pulling an upstream repository (e.g. `git reset --hard upstream/main`) lives on
  // a remote ref, so its third-party commits are exempt from the identity,
  // attribution, and path policy — those rules gate what an agent introduces, not
  // what a legitimate upstream already published. Re-auditing foreign history would
  // fail every pull, since its authors are never the repository-approved identity.
  const localCommits = (await git(repositoryPath, "rev-list", `${baseCommit}..${headCommit}`, "--not", "--remotes"))
    .stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!localCommits.length) return { commits: 0, paths: [] as string[] };
  const format = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%s%x00%b%x1e";
  const raw = (await git(repositoryPath, "log", "--no-walk", `--format=${format}`, ...localCommits)).stdout;
  const records = raw.split("\x1e").map((record) => record.trim()).filter(Boolean);
  const paths = new Set<string>();
  for (const record of records) {
    const [commit, authorName, authorEmail, committerName, committerEmail, subject, body = ""] = record.split("\0");
    if (authorName !== identity.name || authorEmail !== identity.email || committerName !== identity.name || committerEmail !== identity.email) {
      throw new Error(`Commit author or committer is not the repository-approved identity: ${subject}`);
    }
    assertProfessionalCommit(body ? `${subject}\n${body}` : subject);
    const commitPaths = (await git(repositoryPath, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit))
      .stdout.split("\0").filter(Boolean);
    assertAllowedPaths(commitPaths);
    for (const commitPath of commitPaths) paths.add(commitPath);
  }
  return { commits: records.length, paths: [...paths] };
}

export class GitWorkspaceManager {
  readonly managedRoot: string;

  constructor(private readonly repositories: ControlPlaneRepositories, managedRoot = path.join(DIR, "worktrees")) {
    this.managedRoot = path.resolve(managedRoot);
  }

  /** The managed root with symlinks resolved. Containment checks compare against
   *  a `realpath`-ed workspace, so the root must be resolved the same way or the
   *  two are not comparable: on macOS a root under `/var/...` is really
   *  `/private/var/...`, and every workspace inside it would be judged to be
   *  outside. Resolved on demand because the directory may not exist yet at
   *  construction time. */
  private async realManagedRoot() {
    return fs.realpath(this.managedRoot).catch(() => this.managedRoot);
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

  /** Make a fresh project directory workable: if it isn't already a Git repo,
   *  initialise one (with a usable identity and a base commit) so agent-mode runs
   *  can provision a worktree instead of failing with "not a git repository". A
   *  directory that already sits inside a repo is left untouched — the caller's
   *  worktree-root check then reports any unexpected nesting. */
  private async ensureRepository(repositoryPath: string) {
    try {
      await git(repositoryPath, "rev-parse", "--git-dir");
      return;
    } catch {
      // Not a Git repository yet — initialise one below.
    }
    await git(repositoryPath, "init");
    await this.ensureIdentity(repositoryPath);
    const hasHead = await git(repositoryPath, "rev-parse", "--verify", "HEAD").then(() => true).catch(() => false);
    if (!hasHead) {
      const identity = await repositoryIdentity(repositoryPath);
      // Capture any pre-existing files (honoring .gitignore) into the base commit
      // so the run's worktree — created from that commit — is a faithful copy of
      // the directory. An empty directory produces an empty initial commit.
      await git(repositoryPath, "add", "-A").catch(() => undefined);
      const staged = (await git(repositoryPath, "diff", "--cached", "--name-only")).stdout;
      const identityArgs = ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
      const commitArgs = staged ? ["commit", "-m", "chore: initialize workspace"] : ["commit", "--allow-empty", "-m", "chore: initialize workspace"];
      await git(repositoryPath, ...identityArgs, ...commitArgs);
    }
  }

  /** Ensure a repo has an author identity so commits succeed. Only fills in a
   *  default when neither local nor global config provides one. */
  private async ensureIdentity(repositoryPath: string) {
    const name = await git(repositoryPath, "config", "user.name").then((r) => r.stdout).catch(() => "");
    const email = await git(repositoryPath, "config", "user.email").then((r) => r.stdout).catch(() => "");
    if (!name) await git(repositoryPath, "config", "user.name", "Nexotao Agent");
    if (!email) await git(repositoryPath, "config", "user.email", "agent@nexotao.local");
  }

  /** The commit a new run on this issue should branch from.
   *
   *  Normally that is the repository's HEAD. But a run's work only reaches HEAD
   *  if `integrate` fast-forwarded it, and integration is legitimately refused
   *  whenever the user is mid-edit, on another branch, or the branch diverged.
   *  The commit still exists on `nexotao/<ref>/<runId>`; it is simply not on
   *  HEAD yet.
   *
   *  Branching the follow-up from HEAD in that case hands the agent an empty
   *  worktree. It then reports, accurately, that it has written nothing — which
   *  a user who just watched it write four files reads as the agent forgetting
   *  its own work. Continuing from the previous run's commit is what makes a
   *  follow-up a continuation rather than a restart.
   *
   *  Only ever moves *forward*: the prior commit is used solely when HEAD is
   *  already an ancestor of it, so this can never rewind past work the user has
   *  since committed themselves. Anything unreadable falls back to HEAD. */
  private async continuationBase(issueId: string, repositoryPath: string) {
    const head = (await git(repositoryPath, "rev-parse", "HEAD")).stdout;
    const prior = this.repositories.issues.get(issueId);
    const candidate = prior?.workspaceCommit;
    if (!candidate || candidate === head) return head;
    // The commit has to still be reachable in *this* repository: a worktree
    // released by `nexotao uninstall`, a pruned branch, or a project pointed at
    // a different checkout all leave a recorded sha that no longer resolves.
    const exists = await git(repositoryPath, "cat-file", "-e", `${candidate}^{commit}`).then(() => true).catch(() => false);
    if (!exists) return head;
    const ahead = await git(repositoryPath, "merge-base", "--is-ancestor", head, candidate).then(() => true).catch(() => false);
    return ahead ? candidate : head;
  }

  private async provisionLocked(input: { projectId: string; issueId: string; identifier: string; runId: string; repositoryPath: string }) {
    const repositoryPath = await fs.realpath(path.resolve(input.repositoryPath));
    await this.ensureRepository(repositoryPath);
    const topLevel = await fs.realpath((await git(repositoryPath, "rev-parse", "--show-toplevel")).stdout);
    // Naming the repository we found is the whole point: `rev-parse` answers from
    // any subdirectory, so a project folder nested inside a larger checkout looks
    // like a repository right up to this line. Restating the rejected path alone
    // tells someone their path is wrong without telling them what is right — and
    // what is right is nearly always "select the parent instead".
    if (topLevel !== repositoryPath) {
      throw new Error(
        `Project path must be the Git worktree root, but ${repositoryPath} is inside the repository at ${topLevel}. `
        + `Select ${topLevel} as the project, or run \`git init\` in ${repositoryPath} to make it its own repository.`,
      );
    }
    const targetBranch = (await git(repositoryPath, "symbolic-ref", "--short", "HEAD")).stdout;
    const baseCommit = await this.continuationBase(input.issueId, repositoryPath);
    const repoKey = createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16);
    const runKey = safePart(input.runId, randomUUID().slice(0, 8));
    const branch = `nexotao/${safePart(input.identifier, "issue")}/${runKey}`;
    const workspacePath = path.join(this.managedRoot, repoKey, `${safePart(input.identifier, "issue")}-${runKey}`);
    if (!within(this.managedRoot, workspacePath)) throw new Error("Resolved worktree path escapes the managed workspace root");
    await fs.mkdir(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
    await git(repositoryPath, "check-ref-format", "--branch", branch);
    try {
      await git(repositoryPath, "worktree", "add", "-b", branch, workspacePath, baseCommit);
    } catch (error) {
      // `worktree add` creates the branch first and checks out second, so a
      // checkout that dies partway — a lock, a full disk, a path Windows will
      // not accept — leaves the branch behind while registering no worktree.
      // The branch carries this run's id, and a retry reuses that id, so every
      // subsequent attempt fails with "a branch named … already exists": one
      // transient fault turns into a permanently broken issue. Undo what was
      // created so the retry is a clean first attempt, and report the original
      // cause rather than the rollback's.
      const rollback = await this.discardWorkspace(repositoryPath, workspacePath, branch);
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(rollback ? `${cause} (cleanup incomplete: ${rollback})` : cause);
    }
    try {
      return await this.repositories.assignWorkspace({
        id: randomUUID(), projectId: input.projectId, issueId: input.issueId, runId: input.runId,
        repositoryPath, workspacePath, branch, targetBranch, baseCommit,
      });
    } catch (error) {
      // The worktree and branch exist but nothing recorded them, so no recovery
      // flow can ever reach them. Worse, both are named after the run id, so a
      // retry — which reuses that id — would hit "a branch named … already
      // exists" forever. The tree is untouched by the agent at this point (the
      // run has not started), so removing it loses no work and makes the retry
      // a clean first attempt. A failed rollback is reported alongside the
      // original cause rather than replacing it.
      const rollback = await this.discardWorkspace(repositoryPath, workspacePath, branch);
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(rollback ? `${cause} (cleanup incomplete at ${workspacePath}: ${rollback})` : cause);
    }
  }

  /** Remove a just-created worktree and its branch. Returns null when nothing was
   *  left behind, or the reasons it could not be undone so the caller can report
   *  them.
   *
   *  Every step is attempted independently. A half-created workspace is the
   *  common case here — `worktree add` registers the worktree only after the
   *  checkout succeeds, so a failure partway leaves a branch with no worktree,
   *  and `worktree remove` then fails with "is not a working tree". Running the
   *  steps in one `try` would let that expected failure skip `branch -D`, which
   *  is precisely the deletion that unblocks the retry. */
  private async discardWorkspace(repositoryPath: string, workspacePath: string, branch: string) {
    const problems: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Best-effort and unreported: the worktree legitimately may never have been
    // registered, and saying so would make a clean rollback look like a failure.
    await git(repositoryPath, "worktree", "remove", "--force", workspacePath).catch(() => undefined);
    await git(repositoryPath, "worktree", "prune").catch(() => undefined);
    // A directory left by a partial checkout is not a worktree git will remove,
    // but it does block the retry with "already exists".
    await attempt("directory", () => fs.rm(workspacePath, { recursive: true, force: true }));
    // The one deletion that must work: the branch is named after the run id, so
    // leaving it behind is what makes the failure permanent.
    const branchExists = await git(repositoryPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true).catch(() => false);
    if (branchExists) await attempt("branch", () => git(repositoryPath, "branch", "-D", branch));
    return problems.length ? problems.join("; ") : null;
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
    if (!within(await this.realManagedRoot(), realWorkspace)) throw new Error("Workspace is outside the managed worktree root");
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

  /** Commit the run's work.
   *
   *  An agent-instruction file found here is *left out of the commit*, not made
   *  into a failure. It used to throw: one stray `AGENTS.md` — a file the
   *  harness itself often writes, and one the agent never touched through a
   *  guarded tool — aborted `finalizeCommit` before anything was staged, so the
   *  run failed, `integrate` was never reached, and every other file the agent
   *  had written sat uncommitted on a branch no surface in the app lists. A user
   *  who asked for a portfolio site was told the run failed and found nothing.
   *
   *  Excluding costs the user nothing (the file stays in the worktree, and it
   *  was never theirs to keep in history) and it keeps the rule honest: the
   *  policy is "this does not go into your history", which exclusion satisfies
   *  exactly, where failing the run satisfies it only by destroying the work
   *  alongside it. */
  async finalizeCommit(issueId: string, runId: string, identifier: string) {
    const assignment = await this.validate(issueId, runId);
    const identity = await repositoryIdentity(assignment.repositoryPath);
    const paths = await changedPaths(assignment.workspacePath);
    const excluded: string[] = [];
    let staged: string[] = [];
    if (paths.length) {
      await git(assignment.workspacePath, "add", "--all");
      staged = (await git(assignment.workspacePath, "diff", "--cached", "--name-only", "-z")).stdout.split("\0").filter(Boolean);
      const prohibited = staged.filter(isProhibitedAgentMarkdown);
      if (prohibited.length) {
        // Unstage rather than delete: a tracked file returns to modified, an
        // untracked one returns to untracked, and either way it is still on disk
        // where the user (or the next run) can see it.
        await git(assignment.workspacePath, "reset", "--quiet", "--", ...prohibited);
        staged = (await git(assignment.workspacePath, "diff", "--cached", "--name-only", "-z")).stdout.split("\0").filter(Boolean);
        excluded.push(...prohibited);
      }
    }
    // `git diff` reports a submodule whose *contents* changed as a changed path,
    // but `git add --all` stages nothing for it: from the superproject's view the
    // gitlink still points at the same commit. Committing then fails with "no
    // changes added to commit" and the run is reported as failed even though the
    // agent did its work. Staging emptiness — not path emptiness — is what
    // decides whether there is a commit to make.
    if (staged.length) {
      const message = `feat(workspace): complete ${identifier} changes`;
      assertProfessionalCommit(message);
      await git(assignment.workspacePath, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", message);
    }
    const head = (await git(assignment.workspacePath, "rev-parse", "HEAD")).stdout;
    await inspectOutgoingCommits(assignment.workspacePath, assignment.baseCommit, head, identity);
    await this.repositories.recordWorkspaceCommit(runId, head, "committed");
    return { commit: head, changedPaths: paths.filter((file) => !excluded.includes(file)), excluded };
  }

  /** Fast-forward the branch the user actually works on so the run's commit lands
   *  in their project folder.
   *
   *  Without this the isolation is a trap door: the agent commits to
   *  `nexotao/nx-N/<runId>`, the task reports done, and the folder the user is
   *  looking at is unchanged — the work exists only on a branch nothing in the UI
   *  mentions. Isolation is meant to keep a *running* agent out of the user's
   *  tree, not to keep the finished result away from them.
   *
   *  Nothing here may rewrite or discard existing history. Where the target only
   *  moved *forward* — the common case with teammates finishing in parallel, each
   *  landing on the branch the next one branched from — the run's own commits are
   *  replayed on top and the result still fast-forwards. Anything else (the user
   *  mid-edit, the branch switched, a genuine divergence, a conflicting replay) is
   *  refused and reported, not thrown: the run succeeded, and its commit stays on
   *  its branch for recovery. */
  async integrate(runId: string): Promise<{ integrated: boolean; commit: string | null; branch: string; reason?: string }> {
    const assignment = this.repositories.getWorkspace(runId);
    if (!assignment) throw new Error("No persisted workspace assignment for this run");
    // `commit` means the run's *own* commit, so it is null when the run added
    // nothing. `finalizeCommit` records HEAD either way — it has to, since HEAD
    // is what a later cherry-pick reads — so a caller that took commitSha at face
    // value would see the base commit and conclude there was work to merge. That
    // is what told a user with an unchanged folder to run `git merge` on a branch
    // holding nothing.
    const own = assignment.commitSha && assignment.commitSha !== assignment.baseCommit ? assignment.commitSha : null;
    const result = (integrated: boolean, reason?: string) =>
      ({ integrated, commit: own, branch: assignment.branch, ...(reason ? { reason } : {}) });
    if (!own) return result(false, "the run made no changes");

    const status = (await git(assignment.repositoryPath, "status", "--porcelain")).stdout;
    if (status) return result(false, `your working tree has uncommitted changes, so the work was left on ${assignment.branch}`);
    const [branch, head] = await Promise.all([
      git(assignment.repositoryPath, "symbolic-ref", "--short", "HEAD").then((r) => r.stdout).catch(() => ""),
      git(assignment.repositoryPath, "rev-parse", "HEAD").then((r) => r.stdout),
    ]);
    if (branch !== assignment.targetBranch) {
      return result(false, `you are on ${branch || "a different branch"} rather than ${assignment.targetBranch}, so the work was left on ${assignment.branch}`);
    }
    let source = assignment.branch;
    // A continuation run branches from the *previous* run's commit, which is by
    // definition ahead of a HEAD that never received it. There is nothing to
    // replay — the base already contains everything HEAD has, so the merge below
    // fast-forwards on its own. Refusing here would reject every follow-up to a
    // task whose first run was refused, piling the work up on branches the user
    // never sees.
    //
    // "HEAD is an ancestor of the base" alone does NOT establish that: a user
    // who resets their branch mid-run produces exactly the same shape, and
    // fast-forwarding there would silently restore commits they deliberately
    // dropped. The distinguishing fact is recorded, not inferred — the base has
    // to be a commit an earlier run *on this issue* actually produced.
    const continuation = head !== assignment.baseCommit
      && this.repositories.listWorkspacesForIssue(assignment.issueId)
        .some((w) => w.runId !== assignment.runId && w.commitSha === assignment.baseCommit)
      && await git(assignment.repositoryPath, "merge-base", "--is-ancestor", head, assignment.baseCommit).then(() => true).catch(() => false);
    if (head !== assignment.baseCommit && !continuation) {
      // Consecutive runs on the same task branch from the same base, and the
      // first to finish moves it. Refusing here would strand every later run on
      // a branch of its own — which the user would experience as "only one of the
      // three files showed up".
      //
      // Replaying is only safe if the target is strictly ahead of the base: then
      // no existing commit is being rewritten, only the run's own work is moved.
      // A rebase onto anything else could silently drop the user's commits.
      const ahead = await git(assignment.repositoryPath, "merge-base", "--is-ancestor", assignment.baseCommit, head)
        .then(() => true).catch(() => false);
      if (!ahead) return result(false, `${assignment.targetBranch} diverged while the agent worked, so the work was left on ${assignment.branch}`);
      // Rebase in the worktree, never in the user's repository: a conflict there
      // would leave their checkout mid-rebase.
      try {
        await git(assignment.workspacePath, "rebase", "--onto", head, assignment.baseCommit, assignment.branch);
      } catch {
        await git(assignment.workspacePath, "rebase", "--abort").catch(() => {});
        return result(false, `this run's changes conflict with work that landed on ${assignment.targetBranch} while it ran, so they were left on ${assignment.branch}`);
      }
      source = (await git(assignment.workspacePath, "rev-parse", "HEAD")).stdout;
    }
    try {
      await git(assignment.repositoryPath, "merge", "--ff-only", source);
    } catch (error) {
      return result(false, `${error instanceof Error ? error.message : String(error)} — the work is on ${assignment.branch}`);
    }
    const landed = (await git(assignment.repositoryPath, "rev-parse", "HEAD")).stdout;
    await this.repositories.recordWorkspaceCommit(runId, landed, "verified");
    return { integrated: true, commit: landed, branch: assignment.branch };
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
