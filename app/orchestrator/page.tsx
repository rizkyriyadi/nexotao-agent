import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { OrchestratorProvider } from "@/components/orchestrator/orchestrator-context";
import { Orchestrator } from "@/components/orchestrator/Orchestrator";

export const dynamic = "force-dynamic";

// The orchestrator is no longer a standalone destination — the control panel
// (board) is the single front door. A goal run stays viewable here via
// ?goal=<id>, but the bare "start a new run" entry point is retired.
export default async function OrchestratorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  if (!sp.goal) redirect("/board");
  return (
    <AppShell active="board">
      <OrchestratorProvider>
        <Orchestrator />
      </OrchestratorProvider>
    </AppShell>
  );
}
