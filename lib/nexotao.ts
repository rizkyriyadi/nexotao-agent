// Nexotao API — Anthropic-compatible (/v1/messages, x-api-key). One balance,
// Claude models for now. Docs: https://docs.nexotao.com
import Anthropic from "@anthropic-ai/sdk";

export const NEXOTAO_BASE = "https://api.nexotao.com";
export const DEFAULT_MODEL = "claude-opus-4-8";

export type NexotaoModel = { id: string; name: string; ctx: number | null; tier: string };

/** Anthropic SDK pointed at Nexotao. Sends x-api-key + hits /v1/messages.
 * `authorization: null` strips the Bearer header the SDK would otherwise
 * auto-add from ANTHROPIC_AUTH_TOKEN / an `ant` profile in the environment —
 * Nexotao reads that header and would reject the (non-nexo) token as 401. */
export function nexotao(apiKey: string) {
  return new Anthropic({
    apiKey,
    baseURL: NEXOTAO_BASE,
    defaultHeaders: { authorization: null },
  });
}

/** Live catalog, filtered to the Claude models we support today. */
export async function fetchClaudeModels(): Promise<NexotaoModel[]> {
  const res = await fetch(`${NEXOTAO_BASE}/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = (await res.json()) as { models: any[] };
  return (data.models ?? [])
    .filter((m) => m.provider === "azure-anthropic")
    .map((m) => ({ id: m.model, name: m.display_name, ctx: m.context_window ?? null, tier: m.tier }))
    .sort((a, b) => (a.id < b.id ? 1 : -1)); // opus 4.8 first
}
