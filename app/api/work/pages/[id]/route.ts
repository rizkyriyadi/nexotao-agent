import { NextResponse } from "next/server";
import { HttpError, numberField, readJsonObject, stringField } from "@/lib/http";
import { deletePage, getPage, updatePage } from "@/lib/work-model";
import { requireProject, workError } from "../../shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

async function ownedPage(id: string) {
  const project = await requireProject();
  const page = await getPage(id);
  if (!page || page.projectId !== project.id) throw new HttpError("Page not found", 404);
  return page;
}

export async function GET(_req: Request, context: Context) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ page: await ownedPage(id) });
  } catch (error) { return workError(error); }
}

/** Save a page. A body change appends a revision rather than overwriting it, so
 *  the document history stays intact; `archivedAt` hides a page without losing
 *  the writing in it. */
export async function PATCH(req: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(req);
    await ownedPage(id);
    const page = await updatePage(id, {
      ...(body.title !== undefined ? { title: stringField(body, "title", { max: 300 }) ?? "Untitled" } : {}),
      ...(body.body !== undefined ? { body: stringField(body, "body", { max: 1_000_000 }) ?? "" } : {}),
      ...(body.archivedAt !== undefined ? { archivedAt: numberField(body, "archivedAt", null) } : {}),
    });
    return NextResponse.json({ page });
  } catch (error) { return workError(error); }
}

export async function DELETE(_req: Request, context: Context) {
  try {
    const { id } = await context.params;
    await ownedPage(id);
    await deletePage(id);
    return NextResponse.json({ ok: true });
  } catch (error) { return workError(error); }
}
