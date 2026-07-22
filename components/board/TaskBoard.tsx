"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Columns3, List, Loader2, Lock, Plus, RefreshCw, Search, UserPlus, WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { boardSurface, dependencyState } from "@/lib/task-ui-state";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
type Issue = {
  id: string; ref: string; title: string; status: IssueStatus; priority: string; detail: string;
  assigneeAgentId: string | null; parentId: string | null; blockedBy: string[]; updatedAt: number;
};
type Agent = { id: string; name: string; role: string };
type View = "board" | "list";
type Connection = "loading" | "online" | "disconnected" | "error";

const STATUSES: Array<{ id: IssueStatus; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];
const PRIORITIES = ["urgent", "high", "medium", "low"];

function Select(props: React.ComponentProps<"select">) {
  return <select {...props} className={"h-9 rounded-md border border-line-strong bg-paper-white px-2.5 text-[12px] text-bark-grey outline-none focus:border-electric-indigo " + (props.className ?? "")} />;
}

export function TaskBoard() {
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projectId, setProjectId] = useState("");
  const [connection, setConnection] = useState<Connection>("loading");
  const [view, setView] = useState<View>("board");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [priority, setPriority] = useState("all");
  const [dialog, setDialog] = useState<"task" | "goal" | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setConnection((current) => current === "online" ? current : "loading");
    try {
      const response = await fetch("/api/issues", { cache: "no-store" });
      if (!response.ok) throw new Error("The task service returned " + response.status);
      const data = await response.json();
      setIssues(data.issues ?? []);
      setAgents(data.agents ?? []);
      setProjectId(data.projectId ?? "");
      setConnection("online");
    } catch {
      setConnection((current) => current === "online" || current === "disconnected" ? "disconnected" : "error");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((issue) =>
      (!needle || issue.title.toLowerCase().includes(needle) || issue.ref.toLowerCase().includes(needle)) &&
      (status === "all" || issue.status === status) &&
      (assignee === "all" || (assignee === "unassigned" ? !issue.assigneeAgentId : issue.assigneeAgentId === assignee)) &&
      (priority === "all" || issue.priority === priority),
    );
  }, [issues, query, status, assignee, priority]);

  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? "Unassigned";
  const surface = boardSurface(connection, filtered.length);
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  // Resolve each card's blockers to their live statuses so "blocked" is derived, not guessed.
  const depOf = useCallback((issue: Issue) => dependencyState(issue.blockedBy.map((id) => byId.get(id)?.status ?? "todo")), [byId]);
  const blockedCount = issues.filter((issue) => issue.status === "blocked" || depOf(issue).isBlocked).length;
  const unassignedCount = issues.filter((issue) => !issue.assigneeAgentId && issue.status !== "done" && issue.status !== "cancelled").length;

  async function transition(id: string, nextStatus: IssueStatus) {
    const previous = issues;
    const issue = issues.find((candidate) => candidate.id === id);
    if (!issue || issue.status === nextStatus) return;
    setIssues((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: nextStatus } : candidate));
    try {
      const response = await fetch("/api/issues", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: nextStatus }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Transition was rejected");
      setIssues((current) => current.map((candidate) => candidate.id === id ? data.issue : candidate));
    } catch (error) {
      setIssues(previous);
      toast.error("Move rolled back", { description: error instanceof Error ? error.message : "Transition was rejected" });
    }
  }

  async function create() {
    const value = title.trim();
    if (!value || !dialog) return;
    setCreating(true);
    try {
      const response = await fetch("/api/issues", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(dialog === "goal" ? { goal: value } : { title: value, priority: "medium" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not create item");
      setDialog(null);
      setTitle("");
      if (dialog === "goal" && data.root?.id) router.push("/board/" + data.root.id);
      else {
        await load(true);
        if (data.issue?.id) router.push("/board/" + data.issue.id);
      }
    } catch (error) {
      toast.error("Create failed", { description: error instanceof Error ? error.message : "Try again" });
    } finally { setCreating(false); }
  }

  const card = (issue: Issue) => {
    const dep = depOf(issue);
    const blocked = issue.status === "blocked" || dep.isBlocked;
    const unassigned = !issue.assigneeAgentId && issue.status !== "done" && issue.status !== "cancelled";
    // Name the issues we're waiting on so "on what" is answerable without opening the card.
    const openRefs = issue.blockedBy.map((id) => byId.get(id)).filter((b): b is Issue => Boolean(b) && b!.status !== "done").map((b) => b.ref);
    return (
      <button
        key={issue.id}
        draggable
        onDragStart={() => setDragging(issue.id)}
        onDragEnd={() => setDragging(null)}
        onClick={() => router.push("/board/" + issue.id)}
        className={"group w-full rounded-xl border bg-paper-white p-3.5 text-left shadow-sm transition " + (dragging === issue.id ? "border-electric-indigo opacity-50" : blocked ? "border-amber-300 hover:border-amber-400" : "border-line hover:border-line-strong")}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[11px] text-pebble">{issue.ref}</span>
          <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " + (issue.priority === "urgent" ? "bg-red-50 text-alarm-red" : "bg-code-surface text-bark-grey")}>{issue.priority}</span>
          {blocked
            ? <span className="ml-auto flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"><Lock className="size-3" aria-hidden />Blocked</span>
            : unassigned && <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-pebble"><UserPlus className="size-3" aria-hidden />Unassigned</span>}
        </div>
        <p className="text-[13.5px] leading-snug text-charcoal">{issue.title}</p>
        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-pebble">
          <span className="truncate">{agentName(issue.assigneeAgentId)}</span>
          {dep.total > 0 && (
            <span className={"flex shrink-0 items-center gap-1 " + (dep.open > 0 ? "text-amber-700" : "text-lichen-green")} title={dep.open > 0 ? "Waiting on " + openRefs.join(", ") : "All dependencies resolved"}>
              {dep.open > 0
                ? <>Waiting on {openRefs.slice(0, 2).join(", ")}{openRefs.length > 2 ? " +" + (openRefs.length - 2) : ""}</>
                : <>{dep.total} dependenc{dep.total === 1 ? "y" : "ies"} clear</>}
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <header className="border-b border-line px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><h1 className="text-[15px] font-medium">Tasks</h1>{blockedCount > 0 && <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800"><Lock className="size-3" aria-hidden />{blockedCount} blocked</span>}{unassignedCount > 0 && <span className="rounded-full bg-code-surface px-2 py-0.5 text-[10px] font-medium text-bark-grey">{unassignedCount} unassigned</span>}</div>
            <p className="font-mono text-[11px] text-pebble">{issues.length} canonical issues</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialog("task")}><Plus className="size-4" /> Quick task</Button>
            <Button size="sm" onClick={() => setDialog("goal")}><Plus className="size-4" /> Create goal</Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[210px] flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-pebble" /><Input aria-label="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks…" className="pl-8" /></div>
          <Select aria-label="Project filter" value={projectId} onChange={() => undefined}><option value={projectId}>Current project</option></Select>
          <Select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{STATUSES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>
          <Select aria-label="Assignee filter" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select>
          <Select aria-label="Priority filter" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All priorities</option>{PRIORITIES.map((item) => <option key={item}>{item}</option>)}</Select>
          <div className="flex rounded-md border border-line-strong bg-paper-white p-0.5">
            <button aria-label="Board view" onClick={() => setView("board")} className={"rounded p-1.5 " + (view === "board" ? "bg-code-surface text-charcoal" : "text-pebble")}><Columns3 className="size-4" /></button>
            <button aria-label="List view" onClick={() => setView("list")} className={"rounded p-1.5 " + (view === "list" ? "bg-code-surface text-charcoal" : "text-pebble")}><List className="size-4" /></button>
          </div>
        </div>
      </header>

      {(connection === "disconnected" || connection === "error") && (
        <div role="alert" className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-6 py-2 text-[12px] text-amber-900">
          <span className="flex items-center gap-2"><WifiOff className="size-4" />{connection === "disconnected" ? "Connection lost. Showing the last server state while reconnecting…" : "Could not load tasks."}</span>
          <button onClick={() => void load()} className="flex items-center gap-1 font-medium"><RefreshCw className="size-3.5" /> Retry</button>
        </div>
      )}

      {surface === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-pebble"><Loader2 className="mr-2 size-4 animate-spin" /> Loading tasks…</div>
      ) : surface === "empty" || surface === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center"><Columns3 className="size-8 text-line-strong" /><p className="text-[14px] font-medium">No tasks match these filters</p><p className="text-[12px] text-pebble">Clear filters or create a task to get started.</p></div>
      ) : view === "board" ? (
        <div className="scroll-thin flex flex-1 gap-4 overflow-x-auto px-6 py-5">
          {STATUSES.map((column) => {
            const items = filtered.filter((issue) => issue.status === column.id);
            return (
              <section
                key={column.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => { if (dragging) void transition(dragging, column.id); }}
                className="flex w-[260px] shrink-0 flex-col rounded-xl bg-code-surface/60 p-2"
              >
                <div className="mb-2 flex items-center justify-between px-1"><span className="label">{column.label}</span><span className="font-mono text-[11px] text-pebble">{items.length}</span></div>
                <div className="scroll-thin flex flex-1 flex-col gap-2 overflow-y-auto">{items.map(card)}{items.length === 0 && <div className="rounded-lg border border-dashed border-line-strong p-5 text-center text-[11px] text-pebble">Drop here</div>}</div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="scroll-thin flex-1 overflow-auto px-6 py-5">
          <div className="overflow-hidden rounded-xl border border-line bg-paper-white">
            <div className="grid grid-cols-[100px_1fr_130px_130px_130px] border-b border-line bg-code-surface px-4 py-2 label"><span>Key</span><span>Title</span><span>Status</span><span>Assignee</span><span>Priority</span></div>
            {filtered.map((issue) => { const dep = depOf(issue); const blocked = issue.status === "blocked" || dep.isBlocked; return <button key={issue.id} onClick={() => router.push("/board/" + issue.id)} className="grid w-full grid-cols-[100px_1fr_130px_130px_130px] items-center border-b border-line px-4 py-3 text-left text-[12px] last:border-0 hover:bg-code-surface"><span className="font-mono text-pebble">{issue.ref}</span><span className="truncate pr-4 text-[13px]">{issue.title}</span><span className={"flex items-center gap-1 " + (blocked ? "text-amber-800" : "")}>{blocked && <Lock className="size-3" aria-hidden />}{issue.status.replace("_", " ")}{blocked && dep.open > 0 ? " (" + dep.open + ")" : ""}</span><span>{agentName(issue.assigneeAgentId)}</span><span>{issue.priority}</span></button>; })}
          </div>
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dialog === "goal" ? "Create goal" : "Quick create task"}</DialogTitle></DialogHeader>
          <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void create()} placeholder={dialog === "goal" ? "What outcome should the team deliver?" : "Task title"} />
          <DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={!title.trim() || creating} onClick={() => void create()}>{creating && <Loader2 className="size-4 animate-spin" />}{dialog === "goal" ? "Start goal" : "Create task"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
