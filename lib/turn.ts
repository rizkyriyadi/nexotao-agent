// Provider-neutral entry point for one assistant turn. The tool loop calls this
// and always gets back the same Anthropic-shaped result — text streamed via
// `onText`, plus a final message with content blocks, a stop reason, and usage —
// regardless of whether the model is a Claude (Anthropic Messages API) or a GPT
// (OpenAI Chat Completions API) behind the Nexotao gateway.
import { nexotao, providerForModel } from "./nexotao";
import { streamOpenAITurn, type AssistantTurn } from "./openai-provider";

export type { AssistantTurn };

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
  const { apiKey, model, system, tools = [], messages, maxTokens = 8192, signal, onText } = opts;

  if (providerForModel(model) === "openai") {
    return streamOpenAITurn({ apiKey, model, system, tools, messages, maxTokens, signal, onText });
  }

  const stream = nexotao(apiKey).messages.stream(
    { model, max_tokens: maxTokens, ...(system ? { system } : {}), ...(tools.length ? { tools } : {}), messages },
    { signal },
  );
  if (onText) stream.on("text", (t: string) => onText(t));
  const final = await stream.finalMessage();
  return {
    content: final.content as any[],
    stop_reason: final.stop_reason,
    usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
  };
}
