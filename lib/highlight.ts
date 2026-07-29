/* A small syntax highlighter, written here rather than installed.
 *
 * The alternative was Shiki or Prism. Shiki ships a WASM regex engine and
 * megabytes of TextMate grammars; Prism wants a global and a stylesheet per
 * theme. This app is downloaded and run on someone's laptop, and neither is a
 * fair price for colouring a config file you opened to check one line.
 *
 * So: one pass, one regex per grammar family, ~15 languages. It knows nothing
 * about scope, types, or imports — a `class` inside a template literal is a
 * string here, and that is the only correctness property that actually matters.
 * Anything it can't classify comes out as plain text, which reads exactly like
 * the unhighlighted version did.
 */

export type TokenKind =
  | "comment" | "string" | "keyword" | "type" | "constant"
  | "number" | "function" | "punct" | "plain";

export type Token = { kind: TokenKind; text: string };

const set = (words: string) => new Set(words.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = set(`
  as async await break case catch class const continue debugger default delete do else enum export
  extends finally for from function get if implements import in instanceof interface let new of
  package private protected public return satisfies set static super switch this throw try typeof
  var void while with yield keyof infer readonly declare namespace module abstract override
`);
const JS_TYPES = set(`
  string number boolean object symbol bigint any unknown never void null undefined
  Array Promise Record Map Set Date RegExp Error Partial Required Pick Omit Readonly
`);
const JS_CONSTANTS = set("true false null undefined NaN Infinity this super globalThis");

const PY_KEYWORDS = set(`
  and as assert async await break class continue def del elif else except finally for from global
  if import in is lambda nonlocal not or pass raise return try while with yield match case
`);
const PY_CONSTANTS = set("True False None self cls");
const PY_TYPES = set("int float str bool list dict set tuple bytes object type Any Optional List Dict");

const GO_KEYWORDS = set(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var
`);
const GO_TYPES = set("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any");
const GO_CONSTANTS = set("true false nil iota");

const RUST_KEYWORDS = set(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match
  mod move mut pub ref return self Self static struct super trait type unsafe use where while
`);
const RUST_TYPES = set("bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box");
const RUST_CONSTANTS = set("true false None Some Ok Err");

const C_KEYWORDS = set(`
  auto break case catch class const constexpr continue default delete do else enum explicit extern
  final for friend goto if inline namespace new operator override private protected public register
  return sizeof static struct switch template this throw try typedef typename union using virtual
  volatile while abstract assert boolean extends implements import instanceof interface native
  package strictfp super synchronized throws transient var record sealed yield
`);
const C_TYPES = set("bool char double float int long short signed unsigned void size_t string wstring vector map auto byte");
const C_CONSTANTS = set("true false null nullptr NULL this");

const SQL_KEYWORDS = set(`
  add all alter and any as asc begin between by case cast check column commit constraint create
  cross cursor database default delete desc distinct drop else end exists foreign from full group
  having if in index inner insert into is join key left like limit not null offset on or order
  outer primary references replace return right rollback select set table then transaction trigger
  union unique update values view when where with
`);

const SHELL_KEYWORDS = set(`
  if then else elif fi for while until do done case esac function return in select time
  echo cd export local readonly set unset source alias exit trap shift eval exec
`);

const CSS_KEYWORDS = set("import media supports keyframes font-face charset use include mixin extend layer container");

type Grammar = {
  /** Regex alternatives matching a whole comment, or "" for a language without them. */
  comment: string;
  /** Regex alternatives matching a whole string literal. */
  string: string;
  keywords: Set<string>;
  types: Set<string>;
  constants: Set<string>;
};

const DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const BQ = String.raw`\`(?:\\.|[^\\\`])*\`?`;
const SLASH_COMMENT = String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)`;
const HASH_COMMENT = String.raw`#[^\n]*`;

const GRAMMARS: Record<string, Grammar> = {
  javascript: { comment: SLASH_COMMENT, string: `${DQ}|${SQ}|${BQ}`, keywords: JS_KEYWORDS, types: JS_TYPES, constants: JS_CONSTANTS },
  python: { comment: HASH_COMMENT, string: `${DQ}|${SQ}`, keywords: PY_KEYWORDS, types: PY_TYPES, constants: PY_CONSTANTS },
  go: { comment: SLASH_COMMENT, string: `${DQ}|${BQ}`, keywords: GO_KEYWORDS, types: GO_TYPES, constants: GO_CONSTANTS },
  rust: { comment: SLASH_COMMENT, string: `${DQ}`, keywords: RUST_KEYWORDS, types: RUST_TYPES, constants: RUST_CONSTANTS },
  clike: { comment: SLASH_COMMENT, string: `${DQ}|${SQ}`, keywords: C_KEYWORDS, types: C_TYPES, constants: C_CONSTANTS },
  shell: { comment: HASH_COMMENT, string: `${DQ}|${SQ}`, keywords: SHELL_KEYWORDS, types: new Set(), constants: set("true false") },
  sql: { comment: String.raw`--[^\n]*|/\*[\s\S]*?(?:\*/|$)`, string: `${DQ}|${SQ}`, keywords: SQL_KEYWORDS, types: set("int integer text varchar char boolean date timestamp numeric decimal serial uuid json jsonb"), constants: set("true false null") },
  css: { comment: String.raw`/\*[\s\S]*?(?:\*/|$)`, string: `${DQ}|${SQ}`, keywords: CSS_KEYWORDS, types: new Set(), constants: new Set() },
  json: { comment: "", string: `${DQ}`, keywords: new Set(), types: new Set(), constants: set("true false null") },
  yaml: { comment: HASH_COMMENT, string: `${DQ}|${SQ}`, keywords: new Set(), types: new Set(), constants: set("true false null yes no on off") },
  markup: { comment: String.raw`<!--[\s\S]*?(?:-->|$)`, string: `${DQ}|${SQ}`, keywords: new Set(), types: new Set(), constants: new Set() },
};

/** Language names as `lib/workspace-files.ts` reports them, mapped onto the
 *  grammar that is close enough. A near-miss costs a miscoloured keyword; a
 *  missing entry costs the whole file its colour, so the fallback is generous. */
const FAMILY: Record<string, keyof typeof GRAMMARS> = {
  typescript: "javascript", tsx: "javascript", javascript: "javascript", jsx: "javascript",
  python: "python", ruby: "python", go: "go", rust: "rust",
  java: "clike", kotlin: "clike", swift: "clike", c: "clike", cpp: "clike", csharp: "clike", php: "clike",
  bash: "shell", sql: "sql", css: "css", scss: "css", json: "json",
  yaml: "yaml", toml: "yaml", html: "markup", xml: "markup",
};

/** Beyond this, colouring costs more than it gives — a file this size is being
 *  skimmed, and re-tokenising it on every keystroke would stutter the editor. */
export const HIGHLIGHT_LIMIT = 200_000;

export function isHighlightable(language: string, text: string) {
  return Boolean(FAMILY[language]) && text.length <= HIGHLIGHT_LIMIT;
}

const cache = new Map<string, RegExp>();
function scanner(name: keyof typeof GRAMMARS) {
  const hit = cache.get(name);
  if (hit) return hit;
  const g = GRAMMARS[name];
  const parts = [
    g.comment && `(?<comment>${g.comment})`,
    `(?<string>${g.string})`,
    String.raw`(?<number>\b\d(?:[\w.]*\w)?\b)`,
    // A name directly before `(` is being called or declared. This is the whole
    // of what "functions have a colour" means here — no scope analysis, just the
    // shape that reads as a call everywhere it appears.
    String.raw`(?<fn>[A-Za-z_$][\w$]*(?=\s*\())`,
    String.raw`(?<word>[A-Za-z_$][\w$]*)`,
    String.raw`(?<punct>[{}()[\]<>.,;:+\-*/%=!&|^~?@#]+)`,
  ].filter(Boolean);
  const re = new RegExp(parts.join("|"), "gm");
  cache.set(name, re);
  return re;
}

/** Split `text` into coloured runs. Every character of the input appears in the
 *  output exactly once and in order, so joining the tokens rebuilds the file —
 *  the property that keeps an overlay aligned with the textarea beneath it. */
export function highlight(text: string, language: string): Token[] {
  const family = FAMILY[language];
  if (!family || text.length > HIGHLIGHT_LIMIT) return text ? [{ kind: "plain", text }] : [];

  const g = GRAMMARS[family];
  const re = scanner(family);
  const tokens: Token[] = [];
  let last = 0;

  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A zero-width match would spin forever; nothing here can produce one, but
    // the guard costs a comparison and the alternative is a hung tab.
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) tokens.push({ kind: "plain", text: text.slice(last, m.index) });

    const groups = m.groups!;
    let kind: TokenKind = "plain";
    if (groups.comment !== undefined) kind = "comment";
    else if (groups.string !== undefined) kind = "string";
    else if (groups.number !== undefined) kind = "number";
    else if (groups.fn !== undefined) {
      // `if (` and `while (` are keywords wearing a call's clothing.
      kind = g.keywords.has(m[0]) ? "keyword" : "function";
    } else if (groups.word !== undefined) {
      if (g.constants.has(m[0])) kind = "constant";
      else if (g.keywords.has(m[0])) kind = "keyword";
      else if (g.types.has(m[0])) kind = "type";
    } else if (groups.punct !== undefined) kind = "punct";

    tokens.push({ kind, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "plain", text: text.slice(last) });
  return tokens;
}
