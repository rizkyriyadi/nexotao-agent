// Work-History Graph engine.
//
// Two responsibilities live here:
//   - build side (Phase 1 / NEXA-28): buildWorkGraph() reads tasks/agentRuns/runRecords
//     and writes graph.json to ~/.nexotao/graph/<projectId>/work.json.
//   - query side (Phase 2 / NEXA-29, this file): pure-TS structural queries over that
//     graph.json — queryGraph / pathGraph / explainNode. No model call, read-only.
//
// The schema is a superset of graphify's graph.json so the same query/path/explain code
// and the graph.html renderer work over both the native work-history layer and an
// optional code-graph layer. See the `graphify-design` doc §4.1–4.3.

import { promises as fs } from "fs";
import path from "path";
import { DIR } from "./config";
import { listAgentRuns, listIssueDependencies, listIssues, listRunRecords, listSessions, listTasks } from "./store";

export type EdgeConf = "EXTRACTED" | "INFERRED";
/** Work-history edge kinds we emit (a subset of GraphEdge.rel's open string). */
export type EdgeRel = "child" | "blockedBy" | "references" | "touched" | "memory-link";

export type GraphNode = {
  id: string;
  /** task | run | agent | memory | symbol | doc | … (superset of graphify's code kinds) */
  kind: string;
  label: string;
  status?: string;
  source?: string; // "lib/agent.ts:15" for code nodes
  community?: number;
  degree?: number;
  meta?: Record<string, unknown>;
};

export type GraphEdge = {
  from: string;
  to: string;
  /** child | blockedBy | references | touched | memory-link | calls | imports | … */
  rel: string;
  conf?: EdgeConf;
};

export type WorkGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

const EMPTY: WorkGraph = { nodes: [], edges: [] };

/** Root directory holding per-project graph.json files: ~/.nexotao/graph/. */
export function graphDir(): string {
  return path.join(DIR, "graph");
}

/** Path to one project's work-history graph. */
export function workGraphPath(projectId: string): string {
  return path.join(graphDir(), projectId, "work.json");
}

/**
 * Path to one project's optional code graph (Phase 5 / NEXA-32). Written by the
 * graphify bridge (lib/graphify-code.ts) when the user has the `graphify` CLI on
 * PATH; absent otherwise. Same location the UI reader (lib/graph-data.ts) loads
 * from, so `graph_query`/`path`/`explain` and the /graph page see one code graph.
 */
export function codeGraphPath(projectId: string): string {
  return path.join(graphDir(), projectId, "graphify-out", "graph.json");
}

// ---------------------------------------------------------------------------
// Build side (Phase 1 / NEXA-28) — construct work.json from the live SQLite
// store. Pure TS over the lib/store.ts boundary; no Python, no new dependency.
// ---------------------------------------------------------------------------

// Issue-style identifiers (NEXA-28, ABC-1) and kanban refs (#7) mentioned in a
// record's free text become `references` / `touched` edges when they resolve to
// an existing node.
const ISSUE_REF = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const KANBAN_REF = /#\d+\b/g;
// `[[slug]]` memory references (the wiki-link convention agents use to relate
// memories). Lower-cased so `[[Nexa-30]]` and `[[nexa-30]]` collapse to one node.
const MEMORY_LINK = /\[\[([^\]\n]+)\]\]/g;

function scanRefs(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.match(ISSUE_REF) ?? []) found.add(m.toUpperCase());
    for (const m of text.match(KANBAN_REF) ?? []) found.add(m);
  }
  return [...found];
}

/** Extract `[[slug]]` memory references from free text as normalized slugs. */
function scanMemoryLinks(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(MEMORY_LINK)) {
      const slug = m[1].trim().toLowerCase();
      if (slug) found.add(slug);
    }
  }
  return [...found];
}

/** Persisted work.json — a WorkGraph plus generation metadata. Extra top-level
 * fields are ignored by loadWorkGraph, so this stays read-compatible. */
export type PersistedWorkGraph = WorkGraph & { version: 1; projectId: string; generatedAt: number };

/**
 * Build the Work-History Graph for a project from the live SQLite store and
 * persist it to `~/.nexotao/graph/<projectId>/work.json`. Nodes: task (issues +
 * kanban tasks), run (agent_runs + run_records), agent, session, memory. Edges:
 * child / blockedBy (EXTRACTED from the issue tree), references (EXTRACTED
 * cross-task id mentions, incl. from sessions), touched (INFERRED run/agent
 * participation), memory-link (EXTRACTED `[[slug]]` references). Returns the
 * graph and its file. This is the full rebuild; run completion appends
 * incrementally via appendRunToWorkGraph (Phase 3) rather than rebuilding.
 */
export async function buildWorkGraph(projectId: string): Promise<{ graph: PersistedWorkGraph; file: string }> {
  const [issues, dependencies, tasks, agentRuns, runRecords, sessions] = await Promise.all([
    listIssues(projectId),
    listIssueDependencies(projectId),
    listTasks(projectId),
    listAgentRuns(projectId),
    listRunRecords(projectId),
    listSessions(projectId),
  ]);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  const byIdentifier = new Map<string, string>(); // NEXA-28 / #7 -> node id
  const issueNodeById = new Map<string, string>(); // issue.id -> node id

  const addNode = (node: GraphNode) => { if (!nodes.has(node.id)) nodes.set(node.id, { degree: 0, ...node }); };
  const addEdge = (from: string, to: string, rel: EdgeRel, conf: EdgeConf) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return; // no self-loops or dangling edges
    const key = `${from}|${to}|${rel}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, rel, conf });
  };

  // --- Nodes ---
  // Issues carry the real task tree (NEXA-xx identifiers, parent links, status).
  for (const issue of issues) {
    const id = `task:${issue.identifier}`;
    issueNodeById.set(issue.id, id);
    byIdentifier.set(issue.identifier.toUpperCase(), id);
    addNode({ id, kind: "task", label: issue.title, status: issue.status, meta: { identifier: issue.identifier, priority: issue.priority, summary: issue.summary || undefined, assigneeAgentId: issue.assigneeAgentId || undefined, ts: issue.updatedAt } });
  }
  // Flat kanban tasks (`#n`) are an older, parallel work surface — include them
  // so history recorded before issues existed is still represented.
  for (const task of tasks) {
    const id = `task:${task.ref}`;
    byIdentifier.set(task.ref, id);
    addNode({ id, kind: "task", label: task.title, status: task.col, meta: { ref: task.ref, agent: task.agent, summary: task.summary, runId: task.runId, ts: task.updatedAt ?? task.createdAt } });
    if (task.agent) addNode({ id: `agent:${task.agent}`, kind: "agent", label: task.agent, meta: {} });
  }
  // Runs: agent_runs (one summary per completed agent task) + run_records.
  for (const run of agentRuns) {
    addNode({ id: `run:${run.id}`, kind: "run", label: run.task || run.summary.slice(0, 80) || run.id, status: run.ok ? "done" : "error", meta: { agent: run.agent, ok: run.ok, summary: run.summary, ts: run.ts } });
    addNode({ id: `agent:${run.agent}`, kind: "agent", label: run.agent, meta: {} });
  }
  for (const run of runRecords) {
    addNode({ id: `run:${run.id}`, kind: "run", label: run.title || run.id, status: run.status, meta: { kind: run.kind, ts: run.updatedAt } });
  }
  // Sessions: chat threads carrying their own history. They reference tasks and
  // memories through the ids/`[[slug]]` links mentioned in their messages.
  for (const session of sessions) {
    addNode({ id: `session:${session.id}`, kind: "session", label: session.title, meta: { ts: session.updatedAt, projectId: session.projectId } });
  }

  // --- Edges ---
  const resolve = (ref: string) => byIdentifier.get(ref.toUpperCase()) ?? byIdentifier.get(ref);
  // memory-link (EXTRACTED): a `[[slug]]` reference in a record's text links its
  // node to a lightweight `memory:<slug>` node created on demand.
  const addMemoryLinks = (from: string, ...texts: Array<string | null | undefined>) => {
    for (const slug of scanMemoryLinks(...texts)) {
      const to = `memory:${slug}`;
      addNode({ id: to, kind: "memory", label: slug, meta: {} });
      addEdge(from, to, "memory-link", "EXTRACTED");
    }
  };
  // child (EXTRACTED): parent issue -> child issue, straight from parent_id.
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const parent = issueNodeById.get(issue.parentId);
    const child = issueNodeById.get(issue.id);
    if (parent && child) addEdge(parent, child, "child", "EXTRACTED");
  }
  // blockedBy (EXTRACTED): issue -> its blocker, from issue_dependencies.
  for (const dep of dependencies) {
    const from = issueNodeById.get(dep.issueId);
    const to = issueNodeById.get(dep.blockerIssueId);
    if (from && to) addEdge(from, to, "blockedBy", "EXTRACTED");
  }
  // references (EXTRACTED): cross-task id mentions in a task's free text.
  for (const issue of issues) {
    const from = issueNodeById.get(issue.id)!;
    for (const ref of scanRefs(issue.title, issue.description, issue.summary)) {
      const to = resolve(ref);
      if (to) addEdge(from, to, "references", "EXTRACTED");
    }
    addMemoryLinks(from, issue.title, issue.description, issue.summary);
  }
  for (const task of tasks) {
    const from = `task:${task.ref}`;
    for (const ref of scanRefs(task.title, task.summary)) {
      const to = resolve(ref);
      if (to) addEdge(from, to, "references", "EXTRACTED");
    }
    addMemoryLinks(from, task.title, task.summary);
  }
  // touched (INFERRED): an agent produced a run; a run touched the tasks its
  // text mentions; a kanban task's assigned agent participated in it.
  for (const run of agentRuns) {
    const from = `run:${run.id}`;
    addEdge(`agent:${run.agent}`, from, "touched", "INFERRED");
    for (const ref of scanRefs(run.task, run.summary)) {
      const to = resolve(ref);
      if (to) addEdge(from, to, "touched", "INFERRED");
    }
    addMemoryLinks(from, run.task, run.summary);
  }
  for (const run of runRecords) {
    const from = `run:${run.id}`;
    for (const ref of scanRefs(run.title)) {
      const to = resolve(ref);
      if (to) addEdge(from, to, "touched", "INFERRED");
    }
  }
  for (const task of tasks) {
    if (task.agent) addEdge(`agent:${task.agent}`, `task:${task.ref}`, "touched", "INFERRED");
  }
  // Session edges: references to the tasks their messages mention, plus any
  // `[[slug]]` memory links. Message bodies are capped so a long thread stays cheap.
  for (const session of sessions) {
    const from = `session:${session.id}`;
    const text = [session.title, ...(session.messages ?? []).map((m) => m.content)].join("\n").slice(0, 20_000);
    for (const ref of scanRefs(text)) {
      const to = resolve(ref);
      if (to) addEdge(from, to, "references", "EXTRACTED");
    }
    addMemoryLinks(from, text);
  }

  // Degrees reflect the emitted (deduped, non-dangling) edge set.
  for (const edge of edges) { nodes.get(edge.from)!.degree = (nodes.get(edge.from)!.degree ?? 0) + 1; nodes.get(edge.to)!.degree = (nodes.get(edge.to)!.degree ?? 0) + 1; }

  const graph: PersistedWorkGraph = { version: 1, projectId, generatedAt: Date.now(), nodes: [...nodes.values()], edges };
  const file = workGraphPath(projectId);
  await persistGraph(file, graph);
  return { graph, file };
}

// ---------------------------------------------------------------------------
// Incremental indexing (Phase 3 / NEXA-30) — append a single finished run's
// nodes/edges to the persisted graph instead of rebuilding. Keeps the graph
// fresh on every run completion without measurably slowing it down.
// ---------------------------------------------------------------------------

/** The just-finished run, as recorded in `agent_runs` (see store.addAgentRun). */
export type FinishedRun = { id: string; agent: string; task: string; summary: string; ok: boolean; ts: number };
/** The issue the run executed on — used to guarantee a task node to attach to. */
export type FinishedRunIssue = { identifier: string; title: string; status?: string };

// Read-modify-write of one work.json is not atomic across concurrent runs, so
// serialize appends per project within this process. Cross-process races are
// out of scope (a single runtime owns the store); the tmp+rename in persistGraph
// still guarantees readers never see a torn file.
const appendChains = new Map<string, Promise<unknown>>();

/**
 * Append a finished run to a project's work-history graph: a `run` node, its
 * `agent`, the `touched` edges to the tasks it names (and to its own issue), and
 * any `[[slug]]` memory-links — deduped against what's already persisted. If no
 * graph exists yet (nothing indexed), seeds it with a one-time full build. Cheap:
 * a few nodes/edges, one file read and one atomic write, no store-wide rebuild.
 */
export function appendRunToWorkGraph(
  projectId: string,
  input: { run: FinishedRun; issue?: FinishedRunIssue },
): Promise<{ appended: number; file: string }> {
  const prior = appendChains.get(projectId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => appendRunNow(projectId, input));
  // Keep the chain alive even if this append rejects, so the next one still runs.
  appendChains.set(projectId, next.catch(() => {}));
  return next;
}

async function appendRunNow(
  projectId: string,
  input: { run: FinishedRun; issue?: FinishedRunIssue },
): Promise<{ appended: number; file: string }> {
  const file = workGraphPath(projectId);
  const existing = await readGraphFile(file);
  // Cold graph: nothing indexed yet. addAgentRun already wrote this run to the
  // store, so a single full build captures it and its full context.
  if (!existing) return { appended: -1, file: (await buildWorkGraph(projectId)).file };

  const nodes = new Map<string, GraphNode>(existing.nodes.map((n) => [n.id, n]));
  const edgeKey = (from: string, to: string, rel: string) => `${from}|${to}|${rel}`;
  const edges = new Map<string, GraphEdge>(existing.edges.map((e) => [edgeKey(e.from, e.to, e.rel), e]));
  let appended = 0;

  const addNode = (node: GraphNode) => { if (!nodes.has(node.id)) { nodes.set(node.id, { degree: 0, ...node }); appended++; } };
  const addEdge = (from: string, to: string, rel: EdgeRel, conf: EdgeConf) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const key = edgeKey(from, to, rel);
    if (edges.has(key)) return;
    edges.set(key, { from, to, rel, conf });
    appended++;
  };

  // Resolve `NEXA-xx` / `#7` references against the task nodes already in the graph.
  const byIdentifier = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "task") continue;
    const suffix = node.id.slice("task:".length);
    byIdentifier.set(suffix.toUpperCase(), node.id);
    byIdentifier.set(suffix, node.id);
  }
  const resolve = (ref: string) => byIdentifier.get(ref.toUpperCase()) ?? byIdentifier.get(ref);

  const { run, issue } = input;
  const runId = `run:${run.id}`;
  addNode({ id: runId, kind: "run", label: run.task || run.summary.slice(0, 80) || run.id, status: run.ok ? "done" : "error", meta: { agent: run.agent, ok: run.ok, summary: run.summary, ts: run.ts } });
  addNode({ id: `agent:${run.agent}`, kind: "agent", label: run.agent, meta: {} });
  if (issue) {
    const taskId = `task:${issue.identifier}`;
    addNode({ id: taskId, kind: "task", label: issue.title, status: issue.status, meta: { identifier: issue.identifier } });
    byIdentifier.set(issue.identifier.toUpperCase(), taskId);
  }

  addEdge(`agent:${run.agent}`, runId, "touched", "INFERRED");
  for (const ref of scanRefs(run.task, run.summary)) {
    const to = resolve(ref);
    if (to) addEdge(runId, to, "touched", "INFERRED");
  }
  if (issue) addEdge(runId, `task:${issue.identifier}`, "touched", "INFERRED");
  for (const slug of scanMemoryLinks(run.summary, run.task, issue?.title)) {
    const to = `memory:${slug}`;
    addNode({ id: to, kind: "memory", label: slug, meta: {} });
    addEdge(runId, to, "memory-link", "EXTRACTED");
  }

  if (!appended) return { appended: 0, file };

  // Recompute degrees over the merged edge set so they stay exact after append.
  for (const node of nodes.values()) node.degree = 0;
  for (const edge of edges.values()) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from) from.degree = (from.degree ?? 0) + 1;
    if (to) to.degree = (to.degree ?? 0) + 1;
  }

  const graph: PersistedWorkGraph = { version: 1, projectId, generatedAt: Date.now(), nodes: [...nodes.values()], edges: [...edges.values()] };
  await persistGraph(file, graph);
  return { appended, file };
}

// Atomic, owner-only write (mirrors the SQLite persist path): tmp file + rename
// so a reader never sees a half-written graph.
async function persistGraph(file: string, graph: PersistedWorkGraph): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(graph, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

async function readGraphFile(file: string): Promise<WorkGraph | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkGraph>;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return { nodes: parsed.nodes as GraphNode[], edges: parsed.edges as GraphEdge[] };
  } catch {
    return null;
  }
}

/**
 * Load the work-history graph. With a projectId, loads just that project's work.json.
 * Without one, merges every project's work.json under ~/.nexotao/graph/ so an agent can
 * query across the entire workspace history ("context luas sampai history semua task").
 * Returns an empty graph if nothing has been indexed yet (Phase 1 not run) — callers stay
 * functional and simply report "graph is empty" rather than erroring.
 */
export async function loadWorkGraph(projectId?: string): Promise<WorkGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const absorb = (g: WorkGraph | null) => {
    if (!g) return;
    for (const n of g.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of g.edges) edges.set(`${e.from} ${e.rel} ${e.to}`, e);
  };
  // Each project contributes its work-history graph plus, when present, its
  // optional graphify code graph (Phase 5) — merged so code + history query as one.
  const absorbProject = async (id: string) => {
    absorb(await readGraphFile(workGraphPath(id)));
    absorb(await readGraphFile(codeGraphPath(id)));
  };

  if (projectId) {
    await absorbProject(projectId);
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  let dirs: string[];
  try {
    const entries = await fs.readdir(graphDir(), { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return EMPTY;
  }
  for (const d of dirs) await absorbProject(d);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ---------------------------------------------------------------------------
// Query helpers (pure, deterministic — no LLM)
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "how", "what", "does", "do", "did", "we", "our", "this", "that", "it", "have", "has",
  "been", "was", "were", "add", "adding", "use", "using", "via", "about", "any",
]);

function tokenize(q: string): string[] {
  const out = new Set<string>();
  for (const m of String(q).matchAll(/[A-Za-z0-9][A-Za-z0-9_\-]*/g)) {
    const raw = m[0];
    const low = raw.toLowerCase();
    if (/^nexa-\d+$/i.test(raw)) out.add(low); // keep issue identifiers whole
    else if (low.length >= 3 && !STOP.has(low)) out.add(low);
  }
  return [...out];
}

function nodeText(n: GraphNode): string {
  const meta = n.meta ? Object.values(n.meta).filter((v) => typeof v === "string").join(" ") : "";
  return `${n.id} ${n.label} ${n.kind} ${n.status ?? ""} ${n.source ?? ""} ${meta}`.toLowerCase();
}

function scoreNode(n: GraphNode, tokens: string[]): number {
  const hay = nodeText(n);
  let score = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) continue;
    // Weight identifier/label hits above meta-body hits.
    score += hay.includes(` ${t}`) || n.id.toLowerCase().includes(t) || n.label.toLowerCase().includes(t) ? 3 : 1;
  }
  return score;
}

function buildAdjacency(g: WorkGraph) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, { edge: GraphEdge; other: string }[]>();
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push({ edge: e, other: e.to });
    adj.get(e.to)!.push({ edge: e, other: e.from });
  }
  return { byId, adj };
}

/** Resolve a user-supplied node reference to a graph node: exact id, then fuzzy label/id. */
function resolveNode(g: WorkGraph, ref: string): GraphNode | null {
  const exact = g.nodes.find((n) => n.id === ref);
  if (exact) return exact;
  const low = ref.toLowerCase();
  const byIdLoose = g.nodes.find((n) => n.id.toLowerCase() === low);
  if (byIdLoose) return byIdLoose;
  const contains = g.nodes
    .filter((n) => n.id.toLowerCase().includes(low) || n.label.toLowerCase().includes(low))
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  return contains[0] ?? null;
}

export type QueryResult = {
  ok: boolean;
  text: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/**
 * queryGraph — scoped subgraph for a plain-language question. Scores nodes by keyword
 * overlap, keeps the top matches, then expands one hop to include their direct neighbours
 * and the connecting edges. Formats a compact, model-readable summary.
 */
export async function queryGraph(question: string, projectId?: string, limit = 8): Promise<QueryResult> {
  const g = await loadWorkGraph(projectId);
  if (!g.nodes.length) {
    return { ok: true, text: "The work-history graph is empty (nothing indexed yet).", nodes: [], edges: [] };
  }
  const tokens = tokenize(question);
  if (!tokens.length) {
    return { ok: true, text: "No searchable terms in the question.", nodes: [], edges: [] };
  }
  const scored = g.nodes
    .map((n) => ({ n, s: scoreNode(n, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.n.degree ?? 0) - (a.n.degree ?? 0))
    .slice(0, limit);

  if (!scored.length) {
    return { ok: true, text: `No graph nodes match: ${tokens.join(", ")}.`, nodes: [], edges: [] };
  }

  const { adj } = buildAdjacency(g);
  const seedIds = new Set(scored.map((x) => x.n.id));
  const keep = new Map<string, GraphNode>(scored.map((x) => [x.n.id, x.n]));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const keepEdges = new Map<string, GraphEdge>();
  for (const id of seedIds) {
    for (const { edge, other } of adj.get(id) ?? []) {
      const neighbor = byId.get(other);
      if (neighbor) keep.set(other, neighbor);
      keepEdges.set(`${edge.from} ${edge.rel} ${edge.to}`, edge);
    }
  }

  const nodes = [...keep.values()];
  const edges = [...keepEdges.values()];
  const lines: string[] = [];
  lines.push(`Matched ${scored.length} node(s) for "${question}" (expanded to ${nodes.length} with neighbours):`);
  for (const { n } of scored) {
    const bits = [n.kind, n.status].filter(Boolean).join(", ");
    const summary = typeof n.meta?.summary === "string" ? ` — ${(n.meta.summary as string).slice(0, 160)}` : "";
    const src = n.source ? ` @ ${n.source}` : "";
    lines.push(`• [${n.id}] ${n.label} (${bits})${src}${summary}`);
  }
  if (edges.length) {
    lines.push("Connections:");
    for (const e of edges.slice(0, 30)) {
      const f = byId.get(e.from)?.label ?? e.from;
      const t = byId.get(e.to)?.label ?? e.to;
      lines.push(`  ${f} --${e.rel}${e.conf === "INFERRED" ? "?" : ""}--> ${t}`);
    }
  }
  return { ok: true, text: lines.join("\n"), nodes, edges };
}

export type PathResult = { ok: boolean; text: string; path: GraphNode[]; edges: GraphEdge[] };

/** pathGraph — shortest (BFS, undirected) path between two nodes referenced by id or label. */
export async function pathGraph(a: string, b: string, projectId?: string): Promise<PathResult> {
  const g = await loadWorkGraph(projectId);
  if (!g.nodes.length) return { ok: true, text: "The work-history graph is empty (nothing indexed yet).", path: [], edges: [] };

  const start = resolveNode(g, a);
  const goal = resolveNode(g, b);
  if (!start) return { ok: false, text: `No node matches "${a}".`, path: [], edges: [] };
  if (!goal) return { ok: false, text: `No node matches "${b}".`, path: [], edges: [] };
  if (start.id === goal.id) return { ok: true, text: `"${start.label}" is the same node.`, path: [start], edges: [] };

  const { byId, adj } = buildAdjacency(g);
  const prev = new Map<string, { via: GraphEdge; from: string }>();
  const seen = new Set([start.id]);
  const queue = [start.id];
  let found = false;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal.id) { found = true; break; }
    for (const { edge, other } of adj.get(cur) ?? []) {
      if (seen.has(other)) continue;
      seen.add(other);
      prev.set(other, { via: edge, from: cur });
      queue.push(other);
    }
  }
  if (!found) return { ok: true, text: `No path between "${start.label}" and "${goal.label}".`, path: [], edges: [] };

  const nodePath: GraphNode[] = [];
  const edgePath: GraphEdge[] = [];
  let cur = goal.id;
  while (cur !== start.id) {
    const step = prev.get(cur)!;
    const node = byId.get(cur);
    if (node) nodePath.unshift(node);
    edgePath.unshift(step.via);
    cur = step.from;
  }
  nodePath.unshift(start);

  const parts: string[] = [];
  for (let i = 0; i < nodePath.length; i++) {
    parts.push(`[${nodePath[i].id}] ${nodePath[i].label}`);
    if (i < edgePath.length) {
      const e = edgePath[i];
      parts.push(`  --${e.rel}${e.conf === "INFERRED" ? "?" : ""}-->`);
    }
  }
  return { ok: true, text: `Path (${edgePath.length} hop(s)):\n${parts.join("\n")}`, path: nodePath, edges: edgePath };
}

export type ExplainResult = { ok: boolean; text: string; node: GraphNode | null };

/** explainNode — source location, community, degree, and all connections of one node. */
export async function explainNode(id: string, projectId?: string): Promise<ExplainResult> {
  const g = await loadWorkGraph(projectId);
  if (!g.nodes.length) return { ok: true, text: "The work-history graph is empty (nothing indexed yet).", node: null };

  const node = resolveNode(g, id);
  if (!node) return { ok: false, text: `No node matches "${id}".`, node: null };

  const { byId, adj } = buildAdjacency(g);
  const conns = adj.get(node.id) ?? [];
  const degree = node.degree ?? conns.length;

  const lines: string[] = [];
  lines.push(`[${node.id}] ${node.label}`);
  lines.push(`  kind: ${node.kind}${node.status ? `, status: ${node.status}` : ""}`);
  if (node.source) lines.push(`  source: ${node.source}`);
  if (node.community != null) lines.push(`  community: ${node.community}`);
  lines.push(`  degree: ${degree}`);
  if (node.meta && Object.keys(node.meta).length) {
    for (const [k, v] of Object.entries(node.meta)) {
      if (typeof v === "string" || typeof v === "number") lines.push(`  ${k}: ${String(v).slice(0, 200)}`);
    }
  }
  if (conns.length) {
    lines.push(`  connections (${conns.length}):`);
    for (const { edge, other } of conns.slice(0, 40)) {
      const dir = edge.from === node.id ? "→" : "←";
      const label = byId.get(other)?.label ?? other;
      lines.push(`    ${dir} ${edge.rel}${edge.conf === "INFERRED" ? "?" : ""}: [${other}] ${label}`);
    }
  } else {
    lines.push("  connections: none");
  }
  return { ok: true, text: lines.join("\n"), node };
}
