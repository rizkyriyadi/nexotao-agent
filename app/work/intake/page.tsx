import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { IntakeView } from "@/components/work/IntakeView";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Intake() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return (
    <AppShell active="work">
      <WorkPage title="Intake" subtitle="work waiting for a decision on whether it belongs here">
        <IntakeView />
      </WorkPage>
    </AppShell>
  );
}
