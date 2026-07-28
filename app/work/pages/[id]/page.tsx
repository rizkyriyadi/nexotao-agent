import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkPage } from "@/components/work/WorkNav";
import { PageDetail } from "@/components/work/PageDetail";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function PageEditor({ params }: { params: Promise<{ id: string }> }) {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  const { id } = await params;
  return (
    <AppShell active="work">
      <WorkPage title="Page" subtitle="markdown, versioned on every save">
        <PageDetail id={id} />
      </WorkPage>
    </AppShell>
  );
}
