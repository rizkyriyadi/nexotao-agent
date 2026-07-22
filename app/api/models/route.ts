import { NextResponse } from "next/server";
import { fetchModels } from "@/lib/nexotao";

export const runtime = "nodejs";

export async function GET() {
  try {
    const models = await fetchModels();
    return NextResponse.json({ models });
  } catch (e) {
    return NextResponse.json({ models: [], error: String(e) }, { status: 200 });
  }
}
