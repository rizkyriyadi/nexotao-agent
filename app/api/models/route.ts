import { NextResponse } from "next/server";
import { cachedModels } from "@/lib/nexotao";

export const runtime = "nodejs";

// The model picker asks for this on every chat mount, so it reads the cached
// catalog: a burst of tabs costs one round-trip instead of one each.
export async function GET() {
  try {
    const models = await cachedModels();
    return NextResponse.json({ models });
  } catch (e) {
    return NextResponse.json({ models: [], error: String(e) }, { status: 200 });
  }
}
