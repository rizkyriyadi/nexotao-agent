import { AppShell } from "@/components/AppShell";
import { GraphView } from "@/components/graph/GraphView";

export const dynamic = "force-dynamic";

// User-facing view of the project's knowledge graph (work history + optional
// code graph). Reads the merged graph from the graph engine's output; renders a
// dependency-free force-directed view with search, filter, and node inspection.
export default function GraphPage() {
  return (
    <AppShell active="graph">
      <GraphView />
    </AppShell>
  );
}
