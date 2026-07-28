import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { ModulesView } from "@/components/work/ModulesView";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Modules() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return (
    <AppShell active="work">
      <WorkPage title="Modules" subtitle="the parts of the product work belongs to">
        <ModulesView />
      </WorkPage>
    </AppShell>
  );
}
