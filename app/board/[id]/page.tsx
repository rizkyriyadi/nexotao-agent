import { AppShell } from "@/components/AppShell";
import { TaskView } from "@/components/task/TaskView";

export const dynamic = "force-dynamic";

// Each task has its own page: the conversation thread with the lead, the full
// run history and transcript, and a composer to keep the conversation going.
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell active="board">
      <TaskView id={id} />
    </AppShell>
  );
}
