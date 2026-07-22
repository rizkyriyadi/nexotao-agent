import { AppShell } from "@/components/AppShell";
import { TeamRoom } from "@/components/team-room/TeamRoom";

export const dynamic = "force-dynamic";

// Live Team Room: a real-time view of the agents working together — who is
// active, the hand-offs between them, active runs, and where work is blocked.
// Graphify's work graph made live. Reads the board on a short poll.
export default function TeamRoomPage() {
  return (
    <AppShell active="team-room">
      <TeamRoom />
    </AppShell>
  );
}
