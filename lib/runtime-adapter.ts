import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { nexotao } from "./nexotao";

export type AdapterMessage = { role: "user" | "assistant"; content: string };
export type AdapterUsage = { inputTokens: number; outputTokens: number };
export type AdapterEvent =
  | { type: "started"; executionId: string; sessionId: string }
  | { type: "text"; text: string }
  | { type: "usage"; usage: AdapterUsage }
  | { type: "completed"; sessionId: string; stopReason?: string | null }
  | { type: "cancelled"; reason: string }
  | { type: "error"; error: string };

export type AdapterCapabilities = {
  streaming: boolean;
  cancellation: boolean;
  usage: boolean;
  sessionResume: boolean;
  tools: boolean;
};

export type AdapterExecuteRequest = {
  model: string;
  messages: AdapterMessage[];
  system?: string;
  maxTokens?: number;
  sessionId?: string;
  /** Runtime-owned cancellation hook used to terminate child process groups. */
  onCancel?: (reason: string) => void | Promise<void>;
};

export type AdapterResumeRequest = Omit<AdapterExecuteRequest, "sessionId"> & {
  sessionId: string;
  /** Allows resume after process restart when the in-memory transcript is gone. */
  history?: AdapterMessage[];
};

export type AdapterExecution = { executionId: string; sessionId: string };

export interface RuntimeAdapter {
  execute(request: AdapterExecuteRequest): Promise<AdapterExecution>;
  events(executionId: string, cursor?: number): AsyncIterable<AdapterEvent>;
  cancel(executionId: string, reason?: string): Promise<boolean>;
  usage(executionId: string): Promise<AdapterUsage>;
  resume(request: AdapterResumeRequest): Promise<AdapterExecution>;
  capabilities(): AdapterCapabilities;
}

type ExecutionState = {
  id: string;
  sessionId: string;
  controller: AbortController;
  events: AdapterEvent[];
  waiters: Set<() => void>;
  done: boolean;
  usage: AdapterUsage;
  transcript: AdapterMessage[];
  onCancel?: AdapterExecuteRequest["onCancel"];
};

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Nexotao Gateway implementation of the runtime boundary. The adapter owns
 * the remote stream; orchestration code only sees the stable contract above. */
export class NexotaoGatewayAdapter implements RuntimeAdapter {
  private readonly client: Anthropic;
  private readonly executions = new Map<string, ExecutionState>();
  private readonly sessions = new Map<string, AdapterMessage[]>();

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? nexotao(apiKey);
  }

  capabilities(): AdapterCapabilities {
    return { streaming: true, cancellation: true, usage: true, sessionResume: true, tools: true };
  }

  async execute(request: AdapterExecuteRequest): Promise<AdapterExecution> {
    const state: ExecutionState = {
      id: randomUUID(), sessionId: request.sessionId ?? randomUUID(), controller: new AbortController(),
      events: [], waiters: new Set(), done: false, usage: { inputTokens: 0, outputTokens: 0 },
      transcript: [...request.messages], onCancel: request.onCancel,
    };
    this.executions.set(state.id, state);
    this.push(state, { type: "started", executionId: state.id, sessionId: state.sessionId });
    void this.pump(state, request);
    return { executionId: state.id, sessionId: state.sessionId };
  }

  async resume(request: AdapterResumeRequest): Promise<AdapterExecution> {
    const history = this.sessions.get(request.sessionId) ?? request.history;
    if (!history) throw new Error(`Session ${request.sessionId} is not available; provide history to resume after restart`);
    return this.execute({ ...request, sessionId: request.sessionId, messages: [...history, ...request.messages] });
  }

  async *events(executionId: string, cursor = 0): AsyncIterable<AdapterEvent> {
    const state = this.executions.get(executionId);
    if (!state) throw new Error(`Unknown adapter execution: ${executionId}`);
    let index = Math.max(0, cursor);
    while (true) {
      while (index < state.events.length) yield state.events[index++];
      if (state.done) return;
      await new Promise<void>((resolve) => state.waiters.add(resolve));
    }
  }

  async cancel(executionId: string, reason = "Cancelled by user"): Promise<boolean> {
    const state = this.executions.get(executionId);
    if (!state || state.done) return false;
    state.controller.abort(new Error(reason));
    await state.onCancel?.(reason);
    return true;
  }

  async usage(executionId: string): Promise<AdapterUsage> {
    const state = this.executions.get(executionId);
    if (!state) throw new Error(`Unknown adapter execution: ${executionId}`);
    return { ...state.usage };
  }

  private push(state: ExecutionState, event: AdapterEvent) {
    state.events.push(event);
    if (["completed", "cancelled", "error"].includes(event.type)) state.done = true;
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  }

  private async pump(state: ExecutionState, request: AdapterExecuteRequest) {
    let assistantText = "";
    try {
      const stream = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 8192,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages,
        stream: true,
      }, { signal: state.controller.signal });
      let stopReason: string | null = null;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          assistantText += event.delta.text;
          this.push(state, { type: "text", text: event.delta.text });
        } else if (event.type === "message_start") {
          state.usage.inputTokens = event.message.usage.input_tokens;
          state.usage.outputTokens = event.message.usage.output_tokens;
          this.push(state, { type: "usage", usage: { ...state.usage } });
        } else if (event.type === "message_delta") {
          state.usage.outputTokens = event.usage.output_tokens;
          stopReason = event.delta.stop_reason;
          this.push(state, { type: "usage", usage: { ...state.usage } });
        }
      }
      state.transcript.push({ role: "assistant", content: assistantText });
      this.sessions.set(state.sessionId, state.transcript);
      this.push(state, { type: "completed", sessionId: state.sessionId, stopReason });
    } catch (error) {
      if (state.controller.signal.aborted) {
        this.push(state, { type: "cancelled", reason: safeError(state.controller.signal.reason) });
      } else {
        this.push(state, { type: "error", error: safeError(error) });
      }
    }
  }
}
