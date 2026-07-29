import test from "node:test";
import assert from "node:assert/strict";
import { resumeAfterCutoff, toolLoop } from "../lib/agent";
import { Run } from "../lib/run-manager";
import { DEFAULT_MAX_TOKENS } from "../lib/nexotao";

/* ── the file that never got written ─────────────────────────────────────────
 * Asked to build a single-file React app, the agent narrated its plan, started
 * the write_file call, and hit its output ceiling part-way through the
 * arguments. The provider still returns a tool_use block for that call — with a
 * `path` and no `content`. The loop treated "stop_reason is not tool_use" as
 * "the agent has finished", so the run reported Done with the main source file
 * absent and the project unable to start.
 *
 * Three separate things had to be true for that to happen, and each is pinned
 * below: the ceiling was far lower than the gateway allows, a cutoff was
 * classified as a completion, and the half-parsed call would have been run. */

/** A turn as the provider hands it back. */
const turn = (stop: string, content: any[]) => ({
  content,
  stop_reason: stop,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** Drives `toolLoop` against a scripted list of turns, recording what the loop
 *  sent back to the provider and which tools it actually executed. */
async function drive(turns: ReturnType<typeof turn>[], opts: { maxIters?: number } = {}) {
  const executed: string[] = [];
  const sent: any[][] = [];
  let i = 0;

  const result = await toolLoop({
    run: new Run("r"),
    apiKey: "k",
    model: "m",
    system: "s",
    convo: [{ role: "user", content: "build it" }],
    root: "/tmp",
    thread: "agent",
    approvalPolicy: "allow",
    toolDefs: [],
    maxIters: opts.maxIters ?? 10,
    // Every tool goes through a handler, so nothing touches the real filesystem
    // — but the loop's own authorize-and-dispatch path still runs.
    handlers: {
      write_file: async (input: any) => {
        executed.push(`write_file:${JSON.stringify(input)}`);
        return { output: "written" };
      },
    },
    streamTurn: (async (args: any) => {
      sent.push(structuredClone(args.messages));
      const next = turns[i++];
      if (!next) throw new Error("the loop asked for more turns than the test scripted");
      return next;
    }) as any,
  });

  return { result, executed, sent, turnsUsed: i };
}

test("a run cut off mid-write is continued, not reported as finished", async () => {
  // The exact shape observed in production: narration, then a write_file whose
  // arguments never finished arriving.
  const { result, executed, turnsUsed } = await drive([
    turn("max_tokens", [
      { type: "text", text: "Now the main single-file App. Let me build it comprehensively." },
      { type: "tool_use", id: "t1", name: "write_file", input: { path: "src/App.jsx" } },
    ]),
    turn("tool_use", [
      { type: "tool_use", id: "t2", name: "write_file", input: { path: "src/App.jsx", content: "export default …" } },
    ]),
    turn("end_turn", [{ type: "text", text: "Done — the app builds." }]),
  ]);

  assert.equal(turnsUsed, 3, "the loop carried on past the cutoff instead of returning");
  assert.equal(result.completion, "complete");
  // The half-parsed call must never run: `content` was absent, so executing it
  // would have written an empty file over the one the model was composing.
  assert.deepEqual(executed, ['write_file:{"path":"src/App.jsx","content":"export default …"}']);
});

test("the truncated tool call is dropped and the model is told why", () => {
  const { content, nudge } = resumeAfterCutoff([
    { type: "text", text: "Let me build it comprehensively." },
    { type: "tool_use", id: "t1", name: "write_file", input: { path: "src/App.jsx" } },
  ]);

  assert.equal(content.length, 1, "the incomplete call is gone");
  assert.equal(content[0].type, "text");
  // Naming the tool matters: "continue" alone left the model unsure whether its
  // write had landed, and it would sometimes carry on as though it had.
  assert.match(nudge, /write_file/);
  assert.match(nudge, /nothing ran and nothing was written/);
  // The advice that actually resolves the situation — one more attempt at the
  // same oversized write just hits the same ceiling again.
  assert.match(nudge, /edit_file/);
});

test("a cutoff in mid-sentence keeps the text and asks for the rest", () => {
  const { content, nudge } = resumeAfterCutoff([{ type: "text", text: "The plan is to" }]);
  assert.deepEqual(content, [{ type: "text", text: "The plan is to" }]);
  assert.doesNotMatch(nudge, /discarded/);
  assert.match(nudge, /Continue from exactly where you stopped/);
});

/* Why: a truncated turn can carry several tool calls — earlier ones complete,
   the last one cut in half. The loop answers a cutoff with a text nudge rather
   than tool results, and the API rejects any tool_use left without a matching
   tool_result. Keeping the complete ones "because they parsed fine" 400s the
   next request and turns a recoverable cutoff into a failed run. */
test("every tool call from a truncated turn is dropped, not just the cut one", () => {
  const { content, nudge } = resumeAfterCutoff([
    { type: "text", text: "Reading both files first." },
    { type: "tool_use", id: "a", name: "read_file", input: { path: "x" } },
    { type: "tool_use", id: "b", name: "write_file", input: { path: "y" } },
  ]);

  assert.equal(content.filter((b: any) => b.type === "tool_use").length, 0,
    "an orphaned tool_use would be rejected by the API on the very next turn");
  assert.deepEqual(content, [{ type: "text", text: "Reading both files first." }]);
  // The model has to know the read it was relying on never happened either.
  assert.match(nudge, /read_file, write_file/);
  assert.match(nudge, /nothing ran and nothing was written/);
});

/* Why: the API rejects an assistant message with no content at all. A turn cut
   off before it emitted anything but the opening tool_use leaves an empty array
   once that block is dropped — and the run would then die on a 400 from the
   very next request, turning a recoverable cutoff into a failed run. */
test("dropping the only block still leaves a message the API will accept", () => {
  const { content } = resumeAfterCutoff([
    { type: "tool_use", id: "t1", name: "write_file", input: {} },
  ]);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.ok(String(content[0].text).length > 0);
});

/* Why: a model cut off on every single turn is not composing a large file, it
   is looping. Left alone it would run to the step ceiling, spending the user's
   balance to arrive at the same unfinished answer. */
test("a model cut off over and over gives up rather than burning the budget", async () => {
  const cutoff = () => turn("max_tokens", [{ type: "text", text: "still going" }]);
  const { result, turnsUsed } = await drive(
    [cutoff(), cutoff(), cutoff(), cutoff(), cutoff(), cutoff()],
    { maxIters: 60 },
  );

  assert.equal(result.completion, "truncated", "and it is reported as unfinished, not Done");
  assert.ok(turnsUsed < 60, `gave up after ${turnsUsed} turns instead of running to the step ceiling`);
});

/* Why: one long file legitimately takes two or three passes. If the counter did
   not reset, a run that hit the ceiling early and then worked normally for
   twenty turns would still be filed as truncated at the end. */
test("turns that complete normally clear the cutoff count", async () => {
  const cutoff = () => turn("max_tokens", [{ type: "text", text: "…" }]);
  const ok = () => turn("tool_use", [{ type: "tool_use", id: "x", name: "write_file", input: { path: "a", content: "b" } }]);
  const script = [
    cutoff(), cutoff(), cutoff(), ok(),
    cutoff(), cutoff(), cutoff(), ok(),
    turn("end_turn", [{ type: "text", text: "finished" }]),
  ];
  const { result, turnsUsed } = await drive(script);

  assert.equal(result.completion, "complete");
  // Six cutoffs in the script, well past the give-up threshold — the run only
  // reaches the end because each successful turn reset the count.
  assert.equal(turnsUsed, script.length, "the loop consumed the whole script");
});

/* Why: the ceiling is what caused the cutoff in the first place. 8192 tokens is
   below a single-file React app, so the agent could not have completed the
   user's request in one call however well the loop recovered. The gateway was
   probed across the catalog before this was raised. */
test("one turn may write a file large enough to be worth writing", () => {
  assert.ok(
    DEFAULT_MAX_TOKENS >= 32_000,
    `a ${DEFAULT_MAX_TOKENS}-token ceiling cuts off files the agent is routinely asked to write`,
  );
});
