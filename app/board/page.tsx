import { AppShell } from "@/components/AppShell";
import { TaskBoard } from "@/components/board/TaskBoard";

export default function BoardPage() {
  return (
    <AppShell active="board">
      <TaskBoard />
    </AppShell>
  );
}
