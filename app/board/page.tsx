import { AppShell } from "@/components/AppShell";
import { ControlPanel } from "@/components/task/ControlPanel";

export const dynamic = "force-dynamic";

// The control panel is the single front door: the user prompts, picks a run
// mode (Ask / Agent / Plan), and each request becomes its own task with its own
// page. Existing tasks are listed here for quick re-entry.
export default function BoardPage() {
  return (
    <AppShell active="board">
      <ControlPanel />
    </AppShell>
  );
}
