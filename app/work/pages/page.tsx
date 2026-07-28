import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { PagesView } from "@/components/work/PagesView";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Pages() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return (
    <AppShell active="work">
      <WorkPage title="Pages" subtitle="notes, specs and decisions beside the board">
        <PagesView />
      </WorkPage>
    </AppShell>
  );
}
