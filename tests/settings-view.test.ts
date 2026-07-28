import test from "node:test";
import assert from "node:assert/strict";
import { publicView } from "../lib/config";
import { modelLabel } from "../components/settings/ModelRow";

test("the public config identifies a key without disclosing it", () => {
  const key = "sk-nexo-_gHv_MjeDay-MvMt5Y20clOpqiyPDHK8";
  const view = publicView({ apiKey: key });

  assert.equal(view.hasKey, true);
  assert.equal(view.keyHint, "DHK8");
  // The hint must never be enough to reconstruct the key.
  assert.ok(!JSON.stringify(view).includes(key));
  assert.equal(view.keyHint.length, 4);
});

test("a missing or too-short key yields no hint at all", () => {
  assert.equal(publicView({}).keyHint, null);
  assert.equal(publicView({ apiKey: "" }).keyHint, null);
  // Four of eleven characters would be a meaningful fraction of the secret.
  assert.equal(publicView({ apiKey: "sk-nexo-abc" }).keyHint, null);
});

test("the settings model reflects config rather than a hardcoded name", () => {
  // Regression: settings used to print "Opus 4.8" no matter what was configured.
  assert.equal(publicView({ model: "claude-opus-5" }).model, "claude-opus-5");
  assert.equal(publicView({}).model, null);
});

test("model ids render as readable names", () => {
  assert.equal(modelLabel("claude-opus-5"), "Opus 5");
  assert.equal(modelLabel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(modelLabel("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(modelLabel("gpt-5.6-terra"), "GPT-5.6 Terra");
  // An id the pattern doesn't know still names itself.
  assert.equal(modelLabel("some-future-model"), "some-future-model");
});
