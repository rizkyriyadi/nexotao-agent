import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/db/database";
import { activityLog } from "@/lib/db/schema";
import { detectCodeMemory, installCodeMemory, CLI_PACKAGE, INSTALL_COMMAND } from "@/lib/code-memory";

export const runtime = "nodejs";
// npm can take a minute over a cold cache; the probe of this exact command took 33 s.
export const maxDuration = 600;

/** Whether the code index is available, and the command that would install it. */
export async function GET() {
  return NextResponse.json({ available: await detectCodeMemory(), package: CLI_PACKAGE, command: INSTALL_COMMAND });
}

/**
 * Install the optional code-index CLI on the user's machine.
 *
 * This downloads and unpacks roughly a quarter of a gigabyte, so it is never a
 * side effect of anything: not of boot, not of a run, not of the Build button.
 * It happens here and only when the user has explicitly confirmed, which is why
 * `confirm: true` is required rather than inferred from the request arriving —
 * the same shape deleteProjectData uses for the other genuinely irreversible
 * action in this app.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== true) {
    return NextResponse.json({ ok: false, error: "confirmation_required", command: INSTALL_COMMAND }, { status: 400 });
  }

  if (await detectCodeMemory()) return NextResponse.json({ ok: true, available: true, alreadyInstalled: true });

  const result = await installCodeMemory();
  const available = result.ok ? await detectCodeMemory() : false;

  // Installing software on the user's machine belongs in the audit trail even
  // when they asked for it — especially then, since nothing else records it.
  try {
    const database = await getDatabase();
    await database.write((db) => db.insert(activityLog).values({
      id: randomUUID(), actorType: "user", actorId: null, action: "code_index.installed",
      entityType: "system", entityId: CLI_PACKAGE,
      summary: { ok: result.ok && available, ...(result.error ? { error: result.error.slice(0, 500) } : {}) },
      runId: null, createdAt: Date.now(),
    }).run());
  } catch { /* the install is what matters; the log is best effort */ }

  if (!result.ok || !available) {
    return NextResponse.json({ ok: false, available: false, error: result.error ?? "Install finished but the binary is still not runnable.", command: INSTALL_COMMAND }, { status: 500 });
  }
  return NextResponse.json({ ok: true, available: true });
}
