import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { SearchKeyRow } from "@/components/settings/SearchKeyRow";
import { ModeRow } from "@/components/settings/ModeRow";
import { ReviewModeRow } from "@/components/settings/ReviewModeRow";
import { ModelRow } from "@/components/settings/ModelRow";
import { ApiKeyRow } from "@/components/settings/ApiKeyRow";
import { CodeIndexRow } from "@/components/settings/CodeIndexRow";
import { DataControls } from "@/components/settings/DataControls";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <p className="label mb-2.5">{title}</p>
      <div className="rounded-2xl border border-line bg-paper-white px-5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-[14px] text-charcoal">{label}</p>
        {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-bark-grey">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  return (
    <AppShell active="settings">
      <div className="scroll-thin h-full w-full overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-9 py-9">
          <p className="label">Preferences</p>
          <h1 className="mt-1 text-[32px] font-semibold tracking-[-0.02em] text-charcoal">Settings</h1>
          <p className="mt-1.5 text-[14px] text-bark-grey">Runs locally. Your key never leaves this machine.</p>

          <Section title="Model">
            <Row label="Model" hint="Default for new sessions.">
              <ModelRow />
            </Row>
          </Section>

          <Section title="Nexotao key">
            <Row label="API key" hint="One balance for every model. Stored locally in ~/.nexotao.">
              <ApiKeyRow />
            </Row>
          </Section>

          <Section title="Web">
            <Row label="Web search & fetch" hint="Agents can search the web and read URLs. Works out of the box (DuckDuckGo).">
              <span className="font-mono text-[12px] text-lichen-green">enabled</span>
            </Row>
            <Row label="Tavily API key" hint="Optional — a free tavily.com key makes web search reliable. Stored locally.">
              <SearchKeyRow />
            </Row>
          </Section>

          {/* The agent's first instruction is to consult its graph tools before
              reading files. Without the code index those tools answer from work
              history alone, so this row is the difference between an agent that
              knows the codebase and one that has to rediscover it every run. */}
          <Section title="Code index">
            <Row label="Code index" hint="Lets the agent's graph tools answer from your code, not just its work history. ~40 MB download, about a minute.">
              <CodeIndexRow />
            </Row>
          </Section>

          {/* No approval toggle here. These are agents: Agent mode runs on its
              own, and the way to hold one back is to run it in Ask or Plan mode,
              which is a per-run choice in the composer rather than a global
              setting. The three switches that used to sit here were wired to
              nothing at all — no state, no config key, no reader — so they
              promised a Docker sandbox and an egress allow-list that do not
              exist, and an approval prompt that Agent mode never showed. */}
          <Section title="Execution">
            <Row label="Default mode" hint="Agent runs on its own. Switch a run to Plan or Ask in the composer to keep it read-only.">
              <ModeRow />
            </Row>
            <Row label="After a run" hint="Review: the task waits for you to look at what changed. Auto: the task finishes on its own — the diff and Revert are still there, they just stop waiting.">
              <ReviewModeRow />
            </Row>
          </Section>

          <Section title="Local data">
            <DataControls />
          </Section>

          <div className="mt-8 flex items-center gap-2 text-[13px] text-bark-grey">
            <span className="size-[6px] rounded-full bg-line-strong" />
            Single-user, local. No account, no telemetry. Open source.
            <Link href="/onboarding" className="ml-auto font-mono text-[12px] text-sapphire-link hover:underline">
              Re-run onboarding →
            </Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
