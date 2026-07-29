import test from "node:test";
import assert from "node:assert/strict";
import { highlight, isHighlightable, HIGHLIGHT_LIMIT, type Token } from "../lib/highlight";

const join = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const kindOf = (tokens: Token[], text: string) => tokens.find((t) => t.text === text)?.kind;

/* Why: the editor lays coloured spans *over* a textarea. If tokenising drops,
   duplicates, or reorders a single character, every line below the damage sits
   off by that much and the caret stops landing where the user clicked. Every
   other property here is cosmetic; this one is the feature working at all. */
test("tokenising a file loses nothing — the tokens rebuild it exactly", () => {
  const samples: [string, string][] = [
    ["typescript", `// hi\nexport function add(a: number, b = 1) {\n  return \`\${a}\` + 'x' + /* c */ 2;\n}\n`],
    ["python", `# note\ndef f(x: int) -> str:\n    return "a" if x else 'b'\n`],
    ["json", `{"a": [1, 2.5, true, null], "b": {"c": "d"}}`],
    ["css", `.a { color: #fff; /* x */ }\n@media (min-width: 10px) { .b { top: 0 } }`],
    ["go", "package main\nfunc main() { fmt.Println(`hi`) }\n"],
    ["sql", "-- c\nSELECT a, b FROM t WHERE x = 'y' LIMIT 10;"],
    ["yaml", "# c\nkey: value\nlist:\n  - 1\n  - true\n"],
    ["html", `<!-- c --><div class="a">text</div>`],
    ["rust", `fn main() { let s: String = String::from("hi"); }`],
    ["bash", `# c\nexport A="b"\nif [ -f x ]; then echo 'y'; fi`],
  ];
  for (const [language, source] of samples) {
    assert.equal(join(highlight(source, language)), source, `${language} round-trips`);
  }
});

/* Why: an unterminated string or block comment is what a file looks like *while
   you are typing it*. A scanner that hangs or drops the tail on those is
   unusable in an editor even though it passes on every finished file. */
test("half-written strings and comments still round-trip", () => {
  for (const source of ['const a = "unclosed', "/* never closed", "x = 'a\ny = 2", "`open template"]) {
    assert.equal(join(highlight(source, "typescript")), source, JSON.stringify(source));
  }
});

/* Why: this is the request in the user's own words — "kaya di vscode tuh
   function ada warnanya". A name before `(` is the whole heuristic; if it also
   caught `if (`, every conditional in the file would read as a call. */
test("a name before a paren is a function, but a keyword before one is not", () => {
  const tokens = highlight("if (ready) { render(view); }", "typescript");
  assert.equal(kindOf(tokens, "render"), "function");
  assert.equal(kindOf(tokens, "if"), "keyword");
});

/* Why: the one correctness property a single-pass scanner can actually hold.
   Colouring `class` inside a string would make quoted prose flicker with
   keyword colour as you type it. */
test("keywords inside a string stay part of the string", () => {
  const tokens = highlight('const a = "class function return";', "typescript");
  assert.ok(tokens.some((t) => t.kind === "string" && t.text === '"class function return"'));
  assert.ok(!tokens.some((t) => t.kind === "keyword" && t.text === "class"));
});

test("keywords, types, constants and numbers each get their own kind", () => {
  const tokens = highlight("const n: number = 42; let ok = true;", "typescript");
  assert.equal(kindOf(tokens, "const"), "keyword");
  assert.equal(kindOf(tokens, "number"), "type");
  assert.equal(kindOf(tokens, "42"), "number");
  assert.equal(kindOf(tokens, "true"), "constant");
});

/* Why: the fallback is what keeps an unknown file readable. Returning one plain
   run means it renders exactly as the uncoloured version did, rather than
   throwing and blanking the pane. */
test("an unknown language and an oversized file fall back to plain text", () => {
  const source = "some ✨ text";
  assert.deepEqual(highlight(source, "brainfuck"), [{ kind: "plain", text: source }]);
  assert.equal(highlight("", "typescript").length, 0);

  const huge = "a".repeat(HIGHLIGHT_LIMIT + 1);
  assert.deepEqual(highlight(huge, "typescript"), [{ kind: "plain", text: huge }]);
  assert.equal(isHighlightable("typescript", huge), false);
  assert.equal(isHighlightable("typescript", "a"), true);
  assert.equal(isHighlightable("brainfuck", "a"), false);
});
