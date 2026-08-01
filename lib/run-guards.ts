/* What a run is not allowed to write.
 *
 * One rule, and it is not about Git. The agent may commit and push freely now —
 * it works in the user's own folder, and a tool that can edit every file but not
 * record the result is a strange half-thing. The restriction that used to sit
 * here ("Git commit and push are restricted to the verified integration flow")
 * described a flow that no longer exists.
 *
 * What remains is the agent-instruction Markdown ban, which is independent of
 * how runs execute: `CLAUDE.md`, `AGENTS.md` and their kin are the harness's own
 * standing orders, and a run rewriting them is a run editing its next
 * instructions. */

/** Directories whose *own* Markdown is harness instruction rather than project
 *  content. Only files sitting directly inside one count — see below. */
const AGENT_DIRECTORIES = new Set([".agents", ".agent", ".claude"]);

/** The agent-instruction files a run must not write.
 *
 *  Deliberately an exact list rather than a word match. The rule used to be
 *  `/(?:agent|prompt|instruction|runbook)/` over the basename, which reads as a
 *  reasonable generalisation right up until someone builds an ordinary website:
 *  `travel-agent.md`, `docs/instructions.md`, `blog/prompt-engineering.md` and
 *  `RUNBOOK.md` are all a user's own content, and every one of them tripped it.
 *  These file names are a convention with a fixed spelling; matching them by
 *  substring buys nothing and claims files we have no business claiming.
 *
 *  The directory rule is bounded to *immediate* children for the same reason.
 *  Matching `.claude` anywhere in the path made the whole subtree ours, and that
 *  subtree is where projects keep material they curate on purpose: a knowledge
 *  base under `.claude/kb/`, shared commands, skills. A user who asked for
 *  `.claude/kb/guides/testing.md` had every file they requested silently
 *  refused, then read "the run made no changes" about a run that had written
 *  several. What the harness actually claims is a file directly in the
 *  directory, and that is all this claims. */
export function isProhibitedAgentMarkdown(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const base = parts.at(-1) ?? "";
  if (!base.endsWith(".md")) return false;
  if (["agents.md", "agent.md", "claude.md", "codex.md"].includes(base)) return true;
  return AGENT_DIRECTORIES.has(parts.at(-2) ?? "");
}

/** The `beforeMutation` hook a write-capable run passes to the tool layer.
 *
 *  Throwing here refuses the single tool call and tells the agent why, so it can
 *  route around the refusal — the run itself carries on.
 *
 *  `onRefusal` exists because the agent is the only other party that learns of a
 *  refusal, and it may well not mention it. A run that was told "no" on every
 *  file it tried to write and then reported success would leave the user with a
 *  summary describing work their folder does not contain. */
export function agentWriteGuard(onRefusal?: (file: string) => void) {
  return async (tool: { name: string; input: unknown }) => {
    if (tool.name !== "write_file" && tool.name !== "edit_file") return;
    const file = String((tool.input as { path?: unknown })?.path ?? "");
    if (isProhibitedAgentMarkdown(file)) {
      onRefusal?.(file);
      throw new Error("Agent instruction Markdown is local-only and cannot be written by issue runs");
    }
  };
}
