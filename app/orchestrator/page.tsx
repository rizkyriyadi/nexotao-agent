import { AppShell } from "@/components/AppShell";
import { OrchestratorProvider } from "@/components/orchestrator/orchestrator-context";
import { Orchestrator } from "@/components/orchestrator/Orchestrator";

export default function OrchestratorPage() {
  return (
    <AppShell active="runs">
      <OrchestratorProvider>
        <Orchestrator />
      </OrchestratorProvider>
    </AppShell>
  );
}
