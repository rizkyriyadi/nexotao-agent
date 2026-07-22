import { AppShell } from "@/components/AppShell";
import { OrchestratorProvider } from "@/components/orchestrator/orchestrator-context";
import { Orchestrator } from "@/components/orchestrator/Orchestrator";

export const dynamic = "force-dynamic";

// The control panel is the single front door: the user prompts, picks a run
// mode (Ask / Agent / Plan), and the lead takes it straight to work. A run stays
// viewable here via ?goal=<id>.
export default function BoardPage() {
  return (
    <AppShell active="board">
      <OrchestratorProvider>
        <Orchestrator />
      </OrchestratorProvider>
    </AppShell>
  );
}
