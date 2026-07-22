"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Search, Share2, Crosshair, X, RefreshCw } from "lucide-react";

// ── Types (mirror /api/graph) ────────────────────────────────────────────────
type Node = {
  id: string;
  kind: string;
  label: string;
  status?: string;
  community?: number;
  degree?: number;
  source?: string;
  meta?: Record<string, unknown> & { summary?: string; agent?: string; ts?: number };
};
type Edge = { from: string; to: string; rel: string; conf?: "EXTRACTED" | "INFERRED" };
type GraphResponse = {
  project: { id: string; name: string } | null;
  projectId: string | null;
  empty: boolean;
  nodes: Node[];
  edges: Edge[];
  generatedAt: number | null;
};

// ── Visual language ──────────────────────────────────────────────────────────
const KIND_COLOR: Record<string, string> = {
  task: "#5b57f5", // electric-indigo
  run: "#2f6fd0", // sapphire
  agent: "#4f9a15", // lichen-green
  memory: "#c9821a", // amber
  symbol: "#6f6862", // bark-grey
  doc: "#9a6dd7", // lavender
};
const kindColor = (k: string) => KIND_COLOR[k] ?? "#a8a29b";

// ── Deterministic force-directed layout (no external dependency) ─────────────
type Pt = { x: number; y: number };
type Layout = { pos: Map<string, Pt>; view: { minX: number; minY: number; w: number; h: number } };

// Small deterministic PRNG so the layout is stable across renders/reloads.
function seeded(i: number) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function computeLayout(nodes: Node[], edges: Edge[]): Layout {
  const n = nodes.length;
  const pos = new Map<string, Pt>();
  if (n === 0) return { pos, view: { minX: 0, minY: 0, w: 100, h: 100 } };

  const area = 1_000_000;
  const k = Math.sqrt(area / n) * 0.85; // ideal edge length
  const R = Math.sqrt(area) / 2;

  // Seed on a phyllotaxis-like spiral + jitter → deterministic, well spread.
  nodes.forEach((node, i) => {
    const a = i * 2.399963; // golden angle
    const r = R * Math.sqrt((i + 0.5) / n);
    pos.set(node.id, { x: r * Math.cos(a) + (seeded(i) - 0.5) * 30, y: r * Math.sin(a) + (seeded(i + n) - 0.5) * 30 });
  });

  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  const links = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)] as const)
    .filter(([a, b]) => a !== undefined && b !== undefined) as [number, number][];

  const iterations = n <= 60 ? 300 : n <= 200 ? 160 : n <= 500 ? 90 : 50;
  const disp: Pt[] = nodes.map(() => ({ x: 0, y: 0 }));
  let temp = R * 0.35;
  const cool = temp / (iterations + 1);
  const P = nodes.map((node) => pos.get(node.id)!);

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) { disp[i].x = 0; disp[i].y = 0; }

    // Repulsion (O(n²) — fine for the modest graphs this UI targets).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x;
        let dy = P[i].y - P[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = seeded(i * 31 + j) - 0.5; dy = seeded(j * 17 + i) - 0.5; dist = Math.hypot(dx, dy) || 0.01; }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx; disp[i].y += fy;
        disp[j].x -= fx; disp[j].y -= fy;
      }
    }

    // Attraction along edges.
    for (const [a, b] of links) {
      const dx = P[a].x - P[b].x;
      const dy = P[a].y - P[b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[a].x -= fx; disp[a].y -= fy;
      disp[b].x += fx; disp[b].y += fy;
    }

    // Gravity toward origin keeps disconnected pieces from drifting away.
    for (let i = 0; i < n; i++) {
      disp[i].x -= P[i].x * 0.012;
      disp[i].y -= P[i].y * 0.012;
    }

    // Apply with temperature-limited step.
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      P[i].x += (disp[i].x / d) * Math.min(d, temp);
      P[i].y += (disp[i].y / d) * Math.min(d, temp);
    }
    temp = Math.max(temp - cool, 1);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach((node, i) => {
    pos.set(node.id, P[i]);
    minX = Math.min(minX, P[i].x); minY = Math.min(minY, P[i].y);
    maxX = Math.max(maxX, P[i].x); maxY = Math.max(maxY, P[i].y);
  });
  const pad = Math.max(80, (maxX - minX) * 0.08);
  return { pos, view: { minX: minX - pad, minY: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 } };
}

function nodeRadius(degree: number) {
  return 5 + Math.min(Math.sqrt(degree) * 3.2, 16);
}

function ago(ts?: number) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Component ────────────────────────────────────────────────────────────────
export function GraphView() {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, s: 1 });
  const pan = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number }>({ active: false, startX: 0, startY: 0, ox: 0, oy: 0 });

  const load = () => {
    setLoading(true);
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d: GraphResponse) => { setData(d); setError(null); })
      .catch(() => setError("Could not load the graph."))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);

  const layout = useMemo(() => computeLayout(nodes, edges), [nodes, edges]); // recompute only when data changes

  // Reset view whenever a fresh layout is produced.
  useEffect(() => { setTransform({ x: 0, y: 0, s: 1 }); }, [layout]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const nd of nodes) counts.set(nd.kind, (counts.get(nd.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [nodes]);

  const nodeById = useMemo(() => new Map(nodes.map((nd) => [nd.id, nd])), [nodes]);

  const q = query.trim().toLowerCase();
  const isVisible = (nd: Node) => !hidden.has(nd.kind);
  const matches = (nd: Node) => q === "" || nd.label.toLowerCase().includes(q) || nd.id.toLowerCase().includes(q);

  const neighborIds = useMemo(() => {
    if (!selected) return new Set<string>();
    const s = new Set<string>();
    for (const e of edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, edges]);

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const selectedEdges = useMemo(
    () => (selected ? edges.filter((e) => e.from === selected || e.to === selected) : []),
    [selected, edges],
  );

  // Labels: cap clutter — show the highest-degree nodes, plus selection context.
  const labelCutoff = useMemo(() => {
    const degs = nodes.map((nd) => nd.degree ?? 0).sort((a, b) => b - a);
    return degs.length > 40 ? degs[39] : 0;
  }, [nodes]);

  // ── Pan / zoom ──
  function toLocal(clientX: number, clientY: number): Pt {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const local = p.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }
  function onWheel(e: ReactWheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const L = toLocal(e.clientX, e.clientY);
    setTransform((t) => {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const s = Math.min(6, Math.max(0.25, t.s * factor));
      return { s, x: L.x - ((L.x - t.x) * s) / t.s, y: L.y - ((L.y - t.y) * s) / t.s };
    });
  }
  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pan.current = { active: true, startX: e.clientX, startY: e.clientY, ox: transform.x, oy: transform.y };
  }
  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!pan.current.active) return;
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    const scaleX = ctm ? 1 / ctm.a : 1;
    const scaleY = ctm ? 1 / ctm.d : 1;
    setTransform((t) => ({ ...t, x: pan.current.ox + (e.clientX - pan.current.startX) * scaleX, y: pan.current.oy + (e.clientY - pan.current.startY) * scaleY }));
  }
  function endPan() { pan.current.active = false; }

  const resetView = () => setTransform({ x: 0, y: 0, s: 1 });

  const toggleKind = (k: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const { minX, minY, w, h } = layout.view;
  const empty = !loading && (data?.empty ?? nodes.length === 0);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <div className="flex items-center gap-2 text-charcoal">
          <Share2 className="size-[18px] text-electric-indigo" strokeWidth={1.9} />
          <h1 className="text-[15px] font-semibold">Knowledge graph</h1>
        </div>
        {data?.project && <span className="font-mono text-[11px] text-pebble">{data.project.name}</span>}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-8 w-[240px] items-center gap-2 rounded-full border border-line-strong px-3.5 focus-within:border-electric-indigo">
            <Search className="size-4 text-pebble" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search nodes"
              aria-label="Search graph nodes"
              className="w-full bg-transparent text-[13px] text-charcoal outline-none placeholder:text-pebble"
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")} className="text-pebble hover:text-charcoal">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <button
            onClick={resetView}
            aria-label="Reset view"
            title="Reset view"
            className="flex size-8 items-center justify-center rounded-full border border-line-strong text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"
          >
            <Crosshair className="size-4" />
          </button>
          <button
            onClick={load}
            aria-label="Reload graph"
            title="Reload graph"
            className="flex size-8 items-center justify-center rounded-full border border-line-strong text-bark-grey transition-colors hover:border-charcoal hover:text-charcoal"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Filter chips */}
      {kinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-6 py-2">
          {kinds.map(([k, count]) => {
            const on = !hidden.has(k);
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                aria-pressed={on}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                  on ? "border-line-strong bg-white text-charcoal" : "border-line bg-transparent text-pebble line-through"
                }`}
              >
                <span className="size-2 rounded-full" style={{ background: kindColor(k) }} />
                {k}
                <span className="text-pebble">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto text-[11.5px] text-pebble">
            {nodes.length} nodes · {edges.length} edges
          </span>
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 bg-code-surface/40">
          {empty ? (
            <EmptyState projectId={data?.projectId ?? null} hasProject={!!data?.project} />
          ) : error ? (
            <div className="flex h-full items-center justify-center text-[13px] text-alarm-red">{error}</div>
          ) : (
            <svg
              ref={svgRef}
              className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
              viewBox={`${minX} ${minY} ${w} ${h}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`Force-directed graph of ${nodes.length} nodes and ${edges.length} edges. Use the node list on the right to inspect nodes.`}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPan}
              onPointerLeave={endPan}
            >
              <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.s})`}>
                {/* Edges */}
                <g strokeLinecap="round">
                  {edges.map((e, i) => {
                    const a = layout.pos.get(e.from); const b = layout.pos.get(e.to);
                    const na = nodeById.get(e.from); const nb = nodeById.get(e.to);
                    if (!a || !b || !na || !nb) return null;
                    if (!isVisible(na) || !isVisible(nb)) return null;
                    const touchesSel = selected != null && (e.from === selected || e.to === selected);
                    const dim = (q !== "" && !(matches(na) || matches(nb))) || (selected != null && !touchesSel);
                    return (
                      <line
                        key={i}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={touchesSel ? "#5b57f5" : "#d5d2cd"}
                        strokeWidth={touchesSel ? 1.6 : 0.8}
                        strokeOpacity={dim ? 0.08 : touchesSel ? 0.7 : 0.4}
                        strokeDasharray={e.conf === "INFERRED" ? "4 3" : undefined}
                      />
                    );
                  })}
                </g>
                {/* Nodes */}
                <g>
                  {nodes.map((nd) => {
                    if (!isVisible(nd)) return null;
                    const p = layout.pos.get(nd.id); if (!p) return null;
                    const r = nodeRadius(nd.degree ?? 0);
                    const isSel = nd.id === selected;
                    const isNeighbor = neighborIds.has(nd.id);
                    const dim = (q !== "" && !matches(nd)) || (selected != null && !isSel && !isNeighbor);
                    const showLabel = isSel || isNeighbor || nd.id === hover || (nd.degree ?? 0) >= labelCutoff;
                    return (
                      <g
                        key={nd.id}
                        transform={`translate(${p.x} ${p.y})`}
                        opacity={dim ? 0.2 : 1}
                        style={{ cursor: "pointer" }}
                        onClick={(ev) => { ev.stopPropagation(); setSelected((s) => (s === nd.id ? null : nd.id)); }}
                        onPointerEnter={() => setHover(nd.id)}
                        onPointerLeave={() => setHover((cur) => (cur === nd.id ? null : cur))}
                      >
                        <circle
                          r={r}
                          fill={kindColor(nd.kind)}
                          stroke={isSel ? "#26221f" : "#ffffff"}
                          strokeWidth={isSel ? 2.5 : 1.2}
                        />
                        {showLabel && (
                          <text
                            x={0}
                            y={r + 11}
                            textAnchor="middle"
                            className="select-none"
                            style={{ fontSize: 10, fill: "#26221f", paintOrder: "stroke", stroke: "#fbfbfa", strokeWidth: 3 }}
                          >
                            {nd.label.length > 26 ? nd.label.slice(0, 25) + "…" : nd.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>
          )}
          {!empty && !error && (
            <p className="pointer-events-none absolute bottom-3 left-4 text-[11px] text-pebble">Scroll to zoom · drag to pan · click a node</p>
          )}
        </div>

        {/* Side panel */}
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-warm-bone">
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              edges={selectedEdges}
              nodeById={nodeById}
              onClose={() => setSelected(null)}
              onSelect={(id) => setSelected(id)}
            />
          ) : (
            <div className="border-b border-line px-4 py-3 text-[12px] text-pebble">
              Select a node to inspect its connections, or search and pick one below.
            </div>
          )}
          <NodeList
            nodes={nodes}
            visible={(nd) => isVisible(nd) && matches(nd)}
            selected={selected}
            onSelect={(id) => setSelected(id)}
          />
        </aside>
      </div>
    </div>
  );
}

function NodeDetail({
  node, edges, nodeById, onClose, onSelect,
}: {
  node: Node;
  edges: Edge[];
  nodeById: Map<string, Node>;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const when = ago(node.meta?.ts);
  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: kindColor(node.kind) }} />
          <span className="text-[11px] uppercase tracking-wide text-pebble">{node.kind}</span>
        </div>
        <button aria-label="Close node details" onClick={onClose} className="text-pebble hover:text-charcoal">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-1.5 break-words text-[14px] font-medium text-charcoal">{node.label}</p>
      <p className="break-all font-mono text-[10.5px] text-pebble">{node.id}</p>

      <dl className="mt-2 space-y-1 text-[12px]">
        {node.status && <Row label="status" value={node.status} />}
        {node.source && <Row label="source" value={node.source} mono />}
        {node.meta?.agent && <Row label="agent" value={String(node.meta.agent)} />}
        {typeof node.community === "number" && <Row label="community" value={String(node.community)} />}
        <Row label="degree" value={String(node.degree ?? 0)} />
        {when && <Row label="updated" value={when} />}
      </dl>

      {node.meta?.summary && (
        <p className="mt-2 rounded-lg bg-code-surface px-2.5 py-2 text-[12px] leading-snug text-bark-grey">{String(node.meta.summary)}</p>
      )}

      <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-pebble">Connections ({edges.length})</p>
      <ul className="mt-1 max-h-[220px] space-y-0.5 overflow-y-auto pr-1">
        {edges.map((e, i) => {
          const outgoing = e.from === node.id;
          const otherId = outgoing ? e.to : e.from;
          const other = nodeById.get(otherId);
          return (
            <li key={i}>
              <button
                onClick={() => onSelect(otherId)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-black/[0.03]"
              >
                <span className="text-pebble">{outgoing ? "→" : "←"}</span>
                <span className="shrink-0 rounded bg-mist-lavender px-1.5 py-0.5 text-[10px] text-deep-violet">{e.rel}</span>
                <span className="truncate text-charcoal">{other?.label ?? otherId}</span>
              </button>
            </li>
          );
        })}
        {edges.length === 0 && <li className="px-1.5 py-1 text-[12px] text-pebble">No connections.</li>}
      </ul>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-pebble">{label}</dt>
      <dd className={`truncate text-charcoal ${mono ? "font-mono text-[11px]" : ""}`} title={value}>{value}</dd>
    </div>
  );
}

function NodeList({
  nodes, visible, selected, onSelect,
}: {
  nodes: Node[];
  visible: (n: Node) => boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const shown = nodes.filter(visible).sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-pebble">Nodes ({shown.length})</p>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {shown.map((nd) => (
          <li key={nd.id}>
            <button
              onClick={() => onSelect(nd.id)}
              aria-label={`${nd.kind}: ${nd.label}`}
              aria-current={selected === nd.id}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                selected === nd.id ? "bg-electric-indigo/10 text-charcoal" : "text-bark-grey hover:bg-black/[0.03]"
              }`}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: kindColor(nd.kind) }} />
              <span className="truncate">{nd.label}</span>
              <span className="ml-auto shrink-0 text-[10.5px] text-pebble">{nd.degree ?? 0}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-2 text-[12px] text-pebble">No matching nodes.</li>}
      </ul>
    </div>
  );
}

function EmptyState({ projectId, hasProject }: { projectId: string | null; hasProject: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-line bg-white px-6 py-7 text-center shadow-float">
        <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-electric-indigo/12 text-electric-indigo">
          <Share2 className="size-5" strokeWidth={1.8} />
        </span>
        <h2 className="mt-3 text-[15px] font-semibold text-charcoal">No graph yet</h2>
        {hasProject ? (
          <>
            <p className="mt-1.5 text-[13px] leading-relaxed text-bark-grey">
              The knowledge graph builds itself as agents complete tasks — every task, run, agent and memory link becomes a
              node you can explore here.
            </p>
            {projectId && (
              <p className="mt-3 break-all rounded-lg bg-code-surface px-3 py-2 font-mono text-[11px] text-pebble">
                ~/.nexotao/graph/{projectId}/work.json
              </p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[13px] leading-relaxed text-bark-grey">
            Open a project first — the graph is scoped to the active project&apos;s task history.
          </p>
        )}
      </div>
    </div>
  );
}
