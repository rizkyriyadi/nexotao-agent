import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TreeNode } from "../lib/workspace-files";

/* `listRoots` reads the active project, which means the config file and the
   database — both anchored to NEXOTAO_DATA_DIR at module load. So the variable
   is set before the module is imported, and the import is dynamic to make that
   ordering explicit rather than a fact about hoisting. Without it these tests
   would open the real ~/.nexotao belonging to whoever ran them. */
const data = await mkdtemp(path.join(tmpdir(), "nexotao-files-data-"));
process.env.NEXOTAO_DATA_DIR = data;

const { activeRoot, flattenPaths, listRoots, readPreview, readTree, writeFile: saveFile } =
  await import("../lib/workspace-files");
const { getDatabase } = await import("../lib/db/database");
const { addProject } = await import("../lib/store");
const { saveConfig } = await import("../lib/config");

after(async () => {
  await (await getDatabase()).close();
  await rm(data, { recursive: true, force: true });
});

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

/* Why: an agent run writes into the same tree the editor reads. Someone opens a
   config file, the agent rewrites it mid-read, and a save built on the stale
   buffer erases that work with no diff, no conflict marker, and no trace that
   anything was lost. The version echo is the only thing standing between the
   two writers. */
test("a file that changed on disk since it was opened is not overwritten", async () => {
  const dir = await repository();
  const opened = await readPreview(dir, "src/app.ts");
  const version = { size: opened.size, mtimeMs: opened.mtimeMs };

  // The agent writes while the file sits open in the editor.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(path.join(dir, "src", "app.ts"), "export const x = 99; // agent\n");

  const refused = await saveFile(dir, "src/app.ts", "export const x = 2; // me\n", version);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.conflict : "", /changed on disk/i);
  assert.equal(
    await readFile(path.join(dir, "src", "app.ts"), "utf8"),
    "export const x = 99; // agent\n",
    "the agent's write is still there — the stale buffer never landed",
  );

  // Re-reading yields the current version, and saving against that succeeds.
  const reopened = await readPreview(dir, "src/app.ts");
  const saved = await saveFile(dir, "src/app.ts", "export const x = 2; // me\n", { size: reopened.size, mtimeMs: reopened.mtimeMs });
  assert.equal(saved.ok, true);
  assert.equal(await readFile(path.join(dir, "src", "app.ts"), "utf8"), "export const x = 2; // me\n");
});

/* Why: a preview past the cap holds the first 512 KB only. Saving that buffer
   would write those bytes as the whole file and silently delete the rest — a
   save that reports success while destroying most of the document. */
test("a file too large to have been read whole cannot be saved", async () => {
  const dir = await repository();
  const line = "x".repeat(99) + "\n";
  await writeFile(path.join(dir, "huge.log"), line.repeat(8_000)); // ~800 KB

  const result = await saveFile(dir, "huge.log", "oops", null);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.conflict : "", /truncate/i);
  assert.ok((await readFile(path.join(dir, "huge.log"), "utf8")).length > 512 * 1024, "the file is untouched");
});

/* Why: this endpoint takes a path and a string from an HTTP body. Without the
   same containment the reader has, it is an arbitrary-file-write on the user's
   machine — strictly worse than the read it mirrors. */
test("saving cannot write outside the workspace", async () => {
  const dir = await repository();
  const outside = await mkdtemp(path.join(tmpdir(), "nexotao-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "not yours\n");
  await symlink(outside, path.join(dir, "escape"));

  await assert.rejects(() => saveFile(dir, "escape/secret.txt", "owned", null), /escapes the workspace/i);
  await assert.rejects(() => saveFile(dir, "../outside.txt", "owned", null), /escapes/i);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "not yours\n");
});

/* Why: the preview for a PDF is its *extracted text*, and for an image a data
   URL. Accepting a save on either would replace the document with a transcript
   of itself, or the picture with a base64 string. */
test("only text files can be written back", async () => {
  const dir = await repository();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(dir, "pixel.png"), png);

  const refused = await saveFile(dir, "pixel.png", "not a png", null);
  assert.equal(refused.ok, false);
  assert.deepEqual(await readFile(path.join(dir, "pixel.png")), png, "the image bytes are intact");

  // A dotfile with no extension at all is still text and still editable — .env
  // is one of the files people most want to fix by hand.
  await writeFile(path.join(dir, ".env"), "KEY=old\n");
  const saved = await saveFile(dir, ".env", "KEY=new\n", null);
  assert.equal(saved.ok, true);
  assert.equal(await readFile(path.join(dir, ".env"), "utf8"), "KEY=new\n");
});

/* Why: the `@` picker searches this list. A folder in it is a mention the agent
   cannot read, and a missing file is one the user cannot name. */
test("the mention corpus is every file and no folders", async () => {
  const dir = await repository();
  const { tree } = await readTree(dir);
  const paths = flattenPaths(tree);

  assert.ok(paths.includes("src/app.ts"), "nested files are reachable by their full path");
  assert.ok(paths.includes("README.md"));
  assert.ok(!paths.includes("src"), "a folder is not a mentionable file");
  assert.ok(!paths.includes("dist"), "nor is an ignored one");
});

/* Why: every other preview branch has a ceiling — text truncates, images refuse
   past their cap — and the PDF branch had none. It read the whole file into a
   Buffer and handed it to an extractor that builds its own copy, so a large PDF
   sitting in a repository was a way to make the panel allocate twice its size
   with nothing to stop it. The user who reported the crash had a machine that
   ran out of committed memory; this is one of the paths that spends it. */
test("a PDF too large to preview is refused rather than read whole", async () => {
  const dir = await repository();
  // Not a real PDF — the size gate is checked before a byte is read, which is
  // the entire point. Anything past the cap must never reach readFile.
  await writeFile(path.join(dir, "manual.pdf"), Buffer.alloc(13 * 1024 * 1024));

  const preview = await readPreview(dir, "manual.pdf");
  assert.equal(preview.kind, "binary", "refused, not parsed");
  assert.match(preview.kind === "binary" ? preview.reason : "", /too large to preview/);
});

/* Why: a PDF under the cap must still be previewed. A gate that refuses
   everything would "fix" the memory path by removing the feature. */
test("a PDF within the cap is still previewed", async () => {
  const dir = await repository();
  await writeFile(path.join(dir, "small.pdf"), "%PDF-1.4\n% not really\n");

  const preview = await readPreview(dir, "small.pdf");
  assert.equal(preview.kind, "pdf", "a normal PDF is unaffected by the ceiling");
});

/* Why: this used to return a list — the project, plus one entry per run writing
   into a worktree of its own — and the panel put a picker on top of it. That is
   what made the folder appear to change per task, and the terminal open in a
   directory the user had never been to, with nothing installed in it. Runs write
   into the project folder now, so "which folder am I looking at" has exactly one
   answer, and this test is what keeps it that way: a second entry appearing here
   is the picker coming back. */
test("the panel has one folder to show, and it is the project", async () => {
  const tree = await repository();
  const project = await addProject({ name: "Shop", path: tree });
  await saveConfig({ activeProjectId: project.id });

  const roots = await listRoots();
  assert.equal(roots.length, 1, "one folder, always");
  assert.equal(roots[0].path, tree);
  assert.equal(roots[0].id, "project");
  assert.equal(roots[0].label, "Shop");
  assert.deepEqual(await activeRoot(), roots[0], "and the active one is simply that folder");
});

/* Why: no project open is a real state — a fresh install, or the moment after
   the last project is deleted. The panel has to render it as "nothing open"
   rather than throwing, because it is mounted before any project exists. */
test("with no project open the panel reports nothing rather than failing", async () => {
  await saveConfig({ activeProjectId: undefined });

  assert.deepEqual(await listRoots(), []);
  assert.equal(await activeRoot(), null);
});
