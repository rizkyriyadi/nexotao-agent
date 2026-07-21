"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Play, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";

type Col = "backlog" | "todo" | "in_progress" | "review" | "done";
type Task = { id: string; ref: string; title: string; col: Col };

const COLUMNS: { id: Col; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export function Board() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  const load = () =>
    fetch("/api/tasks").then((r) => r.json()).then((d) => setTasks(d.tasks ?? [])).finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!title.trim()) return;
    await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    setTitle("");
    setOpen(false);
    load();
  }

  async function run(t: Task) {
    await fetch("/api/tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id, col: "in_progress" }) });
    router.push(`/chat?task=${encodeURIComponent(t.title)}&taskId=${t.id}`);
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-medium text-charcoal">Board</h1>
          <span className="font-mono text-[12px] text-pebble">{tasks.length} tasks</span>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" /> New task</Button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-pebble">
          <Loader2 className="mr-2 size-4 animate-spin" /> loading…
        </div>
      ) : (
        <div className="scroll-thin flex flex-1 gap-5 overflow-x-auto px-6 py-5">
          {COLUMNS.map((col) => {
            const items = tasks.filter((t) => t.col === col.id);
            return (
              <div key={col.id} className="flex w-[272px] shrink-0 flex-col">
                <div className="mb-3 flex items-center gap-2 px-0.5">
                  <span className="label">{col.label}</span>
                  <span className="font-mono text-[11px] text-pebble">{items.length}</span>
                </div>
                <div className="scroll-thin flex flex-1 flex-col gap-2.5 overflow-y-auto pb-2">
                  {items.map((t) => (
                    <div key={t.id} className="group rounded-xl border border-line bg-paper-white p-3.5">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="font-mono text-[11px] text-pebble">{t.ref}</span>
                      </div>
                      <p className="text-[13.5px] leading-snug text-charcoal">{t.title}</p>
                      <button onClick={() => run(t)} className="mt-2.5 flex items-center gap-1.5 text-[12px] text-electric-indigo opacity-0 transition-opacity group-hover:opacity-100">
                        <Play className="size-3.5" /> Run with agent
                      </button>
                    </div>
                  ))}
                  {items.length === 0 && <p className="px-1 font-mono text-[11px] text-pebble">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="e.g. Add a login page with JWT auth"
          />
          <DialogFooter className="mt-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={create} className={title.trim() ? "" : "pointer-events-none opacity-50"}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
