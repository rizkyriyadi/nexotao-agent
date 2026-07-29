// Provider-neutral entry point for one assistant turn. The tool loop calls this
// and always gets back the same Anthropic-shaped result — text streamed via
// `onText`, plus a final message with content blocks, a stop reason, and usage —
// regardless of whether the model is a Claude (Anthropic Messages API) or a GPT
// (OpenAI Chat Completions API) behind the Nexotao gateway.
import { nexotao, providerForModel, DEFAULT_MAX_TOKENS } from "./nexotao";
import { streamOpenAITurn, type AssistantTurn } from "./openai-provider";

export type { AssistantTurn };

/** How long a turn may produce *nothing* before we give up on it. Measured
 *  between tokens, not for the whole turn: a long answer that keeps streaming is
 *  healthy however many minutes it takes, while a stream that has gone quiet is
 *  not coming back. Without this a dropped connection left the run parked
 *  forever — no error, no socket, no CPU, and a task stuck on "running" that no
 *  restart or cancel could resolve, because nothing was ever going to settle. */
export const TURN_STALL_TIMEOUT_MS = 120_000;

export class TurnStalledError extends Error {
  constructor(ms: number) {
    super(`The model stopped responding (no output for ${Math.round(ms / 1000)}s)`);
    this.name = "TurnStalledError";
  }
}

/** Reject if `work` goes `ms` without calling `progress()`. The timer is reset by
 *  every token, so this bounds silence rather than duration. The abort is
 *  forwarded to the provider so the underlying HTTP request is torn down too —
 *  rejecting alone would leak the socket and keep the stream handler alive.
 *  Exported for the tests: the providers can only be reached over the network,
 *  so this is the seam where the stall behaviour itself can be driven. */
export async function withStallTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal, progress: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; controller.abort(new TurnStalledError(ms)); }, ms);
  };
  arm();
  try {
    return await run(controller.signal, arm);
  } catch (error) {
    // The provider surfaces the abort as its own error type, so translate it
    // back: the caller must be able to tell a stall from a user cancellation.
    if (stalled) throw new TurnStalledError(ms);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

export async function streamAssistantTurn(opts: {
  apiKey: string;
  model: string;
  system?: string;
  tools?: any[];
  messages: any[];
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<AssistantTurn> {
  const { apiKey, model, system, tools = [], messages, maxTokens = DEFAULT_MAX_TOKENS, signal, onText } = opts;

  return withStallTimeout(TURN_STALL_TIMEOUT_MS, signal, async (turnSignal, progress) => {
    // Counts as progress even when the caller isn't listening for text, so a
    // turn streaming into a discarded `onText` still keeps itself alive.
    const onDelta = (text: string) => { progress(); onText?.(text); };

    if (providerForModel(model) === "openai") {
      return streamOpenAITurn({ apiKey, model, system, tools, messages, maxTokens, signal: turnSignal, onText: onDelta });
    }

    const stream = nexotao(apiKey).messages.stream(
      { model, max_tokens: maxTokens, ...(system ? { system } : {}), ...(tools.length ? { tools } : {}), messages },
      { signal: turnSignal },
    );
    stream.on("text", onDelta);
    // Tool arguments stream as input_json deltas with no accompanying text, so a
    // turn that is only calling a tool would otherwise look silent and trip the
    // watchdog mid-flight.
    stream.on("streamEvent", () => progress());
    const final = await stream.finalMessage();
    return {
      content: final.content as any[],
      stop_reason: final.stop_reason,
      usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
    };
  });
}
