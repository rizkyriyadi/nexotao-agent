import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { InboxPage } from "@/components/inbox/Inbox";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Inbox() {
  const config = await getConfig();
  if (!config.onboarded) redirect("/onboarding");
  return <AppShell active="inbox"><InboxPage /></AppShell>;
}
