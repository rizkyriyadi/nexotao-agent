import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "../components/task/tool-config";

/* Why: the paths shown in a run's tool rows come from `rel()`, which uses the
   *host's* separator. On Windows that is a backslash, so a `basename` splitting
   only on `/` found no separator at all and returned the whole path — every
   file the agent touched was rendered as `src\app\page.tsx` in a column sized
   for a filename. The user who reported this was working from
   `D:\platform vendore\devi ardiani\vendora`; nothing about it is hypothetical. */
test("a filename is recovered from either platform's separator", () => {
  assert.equal(basename("src/app/page.tsx"), "page.tsx");
  assert.equal(basename("src\\app\\page.tsx"), "page.tsx", "a Windows path yields a filename, not the whole path");
  assert.equal(basename("D:\\platform vendore\\vendora\\pubspec.yaml"), "pubspec.yaml");
  // Mixed separators are what a Windows host actually produces once a
  // POSIX-writing model has contributed half the string.
  assert.equal(basename("D:\\vendora/lib\\main.dart"), "main.dart");
});

/* Why: the fallback exists so a path that is already bare, or ends in a
   separator, still renders something a person can read rather than an empty
   cell. */
test("a path with nothing to strip is returned intact", () => {
  assert.equal(basename("README.md"), "README.md");
  assert.equal(basename("src/app/"), "app", "a trailing separator is not a filename");
  assert.equal(basename(""), "", "and nothing at all stays nothing");
});
