import { NextResponse } from "next/server";
import { readJsonObject, stringField } from "@/lib/http";
import { createPage, listPages } from "@/lib/work-model";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/* Pages are markdown documents stored through the existing `documents` /
   `document_revisions` pair, so every save is versioned without a second history
   mechanism. This route lists and creates; the body lives behind `[id]`. */

export async function GET() {
  try {
    const project = await requireProject();
    return NextResponse.json({ pages: await listPages(project.id) });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const page = await createPage({
      projectId: project.id,
      title: stringField(body, "title", { max: 300 }) ?? "Untitled",
      body: stringField(body, "body", { max: 1_000_000 }) ?? "",
    });
    return NextResponse.json({ page }, { status: 201 });
  } catch (error) { return workError(error); }
}
