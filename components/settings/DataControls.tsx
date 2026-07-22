"use client";

import { useEffect, useState } from "react";
import { Check, Download, Loader2, Trash2 } from "lucide-react";

type Retention = { runEventDays: number | null; auditDays: number | null };
type OutcomeReport = { deleted: Record<string, number>; retained: Record<string, number>; integrityNote: string };

const daysValue = (value: number | null) => (value && value > 0 ? String(value) : "");

/** Local data controls: redacted log/event retention window, a full redacted
 * export, and a confirmed delete that reports what was removed and what the
 * audit trail retained. Everything runs against the local database. */
export function DataControls() {
  const [retention, setRetention] = useState<Retention>({ runEventDays: null, auditDays: null });
  const [savingRetention, setSavingRetention] = useState(false);
  const [savedRetention, setSavedRetention] = useState(false);
  const [pruneReport, setPruneReport] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [outcome, setOutcome] = useState<OutcomeReport | null>(null);
  const [busy, setBusy] = useState<"prune" | "delete" | null>(null);
  const [hasProject, setHasProject] = useState(true);
  const [telemetry, setTelemetry] = useState(false);
  const [savingTelemetry, setSavingTelemetry] = useState(false);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((d) => {
      if (d.retention) setRetention({ runEventDays: d.retention.runEventDays ?? null, auditDays: d.retention.auditDays ?? null });
      setHasProject(!!d.project);
      setTelemetry(d.telemetry === true);
    }).catch(() => {});
  }, []);

  async function toggleTelemetry(next: boolean) {
    setTelemetry(next);
    setSavingTelemetry(true);
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telemetry: next }) }).catch(() => setTelemetry(!next));
    setSavingTelemetry(false);
  }

  async function saveRetention(next: Retention) {
    setSavingRetention(true);
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retention: next }) }).catch(() => {});
    setSavingRetention(false);
    setSavedRetention(true);
    setTimeout(() => setSavedRetention(false), 1600);
  }

  async function prune() {
    setBusy("prune");
    setPruneReport(null);
    const res = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retention" }) }).then((r) => r.json()).catch(() => null);
    setBusy(null);
    if (res?.outcome) setPruneReport(`Removed ${res.outcome.removedRunEvents} run events, ${res.outcome.removedActivity} audit rows (${res.outcome.keptForIntegrity} kept for integrity).`);
  }

  async function remove() {
    if (confirmText !== "DELETE") return;
    setBusy("delete");
    const res = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", confirm: true }) }).then((r) => r.json()).catch(() => null);
    setBusy(null);
    setConfirmText("");
    if (res?.outcome) { setOutcome(res.outcome); setHasProject(false); }
  }

  const numberInput = "w-20 rounded-lg border border-line-strong bg-paper-white px-2.5 py-1.5 font-mono text-[12px] text-charcoal outline-none focus:border-charcoal";

  return (
    <div className="space-y-4 py-4">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[14px] text-charcoal">Retention window</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-bark-grey">Days to keep redacted run events and audit activity. Blank = keep forever.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input type="number" min={0} placeholder="events" aria-label="Run event retention days" value={daysValue(retention.runEventDays)}
            onChange={(e) => setRetention((r) => ({ ...r, runEventDays: e.target.value ? Number(e.target.value) : null }))}
            onBlur={() => saveRetention(retention)} className={numberInput} />
          <input type="number" min={0} placeholder="audit" aria-label="Audit retention days" value={daysValue(retention.auditDays)}
            onChange={(e) => setRetention((r) => ({ ...r, auditDays: e.target.value ? Number(e.target.value) : null }))}
            onBlur={() => saveRetention(retention)} className={numberInput} />
          {savingRetention ? <Loader2 className="size-4 animate-spin text-pebble" /> : savedRetention ? <Check className="size-4 text-lichen-green" /> : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-6">
        <p className="text-[13px] text-bark-grey">{pruneReport ?? "Apply the retention window now."}</p>
        <button onClick={prune} disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] text-charcoal disabled:opacity-40">
          {busy === "prune" ? <Loader2 className="size-3.5 animate-spin" /> : null} Prune now
        </button>
      </div>

      <div className="flex items-center justify-between gap-6 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-[14px] text-charcoal">Crash &amp; performance telemetry</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-bark-grey">Off by default. When on, sends only redacted error messages and timing counters — never prompts, code, keys, or file contents. See the telemetry doc.</p>
        </div>
        <button role="switch" aria-checked={telemetry} aria-label="Toggle crash and performance telemetry"
          onClick={() => toggleTelemetry(!telemetry)} disabled={savingTelemetry}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${telemetry ? "bg-lichen-green" : "bg-line-strong"} disabled:opacity-40`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-warm-bone transition-transform ${telemetry ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-6 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-[14px] text-charcoal">Export project data</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-bark-grey">Download a redacted JSON copy of everything for the active project.</p>
        </div>
        <a href="/api/data" download
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] text-charcoal">
          <Download className="size-3.5" /> Export
        </a>
      </div>

      <div className="flex items-center justify-between gap-6 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-[14px] text-charcoal">Delete project data</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-bark-grey">Removes the active project and its records. Audit activity is retained. Type DELETE to confirm.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" aria-label="Type DELETE to confirm"
            className="w-24 rounded-lg border border-line-strong bg-paper-white px-2.5 py-1.5 font-mono text-[12px] text-charcoal outline-none focus:border-charcoal" />
          <button onClick={remove} disabled={confirmText !== "DELETE" || busy !== null || !hasProject}
            className="flex items-center gap-1.5 rounded-lg bg-alarm-red px-2.5 py-1.5 text-[12px] text-warm-bone disabled:opacity-40">
            {busy === "delete" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Delete
          </button>
        </div>
      </div>

      {outcome && (
        <div className="rounded-xl border border-line bg-warm-bone/40 p-3 text-[12px] text-bark-grey">
          <p className="text-charcoal">Deleted {Object.values(outcome.deleted).reduce((a, b) => a + b, 0)} records across {Object.keys(outcome.deleted).length} tables.</p>
          <p className="mt-1">Retained {outcome.retained.activityLog} audit entries. {outcome.integrityNote}</p>
        </div>
      )}
    </div>
  );
}
