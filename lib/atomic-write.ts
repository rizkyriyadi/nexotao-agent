// Atomic file replacement that survives Windows.
//
// Every durable store in the app (SQLite snapshot, work graph, code graph,
// config) writes a `.tmp` sibling and renames it over the destination so a
// reader never observes a half-written file. On POSIX that rename is atomic and
// always succeeds. On Windows it is neither: `rename(2)` maps to `MoveFileEx`,
// which fails with EPERM/EACCES/EBUSY whenever *any* process holds an open
// handle on the destination — antivirus real-time scanning, Windows Search
// indexing, OneDrive/Dropbox sync, or a Explorer preview pane are all enough.
// The handle is released within milliseconds, so the correct response is to
// retry rather than to fail the caller's write.
//
// Without this, a single transient scanner handle on ~/.nexotao/nexotao.sqlite
// surfaces to the user as `EPERM: operation not permitted, rename ...` and, as
// the database persists on *every* mutation, poisons whatever operation was in
// flight: the agent flips to `error`, its run is recorded as failed, and the
// task it was executing stalls.
import { promises as fs } from "fs";
import path from "path";

// Errors that mean "the destination was momentarily locked", as opposed to a
// genuine permission or layout problem that retrying cannot fix.
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]);

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 8;

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Process-wide counter. `pid` alone collides across concurrent writers in the
// same process, and a timestamp alone collides within the same millisecond —
// two writers sharing a temp name is precisely the corruption this guards.
let sequence = 0;

/**
 * Rename `from` over `to`, retrying while the destination is transiently locked.
 *
 * Backs off exponentially (8ms, 16ms, 32ms, ... capped) for up to ~2s total,
 * which comfortably outlasts an antivirus or indexer handle. A non-transient
 * error, or exhausting the retries, rethrows so real faults still surface.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(error)) throw error;
      await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 400));
    }
  }
}

/**
 * Durably replace `file` with `data`.
 *
 * Writes to a process-unique temp sibling first so two concurrent writers (or a
 * crashed previous run that left a stale `.tmp` behind) cannot corrupt each
 * other's payload, then renames it into place with the Windows-safe retry. The
 * temp file is cleaned up if the rename ultimately fails, so a lock storm does
 * not litter the data directory.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  // Unique suffix: a fixed `.tmp` name is shared state between concurrent
  // writers and is exactly what a stale lock leaves behind.
  const temp = `${file}.${process.pid.toString(36)}.${(sequence++).toString(36)}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(temp, data, { mode });
  try {
    await fs.chmod(temp, mode);
    await renameWithRetry(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
