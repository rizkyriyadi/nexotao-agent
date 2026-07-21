import type { Run } from "./run-manager";
import { isMutating } from "./tools";

export type ExecutionPolicy = "ask" | "allow" | "deny";

export async function authorizeTool(run: Run, policy: ExecutionPolicy, tool: { id: string; name: string; input: unknown; thread: string }) {
  if (!isMutating(tool.name)) return true;
  if (policy === "allow") return true;
  if (policy === "deny") return false;
  run.push({ type: "approval", id: tool.id, name: tool.name, input: tool.input, thread: tool.thread });
  return (await run.awaitApproval(tool.id)) === "allow";
}
