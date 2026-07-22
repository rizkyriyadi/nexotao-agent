"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Icons from "lucide-react";
import { Boxes, Cpu, GitBranch, Users, Zap, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type RoleCard = {
  id: string; name: string; title: string; category: string; summary: string; scope: string;
  capabilities: string[]; recommendedModel: string; modelAvailable: boolean; touchesRepo: boolean;
};
type BlueprintIssue = { title: string; role: string; priority: string };
type BlueprintCard = {
  id: string; name: string; tagline: string; description: string; icon: string;
  roles: string[]; roleCount: number; issueCount: number; issues: BlueprintIssue[];
};

// Prettify a model id for a chip: "claude-opus-4-8" -> "Opus 4.8".
function modelLabel(id: string) {
  if (/^gpt/i.test(id)) return id.toUpperCase().replace("GPT-", "GPT ");
  const m = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  return m.split("-").map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(" ").replace(/(\d) (\d)/, "$1.$2");
}

const categoryStyle: Record<string, string> = {
  engineering: "bg-mist-lavender text-deep-violet", product: "bg-electric-indigo/12 text-electric-indigo",
  design: "bg-amber-50 text-amber-700", growth: "bg-emerald-50 text-emerald-700",
  data: "bg-sky-50 text-sky-700", operations: "bg-charcoal/8 text-bark-grey",
};

function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}

export function MarketplacePage() {
  const router = useRouter();
  const [roles, setRoles] = useState<RoleCard[]>([]);
  const [blueprints, setBlueprints] = useState<BlueprintCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/marketplace", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the marketplace");
      setRoles(data.roles ?? []);
      setBlueprints(data.blueprints ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the marketplace");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const installBlueprint = useCallback(async (bp: BlueprintCard) => {
    setBusy(bp.id);
    try {
      const res = await fetch("/api/marketplace/install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprintId: bp.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Install failed");
      const r = data.result;
      const hired = r.agents.length;
      const reused = r.reusedAgents;
      toast.success(`${bp.name} installed`, {
        description: `${hired} hired${reused ? `, ${reused} reused` : ""} · ${r.issues.length} starter issues created`,
        action: { label: "Open board", onClick: () => router.push("/board") },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Install failed");
    } finally {
      setBusy(null);
    }
  }, [router]);

  const hireRole = useCallback(async (rc: RoleCard) => {
    setBusy(rc.id);
    try {
      const res = await fetch("/api/marketplace/install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleTemplateId: rc.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Hire failed");
      toast.success(`Hired ${data.agent.name}`, {
        description: `${rc.title} · routed to ${modelLabel(rc.recommendedModel)}`,
        action: { label: "View agents", onClick: () => router.push("/agents") },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Hire failed");
    } finally {
      setBusy(null);
    }
  }, [router]);

  const iconMap = Icons as unknown as Record<string, LucideIcon>;
  const blueprintIcon = (name: string): LucideIcon => iconMap[name] ?? Boxes;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-8 pb-5 pt-7">
        <div className="flex items-center gap-2 text-electric-indigo">
          <Icons.Store className="size-5" strokeWidth={1.9} />
          <h1 className="text-[19px] font-semibold text-charcoal">Marketplace</h1>
        </div>
        <p className="mt-1.5 max-w-2xl text-[13.5px] text-bark-grey">
          Hire curated specialists or install a complete team blueprint — a wired team plus a sequenced backlog of starter issues, with a recommended model routed per role.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <Tabs defaultValue="blueprints">
          <TabsList>
            <TabsTrigger value="blueprints">Team blueprints</TabsTrigger>
            <TabsTrigger value="roles">Role templates</TabsTrigger>
          </TabsList>

          <TabsContent value="blueprints" className="mt-5">
            {loading ? (
              <p className="text-[13px] text-pebble">Loading…</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {blueprints.map((bp) => {
                  const Icon = blueprintIcon(bp.icon);
                  const open = expanded === bp.id;
                  return (
                    <div key={bp.id} className="flex flex-col rounded-2xl border border-line bg-warm-bone p-5 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-electric-indigo/12 text-electric-indigo">
                          <Icon className="size-5" strokeWidth={1.9} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold text-charcoal">{bp.name}</h3>
                          <p className="mt-0.5 text-[12.5px] text-bark-grey">{bp.tagline}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-[13px] leading-relaxed text-charcoal/80">{bp.description}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Chip className="bg-mist-lavender text-deep-violet"><Users className="size-3" /> {bp.roleCount} roles</Chip>
                        <Chip className="bg-charcoal/8 text-bark-grey"><GitBranch className="size-3" /> {bp.issueCount} starter issues</Chip>
                      </div>
                      <button
                        onClick={() => setExpanded(open ? null : bp.id)}
                        className="mt-3 self-start text-[12px] font-medium text-electric-indigo hover:underline"
                      >
                        {open ? "Hide backlog" : "Preview backlog"}
                      </button>
                      {open && (
                        <ol className="mt-2 space-y-1.5 rounded-xl bg-canvas/60 p-3">
                          {bp.issues.map((iss, i) => (
                            <li key={i} className="flex items-baseline gap-2 text-[12.5px] text-charcoal">
                              <span className="text-pebble">{i + 1}.</span>
                              <span className="flex-1">{iss.title}</span>
                              <Chip className="bg-charcoal/6 text-bark-grey">{iss.role}</Chip>
                            </li>
                          ))}
                        </ol>
                      )}
                      <div className="mt-4 flex items-center justify-between">
                        <Link href="/agents" className="text-[12px] text-pebble hover:text-charcoal">Review team →</Link>
                        <Button size="sm" disabled={busy === bp.id} onClick={() => void installBlueprint(bp)}>
                          <Zap className="mr-1 size-3.5" />
                          {busy === bp.id ? "Installing…" : "Install team"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="roles" className="mt-5">
            {loading ? (
              <p className="text-[13px] text-pebble">Loading…</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {roles.map((rc) => (
                  <div key={rc.id} className="flex flex-col rounded-2xl border border-line bg-warm-bone p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[14.5px] font-semibold text-charcoal">{rc.title}</h3>
                        <p className="text-[12px] text-pebble">Default name: {rc.name}</p>
                      </div>
                      <Chip className={categoryStyle[rc.category] ?? "bg-charcoal/8 text-bark-grey"}>{rc.category}</Chip>
                    </div>
                    <p className="mt-2.5 flex-1 text-[13px] leading-relaxed text-charcoal/80">{rc.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {rc.capabilities.slice(0, 4).map((cap) => (
                        <Chip key={cap} className="bg-charcoal/6 text-bark-grey">{cap}</Chip>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-[12px]">
                      <Chip className={rc.modelAvailable ? "bg-mist-lavender text-deep-violet" : "bg-amber-50 text-amber-700"} >
                        <Cpu className="size-3" /> {modelLabel(rc.recommendedModel)}
                      </Chip>
                      {!rc.modelAvailable && <span className="text-amber-700">unavailable</span>}
                    </div>
                    <div className="mt-4 flex justify-end">
                      <Button size="sm" variant="secondary" disabled={busy === rc.id} onClick={() => void hireRole(rc)}>
                        {busy === rc.id ? "Hiring…" : "Hire"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
