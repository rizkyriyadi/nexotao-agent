import type { ClaimedHeartbeat, ControlPlaneRepositories, WakeupReason } from "./db/repositories";
import { RunEventDomainError } from "./run-events";

export type HeartbeatTrigger = {
  agentId: string;
  issueId?: string | null;
  reason: WakeupReason;
  eventId: string;
  availableAt?: number;
};

export type HeartbeatOutcome = {
  sessionAfter?: string | null;
  usage?: Record<string, unknown>;
};

export type HeartbeatContext = {
  runId: string;
  signal: AbortSignal;
  emit(type: string, payload: unknown): Promise<void>;
  waiting(reason: string): Promise<void>;
};

export type HeartbeatHandler = (job: ClaimedHeartbeat, context: HeartbeatContext) => Promise<HeartbeatOutcome | void>;

export function triggerIdempotencyKey(trigger: HeartbeatTrigger) {
  return `${trigger.reason}:${trigger.issueId ?? trigger.agentId}:${trigger.eventId}`;
}

/** Persistent queue runner. In-memory state is only used for cancellation of
 * currently executing work; queue ownership and lifecycle remain in SQLite. */
export class DurableHeartbeatRuntime {
  private initialized = false;
  private drainPromise: Promise<void> | undefined;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopped = false;

  constructor(private readonly repositories: ControlPlaneRepositories, private readonly handler: HeartbeatHandler) {}

  async initialize() {
    if (this.initialized) return;
    await this.repositories.recoverOrphanedHeartbeats();
    this.initialized = true;
  }

  async enqueue(trigger: HeartbeatTrigger) {
    await this.initialize();
    if (this.stopped) throw new Error("Heartbeat runtime is stopped");
    const queued = await this.repositories.enqueueHeartbeat({
      agentId: trigger.agentId,
      issueId: trigger.issueId,
      reason: trigger.reason,
      idempotencyKey: triggerIdempotencyKey(trigger),
      availableAt: trigger.availableAt,
    });
    void this.drain();
    return queued;
  }

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.performDrain().finally(() => { this.drainPromise = undefined; });
    return this.drainPromise;
  }

  private async performDrain() {
    await this.initialize();
    try {
      while (true) {
        const job = await this.repositories.claimNextHeartbeat();
        if (!job) break;
        const controller = new AbortController();
        const promise = this.execute(job, controller).finally(async () => {
          this.active.delete(job.heartbeat.id);
          await this.drain();
        });
        this.active.set(job.heartbeat.id, { controller, promise });
      }
    } finally { /* drainPromise is cleared by drain() */ }
  }

  async runUntilIdle() {
    await this.drain();
    while (this.active.size) {
      await Promise.all([...this.active.values()].map((entry) => entry.promise));
      await this.drain();
    }
  }

  async shutdown() {
    await this.runUntilIdle();
    while (this.drainPromise) await this.drainPromise;
    this.stopped = true;
  }


  async cancel(runId: string, reason = "Cancelled by user") {
    const active = this.active.get(runId);
    active?.controller.abort(new Error(reason));
    const heartbeat = this.repositories.getHeartbeat(runId);
    if (!heartbeat || ["succeeded", "failed", "cancelled"].includes(heartbeat.status)) return false;
    try {
      await this.repositories.completeHeartbeat(runId, "cancelled", { reason }, { error: reason });
      return true;
    } catch (error) {
      if (error instanceof RunEventDomainError && error.code === "terminal") return false;
      throw error;
    }
  }

  async retry(runId: string, availableAt: number, error?: string) {
    const requeued = await this.repositories.requeueHeartbeat(runId, availableAt, error);
    if (requeued) void this.drain();
    return requeued;
  }

  private async execute(job: ClaimedHeartbeat, controller: AbortController) {
    const runId = job.heartbeat.id;
    const complete = async (
      status: "succeeded" | "failed" | "cancelled",
      payload: unknown,
      patch: { sessionAfter?: string | null; usage?: Record<string, unknown>; error?: string | null } = {},
    ) => {
      try {
        await this.repositories.completeHeartbeat(runId, status, payload, patch);
      } catch (error) {
        // Cancellation and queue recovery can race with handler settlement. The
        // repository remains strict; the runner treats an existing terminal
        // event as proof that another finalizer already won.
        if (error instanceof RunEventDomainError && error.code === "terminal") return;
        throw error;
      }
    };
    const context: HeartbeatContext = {
      runId,
      signal: controller.signal,
      emit: async (type, payload) => { await this.repositories.appendHeartbeatEvent(runId, type, payload); },
      waiting: async (reason) => {
        await this.repositories.appendHeartbeatEvent(runId, "waiting", { reason });
        await this.repositories.transitionHeartbeat(runId, "waiting");
      },
    };
    try {
      await context.emit("status", { status: "running", attempt: job.wakeup.attempt });
      let rejectOnAbort!: (reason?: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectOnAbort = reject; });
      const onAbort = () => rejectOnAbort(controller.signal.reason ?? new Error("Heartbeat cancelled"));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      let outcome: HeartbeatOutcome | void;
      try {
        outcome = await Promise.race([this.handler(job, context), aborted]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
      if (controller.signal.aborted || this.repositories.getHeartbeat(runId)?.status === "cancelled") return;
      await complete("succeeded", { status: "succeeded", usage: outcome?.usage ?? {} }, {
        sessionAfter: outcome?.sessionAfter, usage: outcome?.usage,
      });
    } catch (error) {
      if (error instanceof RunEventDomainError && error.code === "terminal") return;
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        if (this.repositories.getHeartbeat(runId)?.status === "cancelled") return;
        await complete("cancelled", { status: "cancelled", reason: message }, { error: message });
      } else {
        await complete("failed", { status: "failed", error: message }, { error: message });
      }
    }
  }
}
