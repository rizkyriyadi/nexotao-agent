import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTool } from "../lib/execution-policy";
import { executeTool } from "../lib/tools";

test("the shared policy asks for every mutating tool", async () => {
  const events: unknown[] = [];
  const run = {
    push: (event: unknown) => events.push(event),
    awaitApproval: async () => "deny" as const,
  };
  assert.equal(await authorizeTool(run as never, "ask", { id: "1", name: "bash", input: {}, thread: "test" }), false);
  assert.equal(events.length, 1);
  assert.equal(await authorizeTool(run as never, "ask", { id: "2", name: "read_file", input: {}, thread: "test" }), true);
});

test("abort terminates an executing shell process group", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = executeTool("bash", { command: `${process.execPath} -e "setInterval(() => {}, 1000)"` }, process.cwd(), controller.signal);
  setTimeout(() => controller.abort(new Error("test cancel")), 100);
  const out = await result;
  assert.equal(out.ok, false);
  assert.match(out.output, /test cancel|cancel/i);
  assert.ok(Date.now() - started < 5000);
});
