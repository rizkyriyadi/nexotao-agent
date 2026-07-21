import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { nexotao, DEFAULT_MODEL } from "@/lib/nexotao";

export const runtime = "nodejs";
export const maxDuration = 120;

const FALLBACK = [
  { name: "Backend", scope: "APIs, data models, and server logic" },
  { name: "Frontend", scope: "UI, components, and client state" },
  { name: "Tests", scope: "Unit and integration coverage" },
  { name: "Reviewer", scope: "Reviews diffs for bugs and security" },
];

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json");
  return JSON.parse(text.slice(start, end + 1));
}

export async function POST(req: Request) {
  // key/model may come straight from onboarding (before config is saved)
  const { name, path, apiKey, model } = (await req.json()) as { name?: string; path?: string; apiKey?: string; model?: string };
  const cfg = await getConfig();
  const key = apiKey || cfg.apiKey;
  const useModel = model || cfg.model || DEFAULT_MODEL;

  if (!key) return NextResponse.json({ agents: FALLBACK, source: "fallback" });

  try {
    const client = nexotao(key);
    const prompt = `You are configuring a team of AI coding sub-agents that a lead agent will delegate to for one specific software project.

Project name: ${name ?? "unknown"}
Local path: ${path ?? "unknown"}

Infer the likely kind of project from its name and path, then propose 3–5 specialist sub-agents tailored to THIS project (not generic). Each agent has:
- "name": 1–2 words (e.g. "Backend", "API", "UI", "Tests", "Migrations", "Auth", "Payments")
- "scope": one short line describing what it owns in this project

Return ONLY minified JSON, no prose: {"agents":[{"name":"...","scope":"..."}]}`;

    const msg = await client.messages.create({ model: useModel, max_tokens: 700, messages: [{ role: "user", content: prompt }] });
    const text = (msg.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = extractJson(text);
    const agents = Array.isArray(json.agents) && json.agents.length ? json.agents.slice(0, 5) : FALLBACK;
    return NextResponse.json({ agents, source: agents === FALLBACK ? "fallback" : "ai" });
  } catch (e) {
    return NextResponse.json({ agents: FALLBACK, source: "fallback", error: String(e) });
  }
}
