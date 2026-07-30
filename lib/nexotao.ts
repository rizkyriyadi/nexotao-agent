// Nexotao API. One balance, two wire formats behind the same key:
//  - Claude models speak the Anthropic Messages API (/v1/messages, x-api-key).
//  - GPT models speak the OpenAI Chat Completions API (/v1/chat/completions,
//    Authorization: Bearer). The gateway rejects GPT on /v1/messages, so the
//    provider decides which transport a given model uses. Docs: https://docs.nexotao.com
import Anthropic from "@anthropic-ai/sdk";

export const NEXOTAO_BASE = "https://api.nexotao.com";
export const DEFAULT_MODEL = "claude-opus-4-8";

/** The model ids the Nexotao gateway serves and this app supports today: the
 *  Claude Opus series on the Anthropic transport, plus GPT-5.6 Sol.
 *
 *  This list is what `fetchModels` filters the live catalog by, and that is
 *  deliberate. The filter used to test `m.provider === "azure-anthropic"`, a
 *  field the gateway owns and duly renamed to `anthropic` — at which point every
 *  Claude model vanished from the picker with nothing failing anywhere: the
 *  catalog still returned them, the request still succeeded, and the filter
 *  quietly matched none of them. Selecting by id couples us to the one thing a
 *  model cannot change without becoming a different model. */
export const AVAILABLE_MODEL_IDS: readonly string[] = [
  "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "gpt-5.6-sol",
];

/** How many tokens one assistant turn may produce.
 *
 *  This is a ceiling, not a reservation: a turn that answers in 200 tokens
 *  costs 200 either way, so the only thing a low value buys is being cut off.
 *  The old 8192 was cheap to set and expensive to live with — asked for a
 *  single-file React app, the model would narrate its plan, start the
 *  `write_file` call, and hit the wall mid-argument. The file never landed and
 *  the run said "Done". Probed against the gateway: every Claude model in the
 *  catalog and the GPT 5.6 series accept 32000, so it is a real limit and not
 *  an optimistic one. */
export const DEFAULT_MAX_TOKENS = 32_000;

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

/** Live catalog, narrowed to {@link AVAILABLE_MODEL_IDS}.
 *
 * Intersected with the live response rather than returned from the constant, so
 * an id the gateway stops serving disappears on its own instead of sitting in
 * the picker until someone notices the 404s. */
export async function fetchModels(): Promise<NexotaoModel[]> {
  const res = await fetch(`${NEXOTAO_BASE}/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = (await res.json()) as { models: any[] };
  const supported = new Set(AVAILABLE_MODEL_IDS);
  return (data.models ?? [])
    .filter((m) => supported.has(m.model))
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

// The catalog is a remote call, but every run and every model-change request
// needs to know whether an id is real. Cached briefly so a burst of requests
// costs one round-trip, and short enough that a newly-added model appears
// without a restart.
const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { at: number; models: NexotaoModel[] } | undefined;

/** The catalog, cached. Falls back to the last good copy if the gateway is
 *  unreachable, so a transient outage cannot make every model look invalid. */
export async function cachedModels(): Promise<NexotaoModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  try {
    const models = await fetchModels();
    catalogCache = { at: Date.now(), models };
    return models;
  } catch (error) {
    if (catalogCache) return catalogCache.models;
    throw error;
  }
}

/** Resolve a user-supplied model id to a real catalog entry, or null. Returning
 *  null rather than throwing lets a caller fall back to the default instead of
 *  failing the request outright. */
export async function resolveModel(id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  const wanted = id.trim();
  return (await cachedModels().catch(() => [])).find((m) => m.id === wanted)?.id ?? null;
}

/** @deprecated Use {@link fetchModels}. Retained for callers that only want the
 * Claude subset. */
export async function fetchClaudeModels(): Promise<NexotaoModel[]> {
  return (await fetchModels()).filter((m) => m.provider === "anthropic");
}
