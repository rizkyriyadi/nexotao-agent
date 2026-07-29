import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPreview, readTree, type TreeNode } from "../lib/workspace-files";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

/** A small repository with one committed file, one modified file, one untracked
 *  file, and a gitignored build folder — the four states the tree distinguishes. */
async function repository() {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-files-test-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.name", "Fixture");
  await git(dir, "config", "user.email", "fixture@nexotao.test");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(path.join(dir, "README.md"), "# Title\n\nBody.\n");
  await writeFile(path.join(dir, ".gitignore"), "dist/\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "chore(repo): initialize fixture");
  await writeFile(path.join(dir, "README.md"), "# Title\n\nEdited.\n");
  await writeFile(path.join(dir, "src", "new.ts"), "export const y = 2;\n");
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "bundle.js"), "// generated\n");
  await mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "// dependency\n");
  return dir;
}

function find(nodes: TreeNode[], target: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === target) return node;
    const hit = node.children && find(node.children, target);
    if (hit) return hit;
  }
  return undefined;
}

/* Why: the git column is the whole reason this tree is not a plain `ls`. A user
   who has just watched an agent work opens the panel to see *what changed*; if
   an edited file and an untouched one look identical, the panel answers nothing
   the file system did not already. */
test("the tree marks modified and untracked files with git's own state", async () => {
  const dir = await repository();
  const { tree } = await readTree(dir);

  assert.equal(find(tree, "README.md")?.status, "M");
  assert.equal(find(tree, "src/new.ts")?.status, "U");
  assert.equal(find(tree, "src/app.ts")?.status, undefined, "a committed, untouched file carries no status");
  assert.equal(find(tree, "src")?.dirty, true, "a folder holding changes is flagged so collapsed work is still visible");
});

/* Why: `node_modules` and `dist` between them can hold a hundred times more
   files than the project. Walking into them is what turns an instant panel into
   a hung one, and burying `src/` under them is what makes the panel useless. */
test("generated folders are hidden and ignored ones are listed but not walked", async () => {
  const dir = await repository();
  const { tree } = await readTree(dir);

  assert.equal(find(tree, "node_modules"), undefined, "node_modules never appears");
  const dist = find(tree, "dist");
  assert.ok(dist, "a gitignored folder is still shown — it exists, and hiding it is its own confusion");
  assert.equal(dist.ignored, true);
  assert.deepEqual(dist.children, [], "but its contents are not read");
  assert.ok(find(tree, "src/app.ts"), "the files that matter are still there");
});

/* Why: the panel reads whatever path arrives in an HTTP query. `resolveWithin`
   compares paths lexically, which a symlink defeats — `docs/escape -> /etc`
   resolves inside the project and really points anywhere on the machine. */
test("a symlink pointing outside the workspace cannot be read through", async () => {
  const dir = await repository();
  const outside = await mkdtemp(path.join(tmpdir(), "nexotao-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "not yours\n");
  await symlink(outside, path.join(dir, "escape"));

  await assert.rejects(() => readPreview(dir, "escape/secret.txt"), /escapes the workspace/i);
  await assert.rejects(() => readPreview(dir, "../"), /escapes/i);
});

/* Why: showing a PNG as UTF-8 fills the pane with replacement characters and
   reads as a broken app rather than "this file is not text". */
test("each file kind gets the presentation it can actually be read in", async () => {
  const dir = await repository();
  // A one-pixel PNG: real bytes, so the NUL-byte test and the image branch are
  // both exercised rather than trusting the extension alone.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(dir, "pixel.png"), png);
  await writeFile(path.join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));

  const markdown = await readPreview(dir, "README.md");
  assert.equal(markdown.kind, "markdown");

  const code = await readPreview(dir, "src/app.ts");
  assert.equal(code.kind, "text");
  assert.equal(code.kind === "text" && code.language, "typescript");

  const image = await readPreview(dir, "pixel.png");
  assert.equal(image.kind, "image");
  assert.ok(image.kind === "image" && image.dataUrl.startsWith("data:image/png;base64,"));

  const binary = await readPreview(dir, "blob.bin");
  assert.equal(binary.kind, "binary", "a file with NUL bytes is declared binary, not shown as mojibake");
});

/* Why: a generated bundle or a long log is exactly the file someone opens out of
   curiosity, and reading all of it into a JSON response is how the panel stalls
   the browser on a file nobody intended to read in full. */
test("an oversized text file is truncated rather than refused or fully read", async () => {
  const dir = await repository();
  const line = "x".repeat(99) + "\n";
  await writeFile(path.join(dir, "huge.log"), line.repeat(8_000)); // ~800 KB

  const preview = await readPreview(dir, "huge.log");
  assert.equal(preview.kind, "text");
  assert.ok(preview.kind === "text" && preview.truncated, "the response says it is partial");
  assert.ok(preview.kind === "text" && preview.text.length <= 512 * 1024);
  assert.ok(preview.size > 512 * 1024, "while still reporting the file's real size");
});

/* Why: a folder the user opened by hand may not be a repository at all. If the
   tree only works inside git, the panel is empty for exactly the case the
   onboarding flow encourages — "start fresh" in a plain new folder. */
test("a folder that is not a git repository still shows its files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexotao-plain-"));
  await mkdir(path.join(dir, "notes"), { recursive: true });
  await writeFile(path.join(dir, "notes", "todo.md"), "- one\n");

  const { tree } = await readTree(dir);
  assert.equal(tree.length, 1);
  assert.equal(find(tree, "notes/todo.md")?.name, "todo.md");
  assert.equal(find(tree, "notes/todo.md")?.status, undefined, "no git means no status, not a crash");
});
