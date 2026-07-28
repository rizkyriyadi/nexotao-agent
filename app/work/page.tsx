import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { WorkSurface } from "@/components/work/WorkSurface";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/* The work-management surface: a Plane-style board over the same `issues` the
   agent engine runs. Deliberately separate from /board, which stays the
   prompt-first front door — this one is for organising work, that one is for
   talking to an agent about it. */
export default async function Work() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return <AppShell active="work"><WorkSurface /></AppShell>;
}
