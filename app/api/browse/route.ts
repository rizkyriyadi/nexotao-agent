import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const runtime = "nodejs";

// Local machine directory browser (single-user local app).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("path") || os.homedir();
  const abs = path.resolve(raw);
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    return NextResponse.json({
      path: abs,
      parent: parent === abs ? null : parent,
      home: os.homedir(),
      dirs,
    });
  } catch (e) {
    return NextResponse.json({ path: abs, parent: path.dirname(abs), home: os.homedir(), dirs: [], error: String(e) });
  }
}
