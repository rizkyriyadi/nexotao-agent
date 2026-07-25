// Regression cover for NEXA-57: a transiently locked destination (antivirus,
// search indexer, cloud sync on Windows) made every durable write throw
// `EPERM: operation not permitted, rename ...`, which flipped the agent to
// `error` and failed the run it was executing.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renameWithRetry, writeFileAtomic } from "../lib/atomic-write";

async function fixture() { return mkdtemp(path.join(tmpdir(), "nexotao-atomic-test-")); }

function lockingRename(failures: number, code: string) {
  const real = fs.rename;
  let attempts = 0;
  const patched = async (from: fs.FileHandle | string, to: fs.FileHandle | string) => {
    if (attempts++ < failures) {
      const error = new Error(`${code}: simulated lock, rename '${String(from)}' -> '${String(to)}'`);
      (error as NodeJS.ErrnoException).code = code;
      throw error;
    }
    return real(from as string, to as string);
  };
  (fs as unknown as { rename: typeof patched }).rename = patched;
  return { restore: () => { (fs as unknown as { rename: typeof real }).rename = real; }, count: () => attempts };
}

test("a transiently locked destination is retried instead of failing the write", async () => {
  const dir = await fixture();
  try {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const file = path.join(dir, `store-${code}.json`);
      const lock = lockingRename(3, code);
      try {
        await writeFileAtomic(file, JSON.stringify({ code }), { mode: 0o600 });
      } finally {
        lock.restore();
      }
      assert.equal(await fs.readFile(file, "utf8"), JSON.stringify({ code }), `${code} payload landed`);
      assert.equal(lock.count(), 4, `${code} retried until the lock cleared`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-transient rename error still surfaces and leaves no temp file behind", async () => {
  const dir = await fixture();
  try {
    const file = path.join(dir, "store.json");
    const lock = lockingRename(Number.MAX_SAFE_INTEGER, "EROFS");
    try {
      await assert.rejects(() => writeFileAtomic(file, "payload"), /EROFS/);
    } finally {
      lock.restore();
    }
    assert.equal(lock.count(), 1, "a real fault is not retried");
    assert.deepEqual(await fs.readdir(dir), [], "the temp sibling is cleaned up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persistent lock eventually gives up rather than hanging forever", async () => {
  const dir = await fixture();
  try {
    const file = path.join(dir, "store.json");
    const lock = lockingRename(Number.MAX_SAFE_INTEGER, "EPERM");
    try {
      await assert.rejects(() => writeFileAtomic(file, "payload"), /EPERM/);
    } finally {
      lock.restore();
    }
    assert.equal(lock.count(), 10, "bounded retry budget");
    assert.deepEqual(await fs.readdir(dir), [], "no litter left in the data directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writers never observe a torn file", async () => {
  const dir = await fixture();
  try {
    const file = path.join(dir, "store.json");
    const payloads = Array.from({ length: 12 }, (_, index) => JSON.stringify({ writer: index, body: "x".repeat(4_096) }));
    await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload, { mode: 0o600 })));
    // Whichever writer landed last, the file must be exactly one payload — a
    // shared `.tmp` name would let two writers interleave into a corrupt blob.
    const settled = await fs.readFile(file, "utf8");
    assert.ok(payloads.includes(settled), "file holds exactly one writer's complete payload");
    assert.deepEqual(await fs.readdir(dir), ["store.json"], "no temp siblings survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renameWithRetry leaves the destination untouched until it succeeds", async () => {
  const dir = await fixture();
  try {
    const from = path.join(dir, "next");
    const to = path.join(dir, "current");
    await fs.writeFile(to, "old");
    await fs.writeFile(from, "new");
    const lock = lockingRename(2, "EBUSY");
    try {
      await renameWithRetry(from, to);
    } finally {
      lock.restore();
    }
    assert.equal(await fs.readFile(to, "utf8"), "new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
