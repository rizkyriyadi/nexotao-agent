"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, ArrowUpRight, Network } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";

type Issue = { id: string; ref: string; title: string; status: string; assigneeAgentId: string | null; parentId: string | null; summary: string; updatedAt: number };
type Agent = { id: string; name: string; role: string };

// board columns ← issue statuses
const COLUMNS: { id: string; label: string; match: string[] }[] = [
  { id: "backlog", label: "Backlog", match: ["backlog"] },
  { id: "todo", label: "Todo", match: ["todo", "blocked"] },
  { id: "in_progress", label: "In progress", match: ["in_progress"] },
  { id: "in_review", label: "Review", match: ["in_review"] },
  { id: "done", label: "Done", match: ["done"] },
];

export function Board() {
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  const load = () =>
    fetch("/api/issues").then((r) => r.json()).then((d) => { setIssues(d.issues ?? []); setAgents(d.agents ?? []); }).finally(() => setLoading(false));
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    loadRef.current();
    const t = setInterval(() => loadRef.current(), 2500);
    return () => clearInterval(t);
  }, []);

  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name;
  const rootOf = (i: Issue): string => {
    let cur: Issue | undefined = i;
    const byId = new Map(issues.map((x) => [x.id, x]));
    for (let g = 0; g < 8 && cur; g++) { if (!cur.parentId) return cur.id; cur = byId.get(cur.parentId); }
    return i.id;
  };

  const running = issues.filter((i) => i.status === "in_progress").length;
  const doneCount = issues.filter((i) => i.status === "done").length;

  async function create() {
    const goal = title.trim();
    if (!goal) return;
    setOpen(false); setTitle("");
    const r = await fetch("/api/issues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal }) }).then((x) => x.json());
    if (r.root?.id) router.push(`/orchestrator?goal=${r.root.id}`);
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-medium text-charcoal">Board</h1>
          <span className="flex items-baseline gap-2.5 font-mono text-[12px] text-pebble">
            <span>{issues.length} issues</span>
            {running > 0 && <span className="flex items-center gap-1 text-electric-indigo"><span className="size-[6px] rounded-full bg-electric-indigo nx-pulse" />{running} running</span>}
            <span className="text-lichen-green">{doneCount} done</span>
          </span>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" /> New goal</Button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-pebble"><Loader2 className="mr-2 size-4 animate-spin" /> loading…</div>
      ) : (
        <div className="scroll-thin flex flex-1 gap-5 overflow-x-auto px-6 py-5">
          {COLUMNS.map((col) => {
            const items = issues.filter((t) => col.match.includes(t.status));
            return (
              <div key={col.id} className="flex w-[272px] shrink-0 flex-col">
                <div className="mb-3 flex items-center gap-2 px-0.5">
                  <span className="label">{col.label}</span>
                  <span className="font-mono text-[11px] text-pebble">{items.length}</span>
                </div>
                <div className="scroll-thin flex flex-1 flex-col gap-2.5 overflow-y-auto pb-2">
                  {items.map((t) => {
                    const agent = nameOf(t.assigneeAgentId);
                    return (
                      <button key={t.id} onClick={() => router.push(`/orchestrator?goal=${rootOf(t)}`)} className="group rounded-xl border border-line bg-paper-white p-3.5 text-left transition-colors hover:border-line-strong">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="font-mono text-[11px] text-pebble">{t.ref}</span>
                          {agent && (
                            <span className="flex items-center gap-1 rounded-md bg-mist-lavender px-1.5 py-0.5 text-[10.5px] font-medium text-electric-indigo">
                              {!t.parentId ? <Network className="size-3" /> : null}{agent}
                            </span>
                          )}
                          {t.status === "in_progress" && <span className="ml-auto size-[6px] rounded-full bg-electric-indigo nx-pulse" />}
                        </div>
                        <p className="text-[13.5px] leading-snug text-charcoal">{t.title}</p>
                        {t.summary && (t.status === "done" || t.status === "in_review") && <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-bark-grey">{t.summary}</p>}
                        <span className="mt-2.5 flex items-center gap-1.5 text-[12px] text-electric-indigo opacity-0 transition-opacity group-hover:opacity-100"><ArrowUpRight className="size-3.5" /> Open run</span>
                      </button>
                    );
                  })}
                  {items.length === 0 && <p className="px-1 font-mono text-[11px] text-pebble">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New goal</DialogTitle></DialogHeader>
          <Input aria-label="Goal title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="e.g. Add a login page with JWT auth" />
          <DialogFooter className="mt-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={create} className={title.trim() ? "" : "pointer-events-none opacity-50"}>Start run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
