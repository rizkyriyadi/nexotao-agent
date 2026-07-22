// Phase 5 (NEXA-32): optional graphify code-graph bridge.
//
// Fully lazy and fully optional. When the user has the `graphify` CLI on PATH,
// this produces a code graph in the shared graph.json schema and persists it next
// to the work-history graph, so `graph_query`/`path`/`explain` (and the /graph
// page) return code + history together. When Python/graphify is absent, every
// entry point degrades to a clean no-op — no error, no prompt, no size hit.
//
// No Python is bundled. `ensureGraphify` performs a lazy `pip install` into the
// user's existing environment only on explicit opt-in; nothing here adds to
// package.json dependencies or files. Kept in its own module so it never races
// the P1/P2 work-history engine in lib/graphify.ts.
import { promises as fs } from "fs";
import path from "path";
import { runCommand } from "./tools";
import { codeGraphPath, type GraphNode, type GraphEdge, type WorkGraph } from "./graphify";

/** PyPI package that provides the `graphify` CLI (design §1). */
export const GRAPHIFY_PACKAGE = "graphifyy";

/** Sandboxed exec signature (see lib/tools.ts runCommand). Injectable for tests. */
export type Exec = (command: string, root: string, signal?: AbortSignal, timeoutMs?: number) => Promise<{ code: number; output: string }>;

export type BuildCodeGraphOptions = {
  exec?: Exec; // injectable for tests; default = the sandboxed runCommand
  signal?: AbortSignal;
  autoInstall?: boolean; // opt-in only; false by default (no prompt, no surprise install)
  timeoutMs?: number; // graph builds can be slow; default 10 min
};

/** Is the graphify CLI available on PATH? Never throws. */
export async function detectGraphify(exec: Exec = runCommand, root: string = process.cwd()): Promise<boolean> {
  try {
    const r = await exec("graphify --version", root, undefined, 15_000);
    return r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort lazy install of graphify into the user's existing Python env.
 * Opt-in only (`autoInstall`); a no-op returning the current availability
 * otherwise. Never throws and never bundles Python.
 */
export async function ensureGraphify(opts: BuildCodeGraphOptions = {}): Promise<boolean> {
  const exec = opts.exec ?? runCommand;
  if (await detectGraphify(exec)) return true;
  if (!opts.autoInstall) return false; // never install silently
  for (const cmd of [`python3 -m pip install --user ${GRAPHIFY_PACKAGE}`, `pip install --user ${GRAPHIFY_PACKAGE}`]) {
    try {
      if ((await exec(cmd, process.cwd(), opts.signal, 300_000)).code === 0) break;
    } catch {
      /* try the next installer */
    }
  }
  return detectGraphify(exec);
}

/**
 * Build a code graph for `root` using the graphify CLI and return it in the
 * shared WorkGraph schema. Returns null (clean no-op) if graphify is absent or
 * anything fails — malformed output, non-zero exit, timeout — so callers on the
 * hot path never see an error and the app runs unchanged.
 */
export async function buildCodeGraph(root: string, opts: BuildCodeGraphOptions = {}): Promise<WorkGraph | null> {
  const exec = opts.exec ?? runCommand;
  try {
    const present = (await detectGraphify(exec, root)) || (opts.autoInstall ? await ensureGraphify(opts) : false);
    if (!present) return null;
    // graphify emits graph.json; the issue standardizes on graphify-out/graph.json.
    const outDir = "graphify-out";
    const build = await exec(`graphify . --out ${outDir}`, root, opts.signal, opts.timeoutMs ?? 600_000);
    if (build.code !== 0) return null;
    const raw = await readFirst([
      path.join(root, outDir, "graph.json"),
      path.join(root, "graph.json"),
    ]);
    if (!raw) return null;
    return normalizeGraphifyGraph(JSON.parse(raw));
  } catch {
    return null; // absent Python/graphify, malformed output, timeout — all degrade to no-op
  }
}

async function readFirst(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Map graphify's graph.json (loosely typed across versions) into our superset
 * schema. Code ids are namespaced `code:` so they never collide with work-history
 * ids (`task:` / `run:` / `agent:` / `memory:`) when the two graphs merge.
 */
export function normalizeGraphifyGraph(raw: any): WorkGraph {
  const rawNodes: any[] = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const rawEdges: any[] = Array.isArray(raw?.edges) ? raw.edges : Array.isArray(raw?.links) ? raw.links : [];
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const n of rawNodes) {
    const orig = String(n?.id ?? n?.name ?? "");
    if (!orig) continue;
    const id = `code:${orig}`;
    idMap.set(orig, id);
    const file = n?.file ?? n?.path;
    const line = n?.line ?? n?.lineno;
    nodes.push({
      id,
      kind: String(n?.kind ?? n?.type ?? "symbol"),
      label: String(n?.label ?? n?.name ?? orig),
      source: file ? `${file}${line != null ? `:${line}` : ""}` : undefined,
      community: typeof n?.community === "number" ? n.community : undefined,
      degree: typeof n?.degree === "number" ? n.degree : undefined,
      meta: { origin: "graphify" },
    });
  }
  const map = (x: any) => idMap.get(String(x)) ?? (x != null && x !== "" ? `code:${x}` : "");
  const edges: GraphEdge[] = [];
  for (const e of rawEdges) {
    const from = map(e?.from ?? e?.source);
    const to = map(e?.to ?? e?.target);
    if (!from || !to) continue;
    const conf = String(e?.conf ?? e?.confidence ?? "").toUpperCase();
    edges.push({
      from,
      to,
      rel: String(e?.rel ?? e?.type ?? "references"),
      conf: conf === "INFERRED" ? "INFERRED" : conf === "EXTRACTED" ? "EXTRACTED" : undefined,
    });
  }
  return { nodes, edges };
}

/**
 * Build the code graph for a project and persist it to the shared code-graph path
 * (`~/.nexotao/graph/<projectId>/graphify-out/graph.json`) so both the query layer
 * (loadWorkGraph) and the UI reader (graph-data.readProjectGraph) merge it. Returns
 * the number of code nodes persisted, or 0 when graphify is absent / the build was
 * a no-op. On-demand only — never wired to the run-completion hot path.
 */
export async function refreshCodeGraph(projectId: string, root: string, opts?: BuildCodeGraphOptions): Promise<number> {
  const g = await buildCodeGraph(root, opts);
  if (!g) return 0;
  const out = codeGraphPath(projectId);
  await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  // Atomic write (tmp + rename), mirroring persistGraph in lib/graphify.ts, so a
  // concurrent reader never sees a half-written code graph.
  const temp = `${out}.tmp`;
  const persisted = { ...g, generatedAt: Date.now() };
  await fs.writeFile(temp, JSON.stringify(persisted), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, out);
  return g.nodes.length;
}
