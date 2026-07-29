import test from "node:test";
import assert from "node:assert/strict";
import { mentionAt, rankPaths } from "../components/task/MentionPicker";

// Pure functions — no DOM, no workspace. The picker's whole behaviour is these
// two decisions: when to open, and what to put at the top.

/* Why: `@` is a common character in prose that has nothing to do with files.
   A picker that pops open on every email address and every decorator steals
   Enter from the composer mid-sentence — the prompt gets a file path spliced
   into it instead of being sent. */
test("a mention opens only at a word boundary", () => {
  assert.deepEqual(mentionAt("@src", 4), { start: 0, query: "src" });
  assert.deepEqual(mentionAt("look at @src", 12), { start: 8, query: "src" });
  assert.deepEqual(mentionAt("fix\n@lib", 8), { start: 4, query: "lib" });

  assert.equal(mentionAt("mail me at rizky@nexotao.dev", 28), null, "an email address is not a mention");
  assert.equal(mentionAt("the @Component decorator", 24), null, "…nor is a decorator mid-word");
  assert.equal(mentionAt("no at sign here", 15), null);
});

/* Why: a path cannot contain a space and still be told apart from the prose
   after it. Without this the picker stays open for the rest of the sentence,
   holding Enter hostage long after the user stopped naming a file. */
test("whitespace after the @ closes the mention", () => {
  assert.equal(mentionAt("@src/app.ts and then", 20), null);
  assert.equal(mentionAt("@ ", 2), null);
  // Right up to the space it is still a mention.
  assert.deepEqual(mentionAt("@src/app.ts and", 11), { start: 0, query: "src/app.ts" });
});

/* Why: the caret is what decides, not the text. Typing past a finished mention
   must not re-open the picker for the mention behind it. */
test("only the mention the caret sits in is reported", () => {
  const text = "@README.md then @src";
  assert.deepEqual(mentionAt(text, text.length), { start: 16, query: "src" });
  assert.deepEqual(mentionAt(text, 7), { start: 0, query: "README" }, "mid-word, the query is only what precedes the caret");
});

/* Why: someone typing `route` means the file called route.ts. Ranking by raw
   substring order surfaces whatever the walker happened to reach first, which
   for a real project is a generated file six levels deep — the picker is then
   slower than typing the path by hand. */
test("a file-name hit outranks a folder hit, and the shorter path wins", () => {
  const paths = [
    "app/routes/legacy/deep/handler.ts",
    "lib/router.ts",
    "app/api/files/route.ts",
    "docs/route-design.md",
  ];
  const ranked = rankPaths(paths, "route");

  assert.equal(ranked[0], "app/api/files/route.ts", "the file actually named route.* comes first");
  assert.ok(
    ranked.indexOf("lib/router.ts") < ranked.indexOf("app/routes/legacy/deep/handler.ts"),
    "a name hit beats a directory hit anywhere in the path",
  );
  assert.ok(ranked.includes("docs/route-design.md"), "a weaker match is still offered, just lower");
});

/* Why: the corpus is every file in the workspace. Rendering all of them is a
   list nobody scrolls, and an unmatched query must say so rather than show an
   arbitrary slice. */
test("matching is case-insensitive, capped, and empty when nothing matches", () => {
  const paths = ["src/App.tsx", "src/app.test.ts"];
  assert.deepEqual(rankPaths(paths, "APP"), ["src/App.tsx", "src/app.test.ts"]);

  assert.deepEqual(rankPaths(paths, "zzz"), [], "no match is an empty list, not a fallback");

  const many = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
  assert.equal(rankPaths(many, "file").length, 12, "the list is capped");
  assert.equal(rankPaths(many, "").length, 12, "an empty query offers a starting slice, still capped");
});
