import { NextResponse } from "next/server";
import { getActiveProject } from "@/lib/store";
import { listAgents, listIssues, seedAgents } from "@/lib/issues";
import { getDatabase } from "@/lib/db/database";
import { AgentLifecycleError, AgentLifecycleService, type AgentConfigInput } from "@/lib/agent-lifecycle";
import { HttpError, jsonError, readJsonObject, stringField } from "@/lib/http";

export const runtime = "nodejs";

function lifecycleError(error: unknown) {
  if (!(error instanceof AgentLifecycleError)) return jsonError(error);
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "confirmation_required" ? 428 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

function objectField(body: Record<string, unknown>, key: string, fallback: Record<string, unknown> = {}) {
  const value = body[key];
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function stringsField(body: Record<string, unknown>, key: string, fallback: string[] = []) {
  const value = body[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(`${key} must be an array of strings`);
  return value as string[];
}

function numberField(body: Record<string, unknown>, key: string, fallback: number | null) {
  const value = body[key];
  if (value === undefined || value === "") return fallback;
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(`${key} must be a number`);
  return parsed;
}

function avatarField(body: Record<string, unknown>): string | null | undefined {
  const value = body.avatar;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1_500_000) throw new HttpError("avatar must be an image URL or data URI under ~1MB");
  return value;
}

function configInput(body: Record<string, unknown>, leadId: string | null): AgentConfigInput {
  const role = body.role === "lead" ? "lead" : "worker";
  const avatar = avatarField(body);
  return {
    name: stringField(body, "name", { required: true, max: 80 })!, role,
    title: stringField(body, "title", { max: 120 }) ?? "Specialist",
    ...(avatar !== undefined ? { avatar } : {}),
    scope: stringField(body, "scope", { max: 2_000 }) ?? "",
    reportsTo: role === "lead" ? null : stringField(body, "reportsTo", { max: 100 }) ?? leadId,
    capabilities: stringsField(body, "capabilities"), adapterType: stringField(body, "adapterType", { max: 80 }) ?? "nexotao",
    adapterConfig: objectField(body, "adapterConfig"), runtimeConfig: objectField(body, "runtimeConfig"),
    permissions: objectField(body, "permissions"), instructions: stringField(body, "instructions", { max: 50_000 }) ?? "",
    projectAccess: stringsField(body, "projectAccess"), concurrency: numberField(body, "concurrency", 1)!,
  };
}

export async function GET() {
  const project = await getActiveProject();
  if (!project) return NextResponse.json({ agents: [], issues: [] });
  let agents = await listAgents(project.id);
  if (agents.length === 0) agents = await seedAgents(project.id, project.agents ?? []);
  const service = new AgentLifecycleService(await getDatabase());
  const issues = await listIssues(project.id);
  return NextResponse.json({ agents: service.list(project.id), issues });
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await getActiveProject();
    if (!project) throw new HttpError("No active project", 400);
    let roster = await listAgents(project.id);
    if (!roster.length) roster = await seedAgents(project.id, project.agents ?? []);
    const lead = roster.find((agent) => agent.role === "lead") ?? null;
    const service = new AgentLifecycleService(await getDatabase());
    const agent = await service.create(project.id, configInput(body, lead?.id ?? null));
    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) { return lifecycleError(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJsonObject(req);
    const id = stringField(body, "id", { required: true, max: 100 })!;
    const service = new AgentLifecycleService(await getDatabase());
    const current = service.get(id);
    const full = configInput({
      name: current.name, role: current.role, title: current.title, avatar: current.avatar, scope: current.scope, reportsTo: current.reportsTo,
      capabilities: current.capabilities, adapterType: current.adapterType, adapterConfig: current.adapterConfig,
      runtimeConfig: current.runtimeConfig, permissions: current.permissions, instructions: current.instructions,
      projectAccess: current.projectAccess, concurrency: current.concurrency,
      ...body,
    }, current.reportsTo);
    const agent = await service.update(id, full);
    return NextResponse.json({ agent });
  } catch (error) { return lifecycleError(error); }
}
