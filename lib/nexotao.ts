// Nexotao API. One balance, two wire formats behind the same key:
//  - Claude models speak the Anthropic Messages API (/v1/messages, x-api-key).
//  - GPT models speak the OpenAI Chat Completions API (/v1/chat/completions,
//    Authorization: Bearer). The gateway rejects GPT on /v1/messages, so the
//    provider decides which transport a given model uses. Docs: https://docs.nexotao.com
import Anthropic from "@anthropic-ai/sdk";

export const NEXOTAO_BASE = "https://api.nexotao.com";
export const DEFAULT_MODEL = "claude-opus-4-8";

export type Provider = "anthropic" | "openai";
export type NexotaoModel = { id: string; name: string; ctx: number | null; tier: string; provider: Provider };

/** Which transport a model id uses. Claude models are the only ones served on
 * the Anthropic-native endpoint; everything else (GPT, …) goes through the
 * OpenAI-compatible endpoint. Kept synchronous so the tool loop can route
 * without an extra catalog round-trip. */
export function providerForModel(model: string): Provider {
  return /^claude/i.test(model) ? "anthropic" : "openai";
}

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

// Ordering for the picker: Claude first (default coding models), then GPT.
const TIER_ORDER = ["opus", "sonnet", "gpt"];

/** Live catalog, filtered to the models this app supports today: every Claude
 * model plus the GPT 5.6 series (served over the OpenAI-compatible endpoint). */
export async function fetchModels(): Promise<NexotaoModel[]> {
  const res = await fetch(`${NEXOTAO_BASE}/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = (await res.json()) as { models: any[] };
  return (data.models ?? [])
    .filter((m) => m.provider === "azure-anthropic" || /^gpt-5\.6/i.test(m.model))
    .map((m) => ({
      id: m.model,
      name: m.display_name,
      ctx: m.context_window ?? null,
      tier: m.tier,
      provider: providerForModel(m.model),
    }))
    .sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.tier), tb = TIER_ORDER.indexOf(b.tier);
      if (ta !== tb) return (ta < 0 ? TIER_ORDER.length : ta) - (tb < 0 ? TIER_ORDER.length : tb);
      return a.id < b.id ? 1 : -1; // newest id first within a tier
    });
}

/** @deprecated Use {@link fetchModels}. Retained for callers that only want the
 * Claude subset. */
export async function fetchClaudeModels(): Promise<NexotaoModel[]> {
  return (await fetchModels()).filter((m) => m.provider === "anthropic");
}
