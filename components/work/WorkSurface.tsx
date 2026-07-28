"use client";

/* The work surface: one fetch, one view config, five ways of drawing it.

   No layout filters or groups anything itself. `buildView` in lib/work-view.ts
   does that, and the server calls the same function for its own response, so the
   board a reload lands on is the board that was there before it. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_VIEW_CONFIG, buildView, type ViewConfig } from "@/lib/work-view";
import { WorkHeader } from "./WorkHeader";
import { BoardLayout, type Drop } from "./BoardLayout";
import { ListLayout } from "./ListLayout";
import { SpreadsheetLayout } from "./SpreadsheetLayout";
import { CalendarLayout } from "./CalendarLayout";
import { GanttLayout } from "./GanttLayout";
import { IssuePeek } from "./IssuePeek";
import type { WorkData } from "./parts";
import type { Issue } from "@/lib/issues";

const EMPTY: WorkData = { projectId: "", issues: [], states: [], labels: [], cycles: [], modules: [], agents: [] };

export function WorkSurface() {
  const [data, setData] = useState<WorkData>(EMPTY);
  const [config, setConfig] = useState<ViewConfig>(DEFAULT_VIEW_CONFIG);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/work/issues", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Could not load work items"); setLoading(false); return; }
    setError(null);
    setData({ projectId: body.projectId, issues: body.issues, states: body.states, labels: body.labels, cycles: body.cycles, modules: body.modules, agents: body.agents });
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  /* Grouped on the client from the raw issue list rather than from the server's
     view: switching layout or grouping is then instant and does not need a round
     trip, and both sides run the same function so they cannot disagree. */
  const view = useMemo(
    () => buildView(data.issues, config, { states: data.states, labels: data.labels, cycles: data.cycles, modules: data.modules, agents: data.agents }),
    [data, config],
  );

  const patch = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/work/issues", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      // The refusal is the interesting case: the lifecycle explains why a card
      // cannot go where it was dropped, and that sentence is worth showing
      // verbatim rather than replacing with "something went wrong".
      toast.error(payload.error ?? "That change was refused");
      await load();
      return;
    }
    await load();
  }, [load]);

  const onDrop = useCallback(async (drop: Drop) => {
    await patch({ id: drop.issueId, stateId: drop.groupKey, ...(drop.sequence == null ? {} : { sequence: drop.sequence }) });
  }, [patch]);

  const create = useCallback(async (title: string) => {
    const response = await fetch("/api/work/issues", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    const payload = await response.json();
    if (!response.ok) { toast.error(payload.error ?? "Could not create that work item"); return; }
    toast.success(`${payload.issue.ref} added to Backlog`);
    await load();
  }, [load]);

  const open = data.issues.find((issue) => issue.id === openId) ?? null;
  const onOpen = useCallback((issue: Issue) => setOpenId(issue.id), []);
  const layoutProps = { groups: view.groups, data, onOpen };

  if (loading) return <main className="min-w-0 flex-1 p-8 text-sm text-pebble">Loading work items…</main>;
  if (error) return <main className="min-w-0 flex-1 p-8"><p className="rounded-2xl border border-line bg-white/60 p-8 text-center text-sm text-pebble">{error}</p></main>;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkHeader
          config={config}
          total={view.total}
          data={data}
          onConfig={(next) => setConfig((current) => ({ ...current, ...next }))}
          onCreate={create}
        />
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          {config.layout === "board" && <BoardLayout {...layoutProps} onDrop={(drop) => void onDrop(drop)} groupedByState={config.groupBy === "state"} />}
          {config.layout === "list" && <ListLayout {...layoutProps} />}
          {config.layout === "spreadsheet" && <SpreadsheetLayout {...layoutProps} />}
          {config.layout === "calendar" && <CalendarLayout {...layoutProps} />}
          {config.layout === "gantt" && <GanttLayout {...layoutProps} />}
        </div>
      </main>
      {open && <IssuePeek issue={open} data={data} onClose={() => setOpenId(null)} onPatch={(body) => patch({ id: open.id, ...body })} />}
    </div>
  );
}
