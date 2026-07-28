import test from "node:test";
import assert from "node:assert/strict";
import { TurnStalledError, TURN_STALL_TIMEOUT_MS, withStallTimeout } from "../lib/turn";

/* A run that lost its connection mid-turn produced no error, no socket, and no
 * CPU — it simply sat on "running" forever, and neither a restart nor a cancel
 * could settle it because nothing was ever going to reject. The turn now bounds
 * *silence*, so a dead stream fails the run instead of stranding it. */

/* Every test here drives a stream that never settles on its own, so a broken
 * watchdog means the assertion never runs. Without a deadline that shows up as a
 * suite that hangs forever — indistinguishable from a slow machine, and useless
 * in CI. These caps turn "the watchdog is gone" into a failure you can read. */
const DEADLINE = 5_000;

/** A stream that emits `chunks` spaced `gapMs` apart and then never finishes —
 *  exactly the shape that wedged the live runs. */
function stream(chunks: number, gapMs: number) {
  return (signal: AbortSignal, progress: () => void) =>
    new Promise<string>((resolve, reject) => {
      let sent = 0;
      const onAbort = () => { clearInterval(tick); reject(signal.reason); };
      const tick = setInterval(() => {
        if (sent++ < chunks) return progress();
        clearInterval(tick);
        // Deliberately neither resolves nor rejects: the connection is gone.
      }, gapMs);
      signal.addEventListener("abort", onAbort, { once: true });
      void resolve;
    });
}

test("a turn that goes silent fails instead of hanging forever", { timeout: DEADLINE }, async () => {
  const started = Date.now();
  await assert.rejects(
    withStallTimeout(60, undefined, stream(0, 1_000)),
    (error: Error) => error instanceof TurnStalledError,
    "a stream that never emits is abandoned",
  );
  assert.ok(Date.now() - started < 1_000, "it gives up on the watchdog, not on the stream");
});

test("a turn still streaming is never cut off, however long it takes", { timeout: DEADLINE }, async () => {
  // Five gaps of 30ms under a 60ms budget: the total run far exceeds the
  // timeout, so this only passes if each token re-arms the timer.
  const value = await withStallTimeout(60, undefined, async (_signal, progress) => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      progress();
    }
    return "finished";
  });
  assert.equal(value, "finished");
});

test("a stall that follows real output is still a stall", { timeout: DEADLINE }, async () => {
  // The live failure: tokens arrived, then the stream died mid-turn. Progress so
  // far must not buy the turn unlimited silence afterwards.
  await assert.rejects(
    withStallTimeout(60, undefined, stream(2, 20)),
    (error: Error) => error instanceof TurnStalledError,
  );
});

test("a user cancellation stays a cancellation, not a stall", { timeout: DEADLINE }, async () => {
  // The two must remain distinguishable: one files the run as cancelled, the
  // other as failed, and conflating them mislabels every cancel.
  const parent = new AbortController();
  const reason = new Error("Cancelled by user");
  setTimeout(() => parent.abort(reason), 20);
  await assert.rejects(
    withStallTimeout(5_000, parent.signal, stream(0, 10_000)),
    (error: Error) => error === reason,
  );
});

test("the stall budget bounds silence, not the length of an answer", () => {
  // A guard on the constant itself: shrinking this to a whole-turn deadline
  // would kill long but healthy answers.
  assert.ok(TURN_STALL_TIMEOUT_MS >= 60_000, "a slow first token must not be mistaken for a dead stream");
  assert.ok(new TurnStalledError(TURN_STALL_TIMEOUT_MS).message.includes("stopped responding"));
});
