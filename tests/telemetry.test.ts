import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTelemetryEvent, isTelemetryEnabled, recordTelemetry, telemetrySinkPath } from "../lib/telemetry";

test("telemetry is opt-in: disabled by default, env can force on or off", () => {
  assert.equal(isTelemetryEnabled({}, {}), false, "default is off");
  assert.equal(isTelemetryEnabled({ telemetry: false }, {}), false);
  assert.equal(isTelemetryEnabled({ telemetry: true }, {}), true, "config opt-in enables it");
  assert.equal(isTelemetryEnabled({}, { NEXOTAO_TELEMETRY: "1" }), true, "env opt-in enables it");
  assert.equal(isTelemetryEnabled({ telemetry: true }, { NEXOTAO_TELEMETRY: "off" }), false, "env force-off wins over config");
});

test("built events are redacted, PII-free, and carry only safe fields", () => {
  const event = buildTelemetryEvent({
    kind: "crash",
    name: "run.failed",
    durationMs: 1234.7,
    error: new Error("Gateway rejected key sk-abcdefgh12345678 for user a@b.com"),
    tags: { model: "claude-opus-4-8", apiKey: "sk-secret", filePath: "/home/u/secret.ts", attempt: 2 },
  }, { secrets: ["a@b.com"], now: 1000 });

  assert.equal(event.kind, "crash");
  assert.equal(event.durationMs, 1235, "duration is rounded to an integer");
  assert.ok(!event.message?.includes("sk-abcdefgh12345678"), "token is redacted");
  assert.ok(!event.message?.includes("a@b.com"), "declared secret is redacted");
  assert.equal(event.tags?.apiKey, undefined, "sensitive tag keys are dropped");
  assert.equal(event.tags?.filePath, undefined, "path-like tag keys are dropped");
  assert.equal(event.tags?.model, "claude-opus-4-8");
  assert.equal(event.tags?.attempt, 2);
});

test("recordTelemetry emits nothing when disabled and a redacted line when enabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-telemetry-"));
  const prior = process.env.NEXOTAO_DATA_DIR;
  process.env.NEXOTAO_DATA_DIR = dir;
  try {
    const off = await recordTelemetry({ kind: "performance", name: "boot", durationMs: 42 }, { config: {}, env: {} });
    assert.equal(off.emitted, false, "disabled telemetry writes nothing");

    const on = await recordTelemetry(
      { kind: "crash", name: "run.failed", error: new Error("boom token-abcdefgh12345678") },
      { config: { telemetry: true }, env: {}, now: 5 },
    );
    assert.equal(on.emitted, true);
    assert.ok(!on.event?.message?.includes("token-abcdefgh12345678"), "returned payload is redacted");
    assert.equal(on.event?.kind, "crash");
    const sink = await readFile(telemetrySinkPath(), "utf8");
    assert.equal(sink.trim().split("\n").length, 1, "exactly one event was written");
    assert.ok(!sink.includes("token-abcdefgh12345678"), "the on-disk sink is redacted");
  } finally {
    if (prior === undefined) delete process.env.NEXOTAO_DATA_DIR; else process.env.NEXOTAO_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
