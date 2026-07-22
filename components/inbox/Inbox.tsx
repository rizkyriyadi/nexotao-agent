"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock3, ExternalLink, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type InboxData = {
  approvals: Array<{ id: string; action: string | null; target: string | null; risk: string | null; preview: string | null; issue: string | null; href: string; createdAt: number }>;
  issues: Array<{ id: string; identifier: string; title: string; status: string; priority: string; href: string; updatedAt: number }>;
  runs: Array<{ id: string; status: string; error: string | null; href: string; startedAt: number }>;
};

const empty: InboxData = { approvals: [], issues: [], runs: [] };

export function InboxPage() {
  const [data, setData] = useState<InboxData>(empty);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/inbox", { cache: "no-store" }).then((response) => response.json()).then(setData), []);
  useEffect(() => { void load(); const timer = setInterval(load, 5_000); return () => clearInterval(timer); }, [load]);
  const decide = async (id: string, decision: "allow" | "deny") => {
    setBusy(id);
    await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approvalId: id, decision }) });
    await load();
    setBusy(null);
  };
  const total = data.approvals.length + data.issues.length + data.runs.length;

  return <main className="scroll-thin min-w-0 flex-1 overflow-y-auto p-6 lg:p-8">
    <div className="mx-auto max-w-5xl">
      <div className="mb-7"><p className="label text-electric-indigo">Trust center</p><h1 className="mt-1 font-serif text-3xl text-charcoal">Approval Inbox</h1><p className="mt-2 text-sm text-pebble">Decisions and exceptions that need a human.</p></div>
      {!total && <div className="rounded-2xl border border-line bg-white/60 p-10 text-center text-sm text-pebble">Inbox zero. No action is waiting.</div>}
      <Section title="Pending approvals" count={data.approvals.length} icon={<ShieldAlert className="size-4" />}>
        {data.approvals.map((item) => <article id={`approval-${item.id}`} key={item.id} className="rounded-2xl border border-line bg-white/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Risk value={item.risk} /><b className="text-sm capitalize">{item.action}</b>{item.issue && <span className="text-xs text-pebble">{item.issue}</span>}</div><p className="mt-2 break-all font-mono text-xs text-charcoal">{item.target || "Unspecified target"}</p></div><Link href={item.href} className="text-pebble hover:text-charcoal"><ExternalLink className="size-4" /></Link></div>
          <pre className="scroll-thin mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-code-surface p-3 font-mono text-xs text-bark-grey">{item.preview || "No preview"}</pre>
          <div className="mt-3 flex justify-end gap-2"><Button variant="outline" size="sm" disabled={busy === item.id} onClick={() => void decide(item.id, "deny")}><X className="mr-1 size-3.5" />Deny</Button><Button size="sm" disabled={busy === item.id} onClick={() => void decide(item.id, "allow")}><Check className="mr-1 size-3.5" />Allow once</Button></div>
        </article>)}
      </Section>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Tasks" count={data.issues.length} icon={<AlertTriangle className="size-4" />}>{data.issues.map((item) => <Row key={item.id} href={item.href} title={`${item.identifier} · ${item.title}`} meta={`${item.status.replace("_", " ")} · ${item.priority}`} />)}</Section>
        <Section title="Failed or stale runs" count={data.runs.length} icon={<Clock3 className="size-4" />}>{data.runs.map((item) => <Row key={item.id} href={item.href} title={item.status} meta={item.error || item.id.slice(0, 8)} />)}</Section>
      </div>
    </div>
  </main>;
}

function Section({ title, count, icon, children }: { title: string; count: number; icon: React.ReactNode; children: React.ReactNode }) {
  return <section><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-charcoal">{icon}<span>{title}</span><span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[11px] text-pebble">{count}</span></div><div className="space-y-3">{children}{!count && <p className="rounded-xl border border-dashed border-line p-4 text-xs text-pebble">Nothing needs attention.</p>}</div></section>;
}
function Row({ href, title, meta }: { href: string; title: string; meta: string }) { return <Link href={href} className="block rounded-xl border border-line bg-white/60 p-3 hover:border-line-strong"><p className="truncate text-xs font-medium text-charcoal">{title}</p><p className="mt-1 truncate text-[11px] capitalize text-pebble">{meta}</p></Link>; }
function Risk({ value }: { value: string | null }) { const tone = value === "high" ? "bg-alarm-red/10 text-alarm-red" : "bg-amber-500/10 text-amber-700"; return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tone}`}>{value || "medium"}</span>; }
