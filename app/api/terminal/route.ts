import { NextResponse } from "next/server";
import { getSession, openSession } from "@/lib/terminal";
import { activeRoot, resolveRoot } from "@/lib/workspace-files";

export const runtime = "nodejs";

/** Open (or rejoin) the shell for the folder the panel is showing, and feed it.
 *
 *  The folder is resolved server-side from the same `activeRoot` the file tree
 *  uses, never from a path in the request body: a terminal that spawns wherever
 *  the client asks is a shell on the whole machine handed to anything that can
 *  reach the port. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const action = String(body.action ?? "open");

  if (action === "open") {
    const root = body.rootId ? await resolveRoot(String(body.rootId)) : await activeRoot();
    if (!root) return NextResponse.json({ error: "No workspace folder is open yet." }, { status: 404 });
    const session = openSession(root.id, root.path);
    return NextResponse.json({ sessionId: session.id, cwd: session.cwd, root: { id: root.id, label: root.label, path: root.path } });
  }

  const session = getSession(String(body.sessionId ?? ""));
  if (!session) return NextResponse.json({ error: "That shell is gone. Open a new one." }, { status: 404 });

  if (action === "run") {
    if (!session.run(String(body.data ?? ""))) return NextResponse.json({ error: "The shell has exited." }, { status: 409 });
  } else if (action === "write") {
    if (!session.write(String(body.data ?? ""))) return NextResponse.json({ error: "The shell has exited." }, { status: 409 });
  } else if (action === "interrupt") {
    session.interrupt();
  } else if (action === "close") {
    session.dispose();
  } else {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
  return NextResponse.json({ ok: true, cwd: session.cwd, alive: session.alive });
}
