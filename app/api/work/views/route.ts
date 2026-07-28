import { NextResponse } from "next/server";
import { objectField, readJsonObject, stringField } from "@/lib/http";
import { deleteSavedView, listSavedViews, saveView } from "@/lib/work-model";
import { requireProject, workError } from "../shared";

export const runtime = "nodejs";

/* A saved view is the whole `ViewConfig` — layout, grouping, ordering, filters —
   stored as opaque JSON. Deliberately not validated column by column: an older
   build's config still loads because `parseViewConfig` falls back per key rather
   than rejecting the document. */

export async function GET() {
  try {
    const project = await requireProject();
    return NextResponse.json({ views: await listSavedViews(project.id) });
  } catch (error) { return workError(error); }
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    const project = await requireProject();
    const view = await saveView({
      projectId: project.id,
      name: stringField(body, "name", { required: true, max: 120 })!,
      config: objectField(body, "config"),
    });
    return NextResponse.json({ view }, { status: 201 });
  } catch (error) { return workError(error); }
}

export async function DELETE(req: Request) {
  try {
    await requireProject();
    await deleteSavedView(new URL(req.url).searchParams.get("id") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
