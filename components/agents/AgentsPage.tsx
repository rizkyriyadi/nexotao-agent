"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Bot, CheckCircle2, Clock, Pause, Play, Plus, RefreshCw, RotateCcw, Settings2, Square, Users, XCircle } from "lucide-react";
import { toast } from "sonner";
import { agentPP } from "@/lib/avatars";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type Status = "idle" | "queued" | "running" | "paused" | "error" | "terminated";
type Run = { id: string; status: string; source: string; task: string | null; startedAt: number; finishedAt: number | null; error: string | null };
type Revision = { id: string; revision: number; createdAt: number };
type Cost = { id: string; model: string; inputTokens: number; outputTokens: number; cost: number; createdAt: number };
type Agent = {
  id: string; name: string; role: "lead" | "worker"; title: string; scope: string; reportsTo: string | null; capabilities: string[];
  status: Status; adapterType: string; adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>; instructions: string; projectAccess: string[]; concurrency: number; budgetLimit: number | null;
  spentAmount: number; pauseReason: string | null; errorReason: string | null; lastHeartbeatAt: number | null; currentTask: string | null;
  currentRun: Run | null; lastTask: { id: string; title: string; status: string } | null; runs: Run[]; costs: Cost[]; revisions: Revision[];
};
type FormState = { name: string; title: string; scope: string; instructions: string; capabilities: string; adapterType: string; model: string; concurrency: string; permissions: string; projectAccess: string; budgetLimit: string };

const statusStyle: Record<Status, string> = {
  idle: "bg-line text-bark-grey", queued: "bg-mist-lavender text-deep-violet", running: "bg-mist-lavender text-deep-violet",
  paused: "bg-amber-50 text-amber-700", error: "bg-red-50 text-alarm-red", terminated: "bg-charcoal/8 text-pebble",
};
function ago(ts: number | null) {
  if (!ts) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function blank(agent?: Agent): FormState {
  return { name: agent?.name ?? "", title: agent?.title ?? "Specialist", scope: agent?.scope ?? "", instructions: agent?.instructions ?? "",
    capabilities: agent?.capabilities.join(", ") ?? "", adapterType: agent?.adapterType ?? "nexotao", model: String(agent?.adapterConfig.model ?? ""),
    concurrency: String(agent?.concurrency ?? 1), permissions: JSON.stringify(agent?.permissions ?? {}, null, 2),
    projectAccess: agent?.projectAccess.join(", ") ?? "", budgetLimit: agent?.budgetLimit == null ? "" : String(agent.budgetLimit) };
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<FormState>(blank());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load agents");
      setAgents(data.agents ?? []);
      setSelectedId((current) => current && data.agents.some((item: Agent) => item.id === current) ? current : data.agents[0]?.id ?? null);
    } catch (error) { if (!quiet) toast.error(error instanceof Error ? error.message : "Could not load agents"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selected = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);
  const lead = agents.find((agent) => agent.role === "lead" && agent.status !== "terminated") ?? null;
  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    let permissions: Record<string, unknown>;
    try {
      const parsed = JSON.parse(form.permissions || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      permissions = parsed;
    } catch { return toast.error("Permissions must be a JSON object"); }
    if (!form.name.trim()) return toast.error("Name is required");
    setBusy("save");
    try {
      const editing = dialog === "edit" && selected;
      const payload = {
        ...(editing ? { id: selected.id, role: selected.role } : { role: "worker" }), name: form.name, title: form.title, scope: form.scope,
        instructions: form.instructions, reportsTo: editing ? selected.reportsTo : lead?.id ?? null,
        capabilities: form.capabilities.split(",").map((item) => item.trim()).filter(Boolean), adapterType: form.adapterType,
        adapterConfig: { ...(editing ? selected.adapterConfig : {}), model: form.model }, runtimeConfig: editing ? selected.runtimeConfig : {},
        permissions, projectAccess: form.projectAccess.split(",").map((item) => item.trim()).filter(Boolean), concurrency: Number(form.concurrency),
        budgetLimit: form.budgetLimit === "" ? null : Number(form.budgetLimit),
      };
      const response = await fetch("/api/agents", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save agent");
      toast.success(editing ? "Agent configuration saved" : "Specialist created");
      setDialog(null); await load(); setSelectedId(data.agent.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save agent"); }
    finally { setBusy(null); }
  }

  async function action(name: string, extra: Record<string, unknown> = {}) {
    if (!selected) return;
    if (name === "terminate" && !window.confirm(`Terminate ${selected.name}? This cannot be undone.`)) return;
    if (name === "pause" && selected.status === "running" && !window.confirm(`Pause ${selected.name} and cancel its current run?`)) return;
    setBusy(name);
    try {
      const response = await fetch(`/api/agents/${selected.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: name, confirmed: name === "terminate", ...extra }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Action failed");
      toast.success(name.replaceAll("_", " ")); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(null); }
  }

  return <div className="flex h-full min-w-0 flex-1">
    <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-paper-white">
      <header className="flex h-14 items-center gap-2.5 border-b border-line px-5"><Users className="size-4 text-electric-indigo" /><h1 className="text-[15px] font-medium">Agent roster</h1><span className="ml-auto font-mono text-[11px] text-pebble">{agents.length}</span><Button size="icon" variant="ghost" className="size-8" onClick={() => { setForm(blank()); setDialog("create"); }} disabled={!lead}><Plus /></Button></header>
      <div className="scroll-thin flex-1 overflow-y-auto p-3">
        {loading ? <p className="p-4 text-[13px] text-pebble">Loading roster…</p> : agents.length === 0 ? <Empty text="No agents configured" icon /> : agents.map((agent, index) =>
          <button key={agent.id} onClick={() => setSelectedId(agent.id)} className={`mb-2 w-full rounded-2xl border p-3 text-left ${selectedId === agent.id ? "border-electric-indigo bg-electric-indigo/[0.04]" : "border-line hover:border-line-strong"}`}>
            <div className="flex items-center gap-3"><img src={agentPP(index)} alt="" className="size-9 rounded-xl object-cover" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-[13.5px] font-medium">{agent.name}</span><StatusPill status={agent.status} /></div><p className="truncate text-[11.5px] text-bark-grey">{agent.currentTask ?? agent.title ?? agent.scope}</p></div></div>
            <div className="mt-2 flex justify-between pl-12 font-mono text-[10px] text-pebble"><span>{ago(agent.lastHeartbeatAt)}</span><span>{"$"}{agent.spentAmount.toFixed(2)}</span></div>
          </button>)}
      </div>
      <div className="border-t border-line p-3"><Button className="w-full" variant="outline" onClick={() => { setForm(blank()); setDialog("create"); }} disabled={!lead}><Plus /> Add specialist</Button></div>
    </aside>

    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-warm-bone">
      {!selected ? <div className="flex h-full items-center justify-center text-[13px] text-pebble">Select an agent</div> :
        <><header className="sticky top-0 z-10 flex min-h-16 items-center gap-3 border-b border-line bg-warm-bone/95 px-6 backdrop-blur">
          <img src={agentPP(Math.max(0, agents.indexOf(selected)))} alt="" className="size-9 rounded-xl object-cover" /><div><div className="flex items-center gap-2"><h2 className="text-[16px] font-medium">{selected.name}</h2><StatusPill status={selected.status} /></div><p className="text-[12px] text-bark-grey">{selected.title || (selected.role === "lead" ? "Lead" : "Specialist")}</p></div>
          <div className="ml-auto flex gap-2"><Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw /> Refresh</Button><Button size="sm" variant="outline" onClick={() => { setForm(blank(selected)); setDialog("edit"); }} disabled={selected.status === "terminated"}><Settings2 /> Edit</Button></div>
        </header>
        <Tabs defaultValue="overview"><div className="border-b border-line px-6"><TabsList>{["overview", "instructions", "runtime", "permissions", "runs", "costs"].map((tab) => <TabsTrigger key={tab} value={tab} className="capitalize">{tab}</TabsTrigger>)}</TabsList></div>
          <div className="mx-auto max-w-5xl p-6">
            <TabsContent value="overview" className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Status" value={selected.status} /><Metric label="Current task" value={selected.currentTask ?? "None"} /><Metric label="Last heartbeat" value={ago(selected.lastHeartbeatAt)} /><Metric label="Spend" value={`$${selected.spentAmount.toFixed(2)}`} /></div>
              {selected.errorReason && <div className="flex gap-3 rounded-xl border border-red-100 bg-red-50 p-4 text-[13px] text-alarm-red"><AlertTriangle className="size-4" />{selected.errorReason}</div>}
              <Card title="Identity & hierarchy"><Details rows={[["Role", selected.role === "lead" ? "Lead" : "Specialist"], ["Reports to", agents.find((item) => item.id === selected.reportsTo)?.name ?? "—"], ["Title", selected.title || "—"], ["Scope", selected.scope || "—"], ["Capabilities", selected.capabilities.join(", ") || "—"]]} /></Card>
              <Card title="Configuration history">{selected.revisions.length ? <div className="space-y-2">{selected.revisions.slice(0, 8).map((revision) => <div key={revision.id} className="flex items-center justify-between rounded-xl border border-line px-3 py-2"><span className="text-[12.5px]">Revision {revision.revision} · {ago(revision.createdAt)}</span><Button size="sm" variant="ghost" disabled={busy !== null || selected.status === "terminated"} onClick={() => void action("restore_revision", { revision: revision.revision })}><RotateCcw /> Restore</Button></div>)}</div> : <Empty text="No revisions yet" />}</Card>
            </TabsContent>
            <TabsContent value="instructions"><Card title="Managed instructions"><pre className="whitespace-pre-wrap text-[13px] text-bark-grey">{selected.instructions || "No instructions configured."}</pre></Card></TabsContent>
            <TabsContent value="runtime" className="space-y-5">
              <Card title="Lifecycle controls"><div className="flex flex-wrap gap-2">
                {selected.status === "idle" && <Button size="sm" onClick={() => void action("invoke")} disabled={!selected.lastTask || busy !== null}><Play /> Invoke</Button>}
                {["idle", "queued", "running"].includes(selected.status) && <Button size="sm" variant="outline" onClick={() => void action("pause")} disabled={busy !== null}><Pause /> Pause</Button>}
                {selected.status === "paused" && <Button size="sm" onClick={() => void action("resume")} disabled={busy !== null}><Play /> Resume</Button>}
                {selected.status === "error" && <><Button size="sm" onClick={() => void action("retry_last_task")} disabled={busy !== null}><RotateCcw /> Retry last task</Button><Button size="sm" variant="outline" onClick={() => void action("clear_error")} disabled={busy !== null}><CheckCircle2 /> Clear error</Button></>}
                {selected.status !== "terminated" && <Button size="sm" variant="destructive" onClick={() => void action("terminate")} disabled={busy !== null}><Square /> Terminate</Button>}
              </div></Card>
              <Card title="Runtime settings"><Details rows={[["Adapter", selected.adapterType], ["Model", String(selected.adapterConfig.model || "Default")], ["Concurrency", String(selected.concurrency)], ["Current run", selected.currentRun?.id ?? "None"], ["Pause reason", selected.pauseReason ?? "—"]]} /></Card>
              <Card title="Adapter configuration"><JsonBlock value={selected.adapterConfig} /></Card>
            </TabsContent>
            <TabsContent value="permissions" className="space-y-5"><Card title="Permissions"><JsonBlock value={selected.permissions} /></Card><Card title="Project access"><p className="text-[13px] text-bark-grey">{selected.projectAccess.join(", ") || "No explicit projects"}</p></Card></TabsContent>
            <TabsContent value="runs"><Card title="Heartbeat runs">{selected.runs.length ? <div className="space-y-2">{selected.runs.map((run) => <div key={run.id} className="flex gap-3 rounded-xl border border-line p-3">{run.status === "failed" ? <XCircle className="size-4 text-alarm-red" /> : <Clock className="size-4 text-electric-indigo" />}<div><p className="text-[13px] font-medium">{run.task ?? "Agent heartbeat"}</p><p className="font-mono text-[10px] text-pebble">{run.status} · {ago(run.startedAt)} · {run.source}</p>{run.error && <p className="text-[12px] text-alarm-red">{run.error}</p>}</div></div>)}</div> : <Empty text="No runs yet" />}</Card></TabsContent>
            <TabsContent value="costs" className="space-y-5"><div className="grid gap-3 sm:grid-cols-3"><Metric label="Total spend" value={`$${selected.spentAmount.toFixed(4)}`} /><Metric label="Budget" value={selected.budgetLimit == null ? "Unlimited" : `$${selected.budgetLimit.toFixed(2)}`} /><Metric label="Events" value={String(selected.costs.length)} /></div><Card title="Cost events">{selected.costs.length ? selected.costs.map((cost) => <div key={cost.id} className="mb-2 flex items-center rounded-xl border border-line p-3 text-[12px]"><span className="flex-1">{cost.model}</span><span className="mr-4 font-mono text-pebble">{cost.inputTokens + cost.outputTokens} tokens</span><span className="font-mono">{"$"}{cost.cost.toFixed(4)}</span></div>) : <Empty text="No cost events yet" />}</Card></TabsContent>
          </div>
        </Tabs></>}
    </main>

    <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
      <DialogHeader><DialogTitle>{dialog === "edit" ? "Edit agent" : "Create specialist"}</DialogTitle><DialogDescription>Configuration changes are versioned and recorded.</DialogDescription></DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={form.name} onChange={(e) => set("name", e.target.value)} /></Field><Field label="Title"><Input value={form.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <Field label="Scope" wide><Textarea value={form.scope} onChange={(e) => set("scope", e.target.value)} /></Field><Field label="Capabilities" wide><Input placeholder="coding, review" value={form.capabilities} onChange={(e) => set("capabilities", e.target.value)} /></Field>
        <Field label="Adapter"><Input value={form.adapterType} onChange={(e) => set("adapterType", e.target.value)} /></Field><Field label="Model"><Input value={form.model} onChange={(e) => set("model", e.target.value)} /></Field>
        <Field label="Concurrency"><Input type="number" min="1" max="20" value={form.concurrency} onChange={(e) => set("concurrency", e.target.value)} /></Field><Field label="Budget limit"><Input type="number" min="0" value={form.budgetLimit} onChange={(e) => set("budgetLimit", e.target.value)} /></Field>
        <Field label="Project access" wide><Input value={form.projectAccess} onChange={(e) => set("projectAccess", e.target.value)} /></Field><Field label="Permissions (JSON)" wide><Textarea className="min-h-28 font-mono text-[11px]" value={form.permissions} onChange={(e) => set("permissions", e.target.value)} /></Field>
        <Field label="Instructions" wide><Textarea className="min-h-36" value={form.instructions} onChange={(e) => set("instructions", e.target.value)} /></Field>
      </div><DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => void save()} disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save agent"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

function StatusPill({ status }: { status: Status }) { return <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] uppercase ${statusStyle[status]}`}>{status}</span>; }
function Card({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-2xl border border-line bg-paper-white p-5"><h3 className="mb-4 text-[13.5px] font-medium">{title}</h3>{children}</section>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-line bg-paper-white p-4"><p className="label">{label}</p><p className="mt-2 truncate text-[15px] font-medium capitalize">{value}</p></div>; }
function Details({ rows }: { rows: string[][] }) { return <dl className="grid gap-4 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="label">{label}</dt><dd className="mt-1 text-[13px] text-bark-grey">{value}</dd></div>)}</dl>; }
function JsonBlock({ value }: { value: unknown }) { return <pre className="overflow-x-auto rounded-xl bg-code-surface p-4 font-mono text-[11px] text-bark-grey">{JSON.stringify(value, null, 2)}</pre>; }
function Empty({ text, icon }: { text: string; icon?: boolean }) { return <div className="py-8 text-center text-[13px] text-pebble">{icon && <Bot className="mx-auto mb-2 size-5" />}{text}</div>; }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) { return <label className={wide ? "sm:col-span-2" : ""}><span className="mb-1.5 block text-[12px] font-medium">{label}</span>{children}</label>; }
