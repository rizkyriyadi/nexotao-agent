import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The orchestrator has been folded into the control panel (/board). Preserve any
// deep link's goal/node so older links keep resolving to the live run.
export default async function OrchestratorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const goal = typeof sp.goal === "string" ? sp.goal : undefined;
  const node = typeof sp.node === "string" ? sp.node : undefined;
  if (!goal) redirect("/board");
  redirect(`/board?goal=${goal}${node ? `&node=${node}` : ""}`);
}
