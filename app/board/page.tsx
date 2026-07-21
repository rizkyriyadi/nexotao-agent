import { AppShell } from "@/components/AppShell";
import { Board } from "@/components/board/Board";

export default function BoardPage() {
  return (
    <AppShell active="board">
      <Board />
    </AppShell>
  );
}
