"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  KeyRound, FolderOpen, Sparkles, Check, ArrowRight, ArrowLeft, Folder, Lock,
  Loader2, Cpu, ChevronUp,
} from "lucide-react";
import { LEAD_PP } from "@/lib/avatars";
import { Wordmark } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STEPS = ["Connect", "Model", "Project"];

type Model = { id: string; name: string; ctx: number | null; provider?: "anthropic" | "openai" };

export function OnboardingFlow() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);

  const [choice, setChoice] = useState<"open" | "fresh" | null>(null);
  const [name, setName] = useState("my-app");
  const [browsePath, setBrowsePath] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  const [saving, setSaving] = useState(false);

  const projectName = choice === "fresh" ? name : browsePath.split("/").filter(Boolean).pop() || "project";
  const projectPath = choice === "fresh" ? `~/code/${name}` : browsePath;

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        const list: Model[] = d.models ?? [];
        setModels(list);
        setModel((m) => m || list.find((x) => x.id === "claude-opus-4-8")?.id || list[0]?.id || "");
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
    // prefetch the home directory so the folder browser is ready
    browse("");
  }, []);

  async function browse(p: string) {
    setBrowseLoading(true);
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      setBrowsePath(d.path);
      setParent(d.parent);
      setDirs(d.dirs ?? []);
    } catch {
      /* ignore */
    } finally {
      setBrowseLoading(false);
    }
  }

  async function finish() {
    setSaving(true);
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          model,
          onboarded: true,
          project: { name: projectName, path: projectPath, mode: "single", agents: [] },
        }),
      });
      router.push("/");
    } catch {
      toast.error("Couldn't save config.");
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[560px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <Wordmark />
          <h1 className="mt-7 text-[26px] font-semibold leading-tight tracking-[-0.01em] text-charcoal">
            A coding agent, on your machine.
          </h1>
          <p className="mt-2.5 max-w-[430px] text-[14.5px] leading-relaxed text-bark-grey">
            Runs locally on your files, powered by your Nexotao balance. Every project gets its own isolated workspace.
          </p>
        </div>

        {/* stepper */}
        <div className="mb-6 flex items-center justify-center gap-3">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <div key={s} className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "flex size-[22px] items-center justify-center rounded-full font-mono text-[11px] transition-colors",
                    active && "bg-charcoal text-warm-bone",
                    done && "bg-electric-indigo text-white",
                    !active && !done && "border border-line-strong text-pebble",
                  )}>
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn("text-[12.5px]", active || done ? "text-charcoal" : "text-pebble")}>{s}</span>
                </div>
                {i < STEPS.length - 1 && <span className="h-px w-4 bg-line-strong" />}
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl border border-line bg-paper-white p-6 shadow-float">
          {/* Step 0 — key */}
          {step === 0 && (
            <>
              <div className="mb-1 flex items-center gap-2">
                <KeyRound className="size-[18px] text-charcoal" />
                <h2 className="text-[15px] font-medium text-charcoal">Connect your Nexotao key</h2>
              </div>
              <p className="mb-4 text-[13.5px] leading-relaxed text-bark-grey">
                One balance for every model. Create a key at{" "}
                <span className="font-mono text-charcoal">nexotao.com</span> → dashboard.
              </p>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-nexo-…"
                className="font-mono"
              />
              <div className="mt-6 flex justify-end">
                <Button size="sm" onClick={() => setStep(1)} className={cn(!apiKey.trim() && "pointer-events-none opacity-50")}>
                  Continue <ArrowRight className="size-4" />
                </Button>
              </div>
            </>
          )}

          {/* Step 1 — model */}
          {step === 1 && (
            <>
              <div className="mb-1 flex items-center gap-2">
                <Cpu className="size-[18px] text-charcoal" />
                <h2 className="text-[15px] font-medium text-charcoal">Pick a model</h2>
              </div>
              <p className="mb-4 text-[13.5px] leading-relaxed text-bark-grey">
                Claude and GPT (5.6 series) run on your Nexotao balance — pick your default.
              </p>
              {modelsLoading ? (
                <div className="flex items-center gap-2 py-6 text-[13px] text-pebble">
                  <Loader2 className="size-4 animate-spin" /> Loading models…
                </div>
              ) : (
                <div className="space-y-1.5">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setModel(m.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                        model === m.id ? "border-electric-indigo bg-electric-indigo/[0.05]" : "border-line hover:border-line-strong",
                      )}
                    >
                      <Sparkles className="size-4 text-electric-indigo" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-charcoal">{m.name}</span>
                          {m.provider && (
                            <span className="rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-pebble">
                              {m.provider === "openai" ? "GPT" : "Claude"}
                            </span>
                          )}
                        </span>
                        <span className="block font-mono text-[11px] text-pebble">
                          {m.id}{m.ctx ? ` · ${Math.round(m.ctx / 1000)}k ctx` : ""}
                        </span>
                      </span>
                      {model === m.id && <Check className="size-4 text-electric-indigo" />}
                    </button>
                  ))}
                  {!models.length && <p className="py-4 text-[13px] text-pebble">Couldn't load models — check your connection.</p>}
                </div>
              )}
              <div className="mt-6 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep(0)}><ArrowLeft className="size-4" /> Back</Button>
                <Button size="sm" onClick={() => setStep(2)} className={cn(!model && "pointer-events-none opacity-50")}>
                  Continue <ArrowRight className="size-4" />
                </Button>
              </div>
            </>
          )}

          {/* Step 2 — project */}
          {step === 2 && (
            <>
              <div className="mb-1 flex items-center gap-2">
                <Folder className="size-[18px] text-charcoal" />
                <h2 className="text-[15px] font-medium text-charcoal">Add your first project</h2>
              </div>
              <p className="mb-4 flex items-start gap-1.5 text-[13px] leading-relaxed text-bark-grey">
                <Lock className="mt-0.5 size-3.5 shrink-0 text-pebble" />
                Each project runs in its own isolated workspace — the agent never touches another project's files.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => { setChoice("open"); if (!browsePath) browse(""); }} className={cn("rounded-2xl border p-4 text-left transition-colors", choice === "open" ? "border-electric-indigo bg-electric-indigo/[0.05]" : "border-line hover:border-line-strong")}>
                  <FolderOpen className="size-5 text-electric-indigo" />
                  <p className="mt-2.5 text-[14px] font-medium text-charcoal">Open a folder</p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-bark-grey">Point at an existing repo.</p>
                </button>
                <button onClick={() => setChoice("fresh")} className={cn("rounded-2xl border p-4 text-left transition-colors", choice === "fresh" ? "border-electric-indigo bg-electric-indigo/[0.05]" : "border-line hover:border-line-strong")}>
                  <Sparkles className="size-5 text-electric-indigo" />
                  <p className="mt-2.5 text-[14px] font-medium text-charcoal">Start fresh</p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-bark-grey">New empty project.</p>
                </button>
              </div>
              {choice === "open" && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      onClick={() => parent && browse(parent)}
                      disabled={!parent}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong text-pebble transition-colors hover:text-charcoal disabled:opacity-40"
                      title="Up one level"
                    >
                      <ChevronUp className="size-4" />
                    </button>
                    <input
                      value={browsePath}
                      onChange={(e) => setBrowsePath(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); browse(browsePath); } }}
                      placeholder="/path/to/your/project"
                      spellCheck={false}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 font-mono text-[12px] text-charcoal outline-none transition-[box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/40"
                    />
                    <Button variant="outline" size="sm" onClick={() => browse(browsePath)}>Go</Button>
                  </div>
                  <div className="scroll-thin max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
                    {browseLoading ? (
                      <div className="flex items-center gap-2 px-2 py-3 text-[13px] text-pebble"><Loader2 className="size-4 animate-spin" /> reading…</div>
                    ) : dirs.length ? (
                      dirs.map((dir) => (
                        <button
                          key={dir.path}
                          onClick={() => browse(dir.path)}
                          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left font-mono text-[12.5px] text-bark-grey transition-colors hover:bg-black/[0.03] hover:text-charcoal"
                        >
                          <Folder className="size-4 shrink-0 text-pebble" /> <span className="truncate">{dir.name}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-2.5 py-3 text-[13px] text-pebble">No sub-folders — open this folder, or paste a path above.</p>
                    )}
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-[12px] text-bark-grey">
                    <Check className="size-3.5 shrink-0 text-lichen-green" />
                    Open <span className="min-w-0 truncate font-mono text-charcoal">{browsePath || "…"}</span>
                  </p>
                </div>
              )}
              {choice === "fresh" && (
                <div className="mt-4">
                  <p className="label mb-1.5">Project name</p>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
                  <p className="mt-2 font-mono text-[12px] text-pebble">~/code/{name || "…"}</p>
                </div>
              )}
              <p className="mt-4 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-bark-grey">
                <img src={LEAD_PP} alt="Hutao" className="size-7 shrink-0 rounded-lg object-cover" />
                <span>
                  Your workspace starts with one lead agent, <span className="font-medium text-charcoal">Hutao</span>, who
                  handles every request end-to-end. You can add specialists later from the Agents page.
                </span>
              </p>
              <div className="mt-6 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep(1)}><ArrowLeft className="size-4" /> Back</Button>
                <Button
                  size="sm"
                  onClick={finish}
                  className={cn((!choice || (choice === "open" && !browsePath) || saving) && "pointer-events-none opacity-50")}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <>Open workspace <ArrowRight className="size-4" /></>}
                </Button>
              </div>
            </>
          )}
        </div>

        <p className="mt-4 text-center font-mono text-[11px] text-pebble">single-user · local · open source · no telemetry</p>
      </div>
    </div>
  );
}
