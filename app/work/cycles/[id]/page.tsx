import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { CycleDetail } from "@/components/work/CycleDetail";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Cycle({ params }: { params: Promise<{ id: string }> }) {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  const { id } = await params;
  return (
    <AppShell active="work">
      <WorkPage title="Cycle" subtitle="progress and burn-down">
        <CycleDetail id={id} />
      </WorkPage>
    </AppShell>
  );
}
