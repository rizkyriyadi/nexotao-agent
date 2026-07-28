import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { ModuleDetail } from "@/components/work/ModuleDetail";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Module({ params }: { params: Promise<{ id: string }> }) {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  const { id } = await params;
  return (
    <AppShell active="work">
      <WorkPage title="Module" subtitle="ownership and progress">
        <ModuleDetail id={id} />
      </WorkPage>
    </AppShell>
  );
}
