import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Overview } from "@/components/overview/Overview";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cfg = await getConfig();
  if (!cfg.onboarded) redirect("/onboarding");
  return (
    <AppShell active="home">
      <Overview />
    </AppShell>
  );
}
