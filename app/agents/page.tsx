import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AgentsPage } from "@/components/agents/AgentsPage";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Agents() {
  const cfg = await getConfig();
  if (!cfg.onboarded) redirect("/onboarding");
  return (
    <AppShell active="agents">
      <AgentsPage />
    </AppShell>
  );
}
