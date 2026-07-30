import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* A project is its folder. Onboarding is reachable at any time, so pointing it
   at a folder that is already a project is an ordinary thing for a user to do —
   and it used to mint a second row: two cards with the same name on one tree,
   each holding half the history. */

const dir = await mkdtemp(path.join(tmpdir(), "nexotao-project-store-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const { addProject, listProjects } = await import("../lib/store");

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

test("re-adding a folder re-opens the project already on it", async () => {
  const tree = path.join(dir, "tree");
  const first = await addProject({ name: "Shop", path: tree });
  const again = await addProject({ name: "Shop again", path: tree });

  assert.equal(again.id, first.id, "the same folder yields the same project");
  assert.equal(again.name, "Shop", "the existing project is returned untouched, not overwritten");
  assert.equal((await listProjects()).filter((p) => p.path === tree).length, 1);
});

test("~ and an absolute home path name the same folder", async () => {
  const first = await addProject({ name: "Tilde", path: `${process.env.HOME}/nexotao-dedupe-probe` });
  const again = await addProject({ name: "Tilde", path: "~/nexotao-dedupe-probe" });
  assert.equal(again.id, first.id);
});

test("different folders stay different projects", async () => {
  const a = await addProject({ name: "A", path: path.join(dir, "a") });
  const b = await addProject({ name: "B", path: path.join(dir, "b") });
  assert.notEqual(a.id, b.id);
});
