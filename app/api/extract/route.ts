import { NextResponse } from "next/server";
import { extractFileText } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Extract readable text from an uploaded file (PDF → text, etc.) on the user's
 * machine. Keeps binaries out of the model; hands it the text. */
export async function POST(req: Request) {
  const { name, dataB64 } = (await req.json()) as { name: string; dataB64: string };
  if (!dataB64) return NextResponse.json({ ok: false, text: "empty file" }, { status: 400 });
  const bytes = new Uint8Array(Buffer.from(dataB64, "base64"));
  const r = await extractFileText(name || "file", bytes);
  return NextResponse.json(r);
}
