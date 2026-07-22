import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, approvals, heartbeatRuns } from "./db/schema";
import { getDatabase, type AppDatabase } from "./db/database";
import { redactText, redactValue } from "./redact";
import { getRun, type Run } from "./run-manager";

export type ExecutionPolicy = "ask" | "allow" | "deny";
/** Paperclip-style run modes. `agent` runs autonomously (auto-approve edits
 *  and commands), `plan` investigates read-only and writes a plan, `ask` just
 *  answers questions. Modes map onto the execution policy below. */
export type AgentMode = "agent" | "plan" | "ask";
export const AGENT_MODES: readonly AgentMode[] = ["agent", "plan", "ask"];
export const DEFAULT_MODE: AgentMode = "agent";
export type PolicyAction = "read" | "write" | "exec" | "network" | "destructive" | "control";
export type PolicyRisk = "low" | "medium" | "high";
export type PolicyDetails = { action: PolicyAction; target: string; risk: PolicyRisk; preview: string };

type ToolRequest = { id: string; name: string; input: unknown; thread: string };

const DESTRUCTIVE_COMMAND = /(?:^|[;&|]\s*)(?:rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)|(?:sudo\s+)?(?:shutdown|reboot|mkfs|fdisk)\b|dd\s+if=|kill\s+-9\b)/i;

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function clipped(value: unknown, length = 4_000) {
  const safe = redactText(value);
  return safe.length > length ? `${safe.slice(0, length)}\n… (truncated)` : safe;
}

export function describeToolAction(name: string, input: unknown): PolicyDetails {
  const value = inputRecord(input);
  if (name === "bash") {
    const command = String(value.command ?? "");
    const destructive = DESTRUCTIVE_COMMAND.test(command);
    return { action: destructive ? "destructive" : "exec", target: clipped(command, 500), risk: destructive ? "high" : "medium", preview: clipped(command) };
  }
  if (name === "write_file") {
    return { action: "write", target: clipped(value.path, 500), risk: "medium", preview: clipped(value.content) };
  }
  if (name === "edit_file") {
    return {
      action: "write", target: clipped(value.path, 500), risk: "medium",
      preview: clipped(`- ${String(value.old_str ?? "")}\n+ ${String(value.new_str ?? "")}`),
    };
  }
  if (name === "web_search") return { action: "network", target: clipped(value.query, 500), risk: "medium", preview: clipped(value.query) };
  if (name === "web_fetch") return { action: "network", target: clipped(value.url, 500), risk: "medium", preview: clipped(value.url) };
  if (["spawn_agents", "delegate"].includes(name)) return { action: "control", target: name, risk: "low", preview: clipped(input) };
  if (["list_dir", "read_file", "grep"].includes(name)) return { action: "read", target: clipped(value.path ?? name, 500), risk: "low", preview: clipped(input) };
  return { action: "exec", target: name, risk: "high", preview: clipped(input) };
}

export function evaluateExecutionPolicy(policy: ExecutionPolicy, details: PolicyDetails): "allow" | "deny" | "ask" {
  if (details.action === "read" || details.action === "control") return "allow";
  // Auto ("allow") mode still routes genuinely destructive actions (rm -rf,
  // git reset --hard, mkfs, …) through an explicit approval prompt.
  if (policy === "allow" && details.action === "destructive") return "ask";
  return policy;
}

/** Tool execution policy for a run mode. `agent` auto-approves (destructive
 *  actions are still gated by evaluateExecutionPolicy); `plan`/`ask` deny every
 *  mutation, leaving only the always-allowed read/control tools. */
export function modeToPolicy(mode: AgentMode): ExecutionPolicy {
  return mode === "agent" ? "allow" : "deny";
}

/** System-prompt directive appended for a run mode. Agent mode adds nothing —
 *  it keeps the default autonomous behaviour. */
export function modeSystemDirective(mode: AgentMode): string {
  if (mode === "plan")
    return "\n\nPLAN MODE: Investigate the project read-only and produce a clear, numbered implementation plan. File writes and shell commands are disabled — do not attempt to modify anything or you will be denied. Finish with the proposed plan; the user can execute it with one click (Execute plan), so do NOT tell them to switch modes manually.\n\nIf — and only if — some choices genuinely need the user's decision before building, append at the VERY END of your reply a single HTML comment with valid JSON, exactly in this shape:\n<!--decisions [{\"q\":\"Question text?\",\"options\":[\"Option A\",\"Option B\"]}] -->\nInclude 1–4 questions, each with 2–5 short options. Still mention these choices in the prose above. If no decisions are needed, do not add the comment.";
  if (mode === "ask")
    return "\n\nASK MODE: Answer the user's question using read-only inspection only (list_dir, read_file, grep, web_search, web_fetch). File writes and shell commands are disabled — do not modify the project.";
  return "";
}

export async function authorizeTool(run: Run, policy: ExecutionPolicy, tool: ToolRequest) {
  const details = describeToolAction(tool.name, tool.input);
  const decision = evaluateExecutionPolicy(policy, details);
  if (decision === "allow") return true;
  if (decision === "deny") return false;

  let approvalId: string | undefined;
  const projectId = run.meta?.projectId || null;
  if (projectId && run.id) {
    const database = await getDatabase();
    const heartbeat = database.read((db) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).get());
    const row = await database.write((db) => {
      const existing = db.select().from(approvals).where(and(eq(approvals.runId, run.id), eq(approvals.toolCallId, tool.id))).get();
      if (existing) return existing;
      const now = Date.now();
      const created = {
        id: randomUUID(), type: "execution", projectId, issueId: heartbeat?.issueId ?? null, runId: run.id, toolCallId: tool.id,
        action: details.action, target: details.target, risk: details.risk, preview: details.preview,
        payload: redactValue({ name: tool.name, input: tool.input, thread: tool.thread }), status: "pending",
        decisionNote: null, expiresAt: now + 24 * 60 * 60_000, decidedAt: null, resumedAt: null, createdAt: now,
      };
      db.insert(approvals).values(created).run();
      if (heartbeat) db.update(heartbeatRuns).set({ status: "waiting", updatedAt: now }).where(eq(heartbeatRuns.id, run.id)).run();
      db.insert(activityLog).values({
        id: randomUUID(), actorType: "system", actorId: null, action: "approval.requested", entityType: "approval",
        entityId: created.id, summary: { action: details.action, target: details.target, risk: details.risk }, runId: run.id, createdAt: now,
      }).run();
      return created;
    });
    approvalId = row.id;
  }

  run.push({ type: "approval", id: tool.id, approvalId, name: tool.name, input: redactValue(tool.input), thread: tool.thread, ...details });
  return (await run.awaitApproval(tool.id)) === "allow";
}

export async function resolveExecutionApproval(input: { approvalId?: string; runId?: string; toolCallId?: string; decision: "allow" | "deny"; note?: string }, databaseOverride?: AppDatabase) {
  if (!input.approvalId && !(input.runId && input.toolCallId)) throw new Error("approvalId or runId/toolCallId is required");
  const database = databaseOverride ?? await getDatabase();
  const result = await database.write((db) => {
    const filter = input.approvalId
      ? eq(approvals.id, input.approvalId)
      : and(eq(approvals.runId, input.runId!), eq(approvals.toolCallId, input.toolCallId!));
    const current = db.select().from(approvals).where(filter).get();
    if (!current) return { state: "not_found" as const, approval: null };
    if (current.status !== "pending" || current.resumedAt) return { state: "already_resolved" as const, approval: current };

    const run = current.runId ? getRun(current.runId) : undefined;
    const expired = Boolean(current.expiresAt && current.expiresAt <= Date.now());
    if (!run || run.finished || run.cancelled || expired) {
      const now = Date.now();
      db.update(approvals).set({ status: "expired", decisionNote: "Run is no longer waiting", decidedAt: now }).where(eq(approvals.id, current.id)).run();
      db.insert(activityLog).values({ id: randomUUID(), actorType: "system", actorId: null, action: "approval.expired", entityType: "approval", entityId: current.id, summary: { reason: "run_not_waiting" }, runId: current.runId, createdAt: now }).run();
      return { state: "expired" as const, approval: { ...current, status: "expired", decidedAt: now }, run: undefined };
    }

    const now = Date.now();
    const status = input.decision === "allow" ? "approved" : "rejected";
    db.update(approvals).set({ status, decisionNote: input.note ?? null, decidedAt: now, resumedAt: now }).where(and(eq(approvals.id, current.id), eq(approvals.status, "pending"))).run();
    if (current.runId) db.update(heartbeatRuns).set({ status: "running", updatedAt: now }).where(and(eq(heartbeatRuns.id, current.runId), eq(heartbeatRuns.status, "waiting"))).run();
    db.insert(activityLog).values({
      id: randomUUID(), actorType: "user", actorId: null, action: `approval.${status}`, entityType: "approval", entityId: current.id,
      summary: { decision: input.decision, action: current.action, target: current.target }, runId: current.runId, createdAt: now,
    }).run();
    return { state: "resolved" as const, approval: { ...current, status, decidedAt: now, resumedAt: now }, run };
  });

  if (result.state === "resolved" && result.run && result.approval?.toolCallId) result.run.resolveApproval(result.approval.toolCallId, input.decision);
  return { state: result.state, approval: result.approval };
}
export async function expireInvalidExecutionApprovals(projectId: string, databaseOverride?: AppDatabase) {
  const database = databaseOverride ?? await getDatabase();
  return database.write((db) => {
    const pending = db.select().from(approvals).where(and(eq(approvals.projectId, projectId), eq(approvals.status, "pending"))).all();
    const now = Date.now();
    let expired = 0;
    for (const approval of pending) {
      const run = approval.runId ? getRun(approval.runId) : undefined;
      if (run && !run.finished && !run.cancelled && (!approval.expiresAt || approval.expiresAt > now)) continue;
      db.update(approvals).set({ status: "expired", decisionNote: "Run is no longer waiting", decidedAt: now }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))).run();
      db.insert(activityLog).values({
        id: randomUUID(), actorType: "system", actorId: null, action: "approval.expired", entityType: "approval", entityId: approval.id,
        summary: { reason: "run_not_waiting" }, runId: approval.runId, createdAt: now,
      }).run();
      expired += 1;
    }
    return expired;
  });
}
