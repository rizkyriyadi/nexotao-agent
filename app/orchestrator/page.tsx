import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The orchestrator has been retired in favour of a single-agent, task-centric
// control panel (/board). Older deep links carried the run in ?goal=; forward
// them to that task's own page.
export default async function OrchestratorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const goal = typeof sp.goal === "string" ? sp.goal : undefined;
  redirect(goal ? `/board/${goal}` : "/board");
}
