// OpenAI-compatible transport for GPT models on the Nexotao gateway.
//
// The rest of the app speaks the Anthropic Messages shape internally: assistant
// turns are arrays of content blocks (text / tool_use) and tool outputs come
// back as user turns of tool_result blocks. This module is the only place that
// knows about the OpenAI /v1/chat/completions wire format — it translates the
// Anthropic-shaped request out, streams the response, and translates the reply
// back into the same Anthropic blocks the tool loop already understands. That
// keeps persistence, run events, and the UI provider-agnostic.
import { NEXOTAO_BASE } from "./nexotao";

type Block = { type: string; [k: string]: any };
type Msg = { role: "user" | "assistant"; content: string | Block[] };
type ToolDef = { name: string; description?: string; input_schema: any };

export type AssistantTurn = {
  content: Block[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

/** Anthropic tool defs → OpenAI function tools. */
function toOpenAITools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return String(content ?? "");
}

/** Anthropic transcript → OpenAI chat messages. A tool_result block becomes a
 * `role:"tool"` message keyed by the originating call id; assistant tool_use
 * blocks become `tool_calls`. Ordering is preserved so every tool message
 * follows the assistant turn that requested it. */
function toOpenAIMessages(system: string | undefined, convo: Msg[]) {
  const out: any[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of convo) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
        continue;
      }
      const texts = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (texts) out.push({ role: "user", content: texts });
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
        }
      }
    } else {
      if (typeof m.content === "string") {
        out.push({ role: "assistant", content: m.content });
        continue;
      }
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolUses = m.content.filter((b) => b.type === "tool_use");
      const msg: any = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }));
      }
      out.push(msg);
    }
  }
  return out;
}

function safeJSON(text: string): any {
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const FINISH_TO_STOP: Record<string, string> = {
  tool_calls: "tool_use",
  stop: "end_turn",
  length: "max_tokens",
  content_filter: "end_turn",
};

type ToolAcc = { id: string; name: string; args: string };

/** Stream one GPT turn over /v1/chat/completions and return it as an
 * Anthropic-shaped assistant turn. Text deltas are surfaced through `onText`
 * exactly like the Anthropic streaming path. */
export async function streamOpenAITurn(opts: {
  apiKey: string;
  model: string;
  system?: string;
  tools?: ToolDef[];
  messages: Msg[];
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<AssistantTurn> {
  const { apiKey, model, system, tools = [], messages, maxTokens = 8192, signal, onText } = opts;

  const body: any = {
    model,
    messages: toOpenAIMessages(system, messages),
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = "auto";
  }

  const res = await fetch(`${NEXOTAO_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`chat/completions ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }

  let text = "";
  const toolAcc: ToolAcc[] = [];
  let finish: string | null = null;
  const usage = { input_tokens: 0, output_tokens: 0 };

  for await (const event of sseEvents(res.body, signal)) {
    if (event === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(event);
    } catch {
      continue;
    }
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const slot = (toolAcc[i] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }

  const content: Block[] = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolAcc) {
    if (!tc || !tc.name) continue;
    content.push({ type: "tool_use", id: tc.id || `call_${tc.name}`, name: tc.name, input: safeJSON(tc.args) });
  }

  return {
    content,
    stop_reason: (finish && FINISH_TO_STOP[finish]) ?? (finish ? "end_turn" : null),
    usage,
  };
}

/** Minimal SSE line reader over a fetch response body. Yields each `data:`
 * payload (still JSON text, or the literal `[DONE]`). */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; a single event may carry
      // multiple `data:` lines that concatenate.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (data) yield data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}
