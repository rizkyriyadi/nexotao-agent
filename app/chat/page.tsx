import { AppShell } from "@/components/AppShell";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // remount the workspace (and reload the conversation) whenever the session/task changes
  const key = (sp.session as string) || (sp.task as string) || "new";
  return (
    <AppShell active="chat">
      <WorkspaceShell key={key} />
    </AppShell>
  );
}
