"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Users, Loader2, ArrowRight, GitBranch, Ban, Activity, CircleDashed, Radio,
} from "lucide-react";
import { agentAvatar } from "@/lib/avatars";
import type {
  TeamRoomSnapshot, TeamRoomAgent, HandOff, Blocker, ActiveRun, AgentPresence,
} from "@/lib/team-room";

// ── Live data ────────────────────────────────────────────────────────────────
type RoomResponse = {
  project: { id: string; name: string } | null;
  empty: boolean;
  room: TeamRoomSnapshot;
};

const POLL_MS = 3000;

// Presence → dot colour + label, matching the app's status language.
const PRESENCE: Record<AgentPresence, { dot: string; ring: string; label: string; pulse: boolean }> = {
  working: { dot: "bg-electric-indigo", ring: "ring-electric-indigo/30", label: "Working", pulse: true },
  blocked: { dot: "bg-amber", ring: "ring-amber/30", label: "Blocked", pulse: false },
  queued: { dot: "bg-sapphire-link", ring: "ring-sapphire-link/25", label: "Queued", pulse: false },
  idle: { dot: "bg-line-strong", ring: "ring-line", label: "Idle", pulse: false },
};

export function TeamRoom() {
  const router = useRouter();
  const [room, setRoom] = useState<TeamRoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/team-room", { cache: "no-store" });
        const data: RoomResponse = await res.json();
        if (!alive) return;
        setRoom(data.room);
        setConnected(true);
      } catch {
        if (alive) setConnected(false);
      } finally {
        if (alive) setLoading(false);
      }
    };
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const agentById = useMemo(
    () => new Map((room?.agents ?? []).map((a) => [a.id, a])),
    [room],
  );
  const name = (id: string | null | undefined) => (id ? agentById.get(id)?.name ?? "—" : "Unassigned");
  const open = (issueId: string) => router.push(`/board/${issueId}`);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-pebble">
        <Loader2 className="mr-2 size-4 animate-spin" /> Opening the team room…
      </div>
    );
  }

  const s = room?.stats;
  const agents = room?.agents ?? [];
  const handoffs = room?.handoffs ?? [];
  const blockers = room?.blockers ?? [];
  const runs = room?.runs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <div className="flex size-9 items-center justify-center rounded-2xl bg-electric-indigo/12 text-electric-indigo">
          <Users className="size-[18px]" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-charcoal">Live Team Room</h1>
          <p className="truncate text-[12.5px] text-pebble">
            Agents working together in real time — active work, hand-offs, and blockers.
          </p>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
            connected
              ? "border-lichen-green/30 bg-lichen-green/10 text-lichen-green"
              : "border-line bg-muted text-pebble"
          }`}
          title={connected ? "Live — refreshing every 3s" : "Reconnecting…"}
        >
          <Radio className={`size-3 ${connected ? "nx-pulse" : ""}`} />
          {connected ? "Live" : "Offline"}
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
        <Stat icon={<Activity className="size-3.5" />} label="Working now" value={s?.working ?? 0} accent />
        <Stat icon={<GitBranch className="size-3.5" />} label="Active runs" value={s?.activeRuns ?? 0} />
        <Stat icon={<ArrowRight className="size-3.5" />} label="Hand-offs" value={s?.handoffs ?? 0} />
        <Stat icon={<Ban className="size-3.5" />} label="Blockers" value={s?.blockers ?? 0} warn={(s?.blockers ?? 0) > 0} />
      </div>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_360px]">
        {/* Agent roster */}
        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <SectionTitle icon={<Users className="size-3.5" />} title="Agents" count={agents.length} />
          {agents.length === 0 ? (
            <Empty>No agents in this project yet.</Empty>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {agents.map((a, i) => (
                <AgentCard key={a.id} agent={a} index={i} onOpen={open} />
              ))}
            </div>
          )}

          {runs.length > 0 && (
            <div className="mt-7">
              <SectionTitle icon={<GitBranch className="size-3.5" />} title="Active runs" count={runs.length} />
              <div className="mt-3 flex flex-col gap-2">
                {runs.map((r) => (
                  <RunRow key={r.rootId} run={r} agentById={agentById} onOpen={open} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Live rail: hand-offs + blockers */}
        <div className="min-h-0 overflow-y-auto border-t border-line px-5 py-5 lg:border-l lg:border-t-0">
          <SectionTitle icon={<ArrowRight className="size-3.5" />} title="Hand-offs" count={handoffs.length} />
          {handoffs.length === 0 ? (
            <Empty>No hand-offs in flight.</Empty>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {handoffs.slice(0, 40).map((h) => (
                <HandOffRow key={h.id} handoff={h} name={name} onOpen={open} />
              ))}
            </ul>
          )}

          <div className="mt-7">
            <SectionTitle icon={<Ban className="size-3.5" />} title="Blockers" count={blockers.length} warn={blockers.length > 0} />
            {blockers.length === 0 ? (
              <Empty>Nothing blocked. 🎉</Empty>
            ) : (
              <ul className="mt-3 flex flex-col gap-1.5">
                {blockers.slice(0, 40).map((b) => (
                  <BlockerRow key={b.issueId} blocker={b} name={name} onOpen={open} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Stat({ icon, label, value, accent, warn }: { icon: React.ReactNode; label: string; value: number; accent?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 bg-warm-bone px-6 py-3">
      <span className={`flex size-7 items-center justify-center rounded-lg ${accent ? "bg-electric-indigo/12 text-electric-indigo" : warn ? "bg-amber/12 text-amber" : "bg-black/[0.04] text-pebble"}`}>
        {icon}
      </span>
      <div>
        <div className={`text-[17px] font-semibold leading-none ${warn && value > 0 ? "text-amber" : "text-charcoal"}`}>{value}</div>
        <div className="mt-0.5 text-[11px] text-pebble">{label}</div>
      </div>
    </div>
  );
}

function SectionTitle({ icon, title, count, warn }: { icon: React.ReactNode; title: string; count: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-pebble">
      <span className={warn && count > 0 ? "text-amber" : ""}>{icon}</span>
      <span>{title}</span>
      <span className="rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] font-semibold text-bark-grey">{count}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-4 text-[12.5px] text-pebble">
      <CircleDashed className="size-3.5" /> {children}
    </div>
  );
}

function AgentCard({ agent, index, onOpen }: { agent: TeamRoomAgent; index: number; onOpen: (id: string) => void }) {
  const p = PRESENCE[agent.presence];
  const clickable = Boolean(agent.current);
  return (
    <div
      onClick={() => agent.current && onOpen(agent.current.issueId)}
      className={`group relative flex flex-col gap-2 rounded-2xl border bg-paper-white p-3 transition-colors ${
        clickable ? "cursor-pointer border-line hover:border-line-strong" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="relative shrink-0">
          <img src={agentAvatar(agent.avatar, index)} alt={agent.name} className="size-9 rounded-xl object-cover" />
          <span className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-paper-white ${p.dot} ${p.pulse ? "nx-pulse" : ""}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium text-charcoal">{agent.name}</span>
            {agent.role === "lead" && <span className="rounded bg-electric-indigo/10 px-1.5 py-px text-[9.5px] font-semibold uppercase text-electric-indigo">Lead</span>}
          </div>
          <span className="text-[11px] text-pebble">{p.label}</span>
        </div>
      </div>

      {agent.current ? (
        <div className="rounded-xl bg-black/[0.02] px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-electric-indigo">
            <Loader2 className="size-3 animate-spin" /> on task
          </div>
          <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-charcoal">{agent.current.title}</div>
          {agent.current.rootTitle !== agent.current.title && (
            <div className="mt-1 truncate text-[11px] text-pebble">in “{agent.current.rootTitle}”</div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-0.5 text-[11.5px] text-pebble">
          {agent.blocked > 0 && <span className="text-amber">{agent.blocked} blocked</span>}
          {agent.queued > 0 && <span>{agent.queued} queued</span>}
          {agent.blocked === 0 && agent.queued === 0 && <span>Available</span>}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, agentById, onOpen }: { run: ActiveRun; agentById: Map<string, TeamRoomAgent>; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(run.rootId)}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-paper-white px-3 py-2.5 text-left transition-colors hover:border-line-strong"
    >
      <span className={`size-[7px] shrink-0 rounded-full ${run.runningCount > 0 ? "bg-electric-indigo nx-pulse" : "bg-line-strong"}`} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-charcoal">{run.title}</span>
      <div className="flex shrink-0 -space-x-1.5">
        {run.agentIds.slice(0, 4).map((id) => {
          const a = agentById.get(id);
          if (!a) return null;
          return <img key={id} src={agentAvatar(a.avatar)} alt={a.name} title={a.name} className="size-5 rounded-md object-cover ring-2 ring-paper-white" />;
        })}
      </div>
      <span className="shrink-0 font-mono text-[10.5px] text-pebble">
        {run.runningCount > 0 ? `${run.runningCount} working` : `${run.taskCount} task${run.taskCount === 1 ? "" : "s"}`}
      </span>
    </button>
  );
}

function HandOffRow({ handoff, name, onOpen }: { handoff: HandOff; name: (id: string | null | undefined) => string; onOpen: (id: string) => void }) {
  const delegate = handoff.kind === "delegate";
  return (
    <li>
      <button
        onClick={() => onOpen(handoff.issueId)}
        className="flex w-full items-start gap-2 rounded-xl border border-line bg-paper-white px-2.5 py-2 text-left transition-colors hover:border-line-strong"
      >
        <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md ${delegate ? "bg-electric-indigo/10 text-electric-indigo" : "bg-amber/12 text-amber"}`}>
          {delegate ? <ArrowRight className="size-3" /> : <Ban className="size-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[11.5px] text-bark-grey">
            <span className="font-medium text-charcoal">{name(handoff.fromAgentId)}</span>
            <ArrowRight className="size-3 text-pebble" />
            <span className="font-medium text-charcoal">{name(handoff.toAgentId)}</span>
          </div>
          <div className="mt-0.5 line-clamp-1 text-[12px] text-charcoal">{handoff.title}</div>
          {!delegate && handoff.onTitle && (
            <div className="mt-0.5 line-clamp-1 text-[11px] text-pebble">waiting on “{handoff.onTitle}”</div>
          )}
        </div>
      </button>
    </li>
  );
}

function BlockerRow({ blocker, name, onOpen }: { blocker: Blocker; name: (id: string | null | undefined) => string; onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        onClick={() => onOpen(blocker.issueId)}
        className="flex w-full items-start gap-2 rounded-xl border border-amber/25 bg-amber/[0.04] px-2.5 py-2 text-left transition-colors hover:border-amber/50"
      >
        <Ban className="mt-0.5 size-3.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-[12.5px] text-charcoal">{blocker.title}</div>
          <div className="mt-0.5 text-[11px] text-pebble">
            {name(blocker.assigneeAgentId)}
            {blocker.waitingOn.length > 0
              ? ` · waiting on ${blocker.waitingOn.length} task${blocker.waitingOn.length === 1 ? "" : "s"}`
              : " · blocked"}
          </div>
        </div>
      </button>
    </li>
  );
}
