import assert from "node:assert/strict";
import test from "node:test";
import { boardSurface, detailSurface } from "../lib/task-ui-state";

test("task board exposes loading, empty, ready, error, and disconnected states", () => {
  assert.equal(boardSurface("loading", 0), "loading");
  assert.equal(boardSurface("online", 0), "empty");
  assert.equal(boardSurface("online", 2), "ready");
  assert.equal(boardSurface("error", 0), "error");
  assert.equal(boardSurface("disconnected", 2), "disconnected");
});

test("issue detail preserves canonical state while reconnecting", () => {
  assert.equal(detailSurface("loading", false), "loading");
  assert.equal(detailSurface("error", false), "error");
  assert.equal(detailSurface("disconnected", true), "disconnected");
  assert.equal(detailSurface("online", true), "ready");
});
