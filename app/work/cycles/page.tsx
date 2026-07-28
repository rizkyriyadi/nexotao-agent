import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { CyclesView } from "@/components/work/CyclesView";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Cycles() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return (
    <AppShell active="work">
      <WorkPage title="Cycles" subtitle="time-boxed containers work is pulled into">
        <CyclesView />
      </WorkPage>
    </AppShell>
  );
}
