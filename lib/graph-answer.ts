// Where the two halves of the graph meet.
//
// `graph_query`, `graph_path` and `graph_explain` each have two sources now: the
// code index (lib/code-memory.ts — symbols, call graphs, source) and the work
// history (lib/graphify.ts — tasks, runs, agents, sessions). They are disjoint,
// so the answers are labelled and concatenated rather than interleaved.
//
// Every function here holds one contract: **the work-history half alone is a
// complete answer.** The code index is optional software the user may never have
// installed, so when it is absent this module returns exactly what it returned
// before it existed — same text, same `ok`, no error, no mention of a missing
// binary. That is the day-one state for every user.
//
// This lives outside lib/tools.ts so the merge is testable without going through
// the executeTool dispatcher.
import { queryGraph, pathGraph, explainNode } from "./graphify";
import { canonicalRoot, searchCode, traceCode, explainCode, type CliDeps, type CodeHit } from "./code-memory";
import { expandHome } from "./paths";

export type GraphAnswer = { ok: boolean; text: string; display: string };

export type AnswerDeps = CliDeps & {
  /** Skip project resolution. Tests pass this; callers never need to. */
  projectId?: string | null;
  /** Injected so tests do not need a database. */
  resolveProject?: (root: string) => Promise<string | null>;
};

const SOURCE_CAP = 4_000;

/**
 * Which project's index answers for a run rooted at `root`.
 *
 * A run's root is the project folder, so this is usually a direct match — but
 * the folder can be a subdirectory or a linked worktree of a repository the
 * project is registered under, so canonicalRoot maps it to the owning repo
 * first. The active project is a fallback, not the primary answer: in a
 * workspace with several projects the active one may not be the one this run is
 * executing in.
 */
export async function resolveProjectId(root: string): Promise<string | null> {
  try {
    const canonical = expandHome(await canonicalRoot(root));
    const { listProjects, getActiveProject } = await import("./store");
    const projects = await listProjects();
    const match = projects.find((project) => expandHome(project.path) === canonical);
    if (match) return match.id;
    return (await getActiveProject())?.id ?? null;
  } catch {
    return null;
  }
}

async function projectFor(root: string, deps?: AnswerDeps): Promise<string | null> {
  if (deps && "projectId" in deps) return deps.projectId ?? null;
  return (deps?.resolveProject ?? resolveProjectId)(root);
}

// search_graph reports repo-relative paths; get_code_snippet reports absolute
// ones. Two shapes for one symbol invites the model to paste a machine-specific
// path into a file it writes, so both are normalised to repo-relative here.
// Compared separator-insensitively: on Windows the base is `D:\…` while the
// indexer reports `D:/…`, so a literal prefix test matched neither and left an
// absolute machine-specific path in the answer.
const relativize = (file: string, base: string) => {
  if (!base) return file;
  const norm = (value: string) => value.replace(/\\/g, "/");
  const prefix = `${norm(base)}/`;
  return norm(file).startsWith(prefix) ? norm(file).slice(prefix.length) : file;
};

const location = (hit: { file: string; startLine: number; endLine: number }, base = "") => {
  const file = relativize(hit.file, base);
  return hit.startLine ? `${file}:${hit.startLine}${hit.endLine && hit.endLine !== hit.startLine ? `-${hit.endLine}` : ""}` : file;
};

const codeLine = (hit: CodeHit) => `• ${hit.name}  ${hit.kind}  ${location(hit)}`;

/** Both layers in parallel; each degrades on its own. */
export async function answerGraphQuery(question: string, root: string, deps?: AnswerDeps): Promise<GraphAnswer> {
  const projectId = await projectFor(root, deps);
  const [work, hits] = await Promise.all([
    queryGraph(question, projectId ?? undefined),
    projectId ? searchCode(projectId, question, 8, deps) : Promise.resolve(null),
  ]);

  const sections: string[] = [];
  if (hits?.length) sections.push(`Code (${hits.length} symbol${hits.length === 1 ? "" : "s"}):\n${hits.map(codeLine).join("\n")}`);
  sections.push(`Work history:\n${work.text}`);

  return {
    ok: work.ok,
    text: sections.join("\n\n"),
    display: hits?.length ? `${hits.length} symbols · ${work.nodes.length} nodes` : `${work.nodes.length} nodes`,
  };
}

/**
 * Work history first: it resolves `task:NEXA-26`-style ids and free labels, and
 * answering from it keeps today's behaviour byte-identical for every input that
 * works today. The call graph is consulted only when that finds nothing.
 */
export async function answerGraphPath(a: string, b: string, root: string, deps?: AnswerDeps): Promise<GraphAnswer> {
  const projectId = await projectFor(root, deps);
  const work = await pathGraph(a, b, projectId ?? undefined);
  if (work.ok && work.path.length) return { ok: true, text: work.text, display: `${work.edges.length} hops` };

  const trace = projectId ? await traceCode(projectId, a, deps) : null;
  if (!trace?.hops.length) return { ok: work.ok, text: work.text, display: work.path.length ? `${work.edges.length} hops` : "no path" };

  const needle = b.toLowerCase();
  const reached = trace.hops.filter((hop) => hop.name.toLowerCase() === needle || hop.qualifiedName.toLowerCase().endsWith(`.${needle}`));
  const lines = trace.hops.map((hop) => `  ${hop.direction === "caller" ? "←" : "→"} hop ${hop.hop}: ${hop.name}`);
  const verdict = reached.length
    ? `"${b}" is reached from "${a}" in ${Math.min(...reached.map((hop) => hop.hop))} hop(s) of the call graph.`
    : `"${b}" does not appear within ${trace.hops.length} call-graph hop(s) of "${a}".`;

  return {
    ok: true,
    text: `Work history:\n${work.text}\n\nCall graph:\n${verdict}\n${lines.join("\n")}`,
    display: reached.length ? `${Math.min(...reached.map((hop) => hop.hop))} hops (calls)` : "no path",
  };
}

/** Work history first (it owns the id namespace), then the symbol index. */
export async function answerGraphExplain(ref: string, root: string, deps?: AnswerDeps): Promise<GraphAnswer> {
  const projectId = await projectFor(root, deps);
  const work = await explainNode(ref, projectId ?? undefined);
  if (work.node) return { ok: true, text: `Work history:\n${work.text}`, display: work.node.kind };

  const snippet = projectId ? await explainCode(projectId, ref, deps) : null;
  if (!snippet) return { ok: work.ok, text: work.text, display: "not found" };

  const facts = [
    snippet.complexity != null ? `complexity ${snippet.complexity}` : null,
    snippet.cognitive != null ? `cognitive ${snippet.cognitive}` : null,
    snippet.callers != null ? `${snippet.callers} caller(s)` : null,
    snippet.callees != null ? `${snippet.callees} callee(s)` : null,
  ].filter(Boolean);

  const source = snippet.source.length > SOURCE_CAP ? `${snippet.source.slice(0, SOURCE_CAP)}\n… (truncated)` : snippet.source;
  const base = await canonicalRoot(root).catch(() => root);
  const lines = [
    `Code:`,
    `${snippet.name}  ${snippet.kind}  ${location(snippet, base)}`,
    snippet.qualifiedName ? `  qualified: ${snippet.qualifiedName}` : null,
    snippet.signature ? `  signature: ${snippet.signature}` : null,
    facts.length ? `  ${facts.join(", ")}` : null,
    "",
    source,
  ].filter((line) => line !== null);

  return { ok: true, text: lines.join("\n"), display: snippet.kind };
}
