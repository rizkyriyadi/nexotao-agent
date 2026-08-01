import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* Onboarding's last step posts here. When this route failed, the client used to
   redirect anyway: home saw `onboarded: false`, bounced back to step one, and
   the typed API key was gone with no error ever shown. So the contract this
   file pins is narrow but load-bearing — a refusal must arrive as a non-OK
   status carrying a readable `error`, never as a 200 the client mistakes for
   success. */

const dir = await mkdtemp(path.join(tmpdir(), "nexotao-onboarding-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const { POST } = await import("../app/api/config/route");
const { getConfig } = await import("../lib/config");

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  POST(new Request("http://127.0.0.1:4319/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

test("a completed onboarding saves the key, the model and the project", async () => {
  const tree = path.join(dir, "tree");
  const response = await post({
    apiKey: "sk-nexo-" + "a".repeat(32), model: "claude-opus-4-8", onboarded: true,
    project: { name: "Shop", path: tree },
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.onboarded, true);
  assert.equal(payload.project?.path, tree);
  // The key is held but never echoed back to the browser.
  assert.equal(payload.apiKey, undefined);
  assert.equal(payload.hasKey, true);
  assert.equal((await getConfig()).apiKey, "sk-nexo-" + "a".repeat(32));
});

test("a project with no folder is refused with a message, not a silent 200", async () => {
  const response = await post({ apiKey: "sk-nexo-x", onboarded: true, project: { name: "Nameless", path: "   " } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /folder/i);
});

test("a malformed body is refused rather than throwing", async () => {
  const response = await POST(new Request("http://127.0.0.1:4319/api/config", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
  }));
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error);
});

test("a refused save leaves onboarding incomplete rather than half-applied", async () => {
  const before = await getConfig();
  const response = await post({ apiKey: "sk-nexo-second", project: { name: "", path: "" } });
  assert.equal(response.status, 400);
  // Nothing from the rejected request may land: a partially-written config is
  // what sends the user back to step one with a key they already typed.
  assert.equal((await getConfig()).apiKey, before.apiKey);
});
