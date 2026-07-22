// Cost ledger primitives for NEXA-14 cost controls. Everything here is pure so
// pricing, budget state, and threshold detection stay unit-testable in
// isolation; persistence and enforcement live in the repositories/runtime layer
// which call into these functions.

export type ModelPricing = { input: number; output: number }; // USD per 1M tokens

// Published Nexotao gateway pricing (USD per 1M tokens). Unknown models fall
// back to FALLBACK_PRICING so an unrecognized model degrades gracefully instead
// of silently recording zero cost — the gateway emits a "model metadata not
// found" warning for models it has yet to catalog and we still want a bounded
// charge on the ledger.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// Conservative fallback (opus-tier) for models absent from the table above.
export const FALLBACK_PRICING: ModelPricing = { input: 15, output: 75 };

export function resolvePricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Tolerate versioned/dated aliases such as "claude-haiku-4-5-20251001" by
  // matching on the longest registered prefix before falling back.
  const match = Object.keys(MODEL_PRICING)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return match ? MODEL_PRICING[match] : FALLBACK_PRICING;
}

/** Cost in USD for a single model turn, rounded to micro-dollars to keep the
 * ledger free of floating-point dust. Negative token counts are clamped. */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = resolvePricing(model);
  const cost = (Math.max(0, inputTokens) / 1_000_000) * price.input
    + (Math.max(0, outputTokens) / 1_000_000) * price.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Fractions of the budget that raise a warning. 1.0 (hard stop) is handled
// separately via BudgetStatus.exhausted / the budget.exhausted event.
export const WARNING_THRESHOLDS = [0.5, 0.8, 0.9] as const;

export type BudgetState = "ok" | "warning" | "exhausted";

export type BudgetStatus = {
  limit: number | null;
  spent: number;
  remaining: number | null;
  fraction: number | null;
  state: BudgetState;
  exhausted: boolean;
};

/** Derive budget state from spend. A null / non-positive limit means "no budget
 * configured" and is always `ok`. Exhaustion is spend at-or-above the limit,
 * matching the acceptance criterion that drives the hard stop. */
export function budgetStatus(spent: number, limit: number | null): BudgetStatus {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) {
    return { limit, spent, remaining: null, fraction: null, state: "ok", exhausted: false };
  }
  const fraction = spent / limit;
  const exhausted = spent >= limit;
  const state: BudgetState = exhausted
    ? "exhausted"
    : fraction >= WARNING_THRESHOLDS[0] ? "warning" : "ok";
  return { limit, spent, remaining: Math.max(0, limit - spent), fraction, state, exhausted };
}

/** Warning thresholds newly crossed as spend moves from `previousSpend` to
 * `newSpend`. Returns candidates only; the persistence layer additionally
 * dedupes against already-emitted events so each threshold fires exactly once
 * even under retries or replayed settlements. */
export function crossedThresholds(previousSpend: number, newSpend: number, limit: number | null): number[] {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return [];
  const prev = previousSpend / limit;
  const next = newSpend / limit;
  return WARNING_THRESHOLDS.filter((t) => prev < t && next >= t);
}

export type RunUsage = { model?: string | null; inputTokens: number; outputTokens: number };

/** Collapse the usage samples observed during a run into one settled row per
 * model. Adapters emit cumulative usage, so the max per (model) is the settled
 * total for that model and re-settling with the same samples is idempotent. */
export function settleUsage(samples: RunUsage[]): { model: string; inputTokens: number; outputTokens: number; cost: number }[] {
  const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
  for (const sample of samples) {
    const model = sample.model || "unknown";
    const current = byModel.get(model) ?? { inputTokens: 0, outputTokens: 0 };
    byModel.set(model, {
      inputTokens: Math.max(current.inputTokens, Math.max(0, sample.inputTokens || 0)),
      outputTokens: Math.max(current.outputTokens, Math.max(0, sample.outputTokens || 0)),
    });
  }
  return [...byModel.entries()].map(([model, tokens]) => ({
    model, ...tokens, cost: computeCost(model, tokens.inputTokens, tokens.outputTokens),
  }));
}
