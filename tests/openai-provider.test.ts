import test from "node:test";
import assert from "node:assert/strict";
import { streamOpenAITurn } from "../lib/openai-provider";
import { providerForModel, fetchModels } from "../lib/nexotao";

/** Build a fetch stub that returns the given SSE `data:` payloads as a stream
 * and records the request body it was called with. */
function sseFetch(chunks: string[]) {
  const calls: any[] = [];
  const encoder = new TextEncoder();
  const fn = async (_url: string, init: any) => {
    calls.push({ url: _url, body: JSON.parse(init.body) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(`data: ${c}\n\n`));
        controller.close();
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  };
  return { fn, calls };
}

test("providerForModel routes Claude to anthropic and everything else to openai", () => {
  assert.equal(providerForModel("claude-opus-4-8"), "anthropic");
  assert.equal(providerForModel("gpt-5.6-terra"), "openai");
  assert.equal(providerForModel("gpt-5.6-luna"), "openai");
});

test("streamOpenAITurn translates a GPT tool call into Anthropic tool_use blocks", async () => {
  const { fn, calls } = sseFetch([
    JSON.stringify({ choices: [{ delta: { content: "Let me look." }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_dir", arguments: "" } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":".' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
    "[DONE]",
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = fn as any;
  try {
    const streamed: string[] = [];
    const turn = await streamOpenAITurn({
      apiKey: "k",
      model: "gpt-5.6-terra",
      system: "sys",
      tools: [{ name: "list_dir", description: "List files", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      messages: [{ role: "user", content: "list the dir" }],
      onText: (t) => streamed.push(t),
    });

    // Text was streamed incrementally and captured as a text block.
    assert.deepEqual(streamed, ["Let me look."]);
    const textBlock = turn.content.find((b) => b.type === "text");
    assert.equal(textBlock?.text, "Let me look.");

    // The tool call round-trips to an Anthropic tool_use block with parsed input.
    const toolUse = turn.content.find((b) => b.type === "tool_use");
    assert.equal(toolUse?.name, "list_dir");
    assert.equal(toolUse?.id, "call_1");
    assert.deepEqual(toolUse?.input, { path: "." });

    assert.equal(turn.stop_reason, "tool_use");
    assert.deepEqual(turn.usage, { input_tokens: 42, output_tokens: 7 });

    // Outgoing request used the OpenAI shape: system message + function tools.
    const body = calls[0].body;
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, "list_dir");
  } finally {
    globalThis.fetch = original;
  }
});

test("streamOpenAITurn maps an Anthropic transcript with tool results to OpenAI messages", async () => {
  const { fn, calls } = sseFetch([
    JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    "[DONE]",
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = fn as any;
  try {
    const turn = await streamOpenAITurn({
      apiKey: "k",
      model: "gpt-5.6-luna",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "read_file", input: { path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "file body", is_error: false }] },
      ],
    });
    assert.equal(turn.stop_reason, "end_turn");

    const msgs = calls[0].body.messages;
    // assistant tool_use -> tool_calls, then a role:"tool" message keyed by id.
    const assistant = msgs.find((m: any) => m.role === "assistant");
    assert.equal(assistant.tool_calls[0].id, "call_9");
    assert.equal(assistant.tool_calls[0].function.name, "read_file");
    const toolMsg = msgs.find((m: any) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_9");
    assert.equal(toolMsg.content, "file body");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchModels includes the GPT 5.6 series alongside Claude", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      models: [
        { model: "claude-opus-4-8", display_name: "Claude Opus 4.8", tier: "opus", provider: "azure-anthropic", context_window: 350000 },
        { model: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", tier: "gpt", provider: "azure-openai", context_window: null },
        { model: "gpt-5-mini", display_name: "GPT-5 Mini", tier: "gpt", provider: "azure-openai", context_window: null },
        { model: "grok-4.3", display_name: "Grok 4.3", tier: "grok", provider: "azure-openai", context_window: null },
      ],
    }),
  })) as any;
  try {
    const models = await fetchModels();
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("claude-opus-4-8"));
    assert.ok(ids.includes("gpt-5.6-terra"));
    // Non-5.6 GPT and other providers are excluded for now.
    assert.ok(!ids.includes("gpt-5-mini"));
    assert.ok(!ids.includes("grok-4.3"));
    // Claude sorts ahead of GPT.
    assert.ok(ids.indexOf("claude-opus-4-8") < ids.indexOf("gpt-5.6-terra"));
    assert.equal(models.find((m) => m.id === "gpt-5.6-terra")?.provider, "openai");
  } finally {
    globalThis.fetch = original;
  }
});
