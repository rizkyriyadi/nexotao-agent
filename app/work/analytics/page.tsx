import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { AnalyticsView } from "@/components/work/AnalyticsView";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Analytics() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return (
    <AppShell active="work">
      <WorkPage title="Analytics" subtitle="throughput, cycle time and burn-down">
        <AnalyticsView />
      </WorkPage>
    </AppShell>
  );
}
