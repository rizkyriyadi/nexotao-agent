import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Switch } from "@/components/ui/switch";
import { IconKeyStub } from "@/components/settings-icons";
import { SearchKeyRow } from "@/components/settings/SearchKeyRow";
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
              <span className="font-mono text-[13px] text-charcoal">Opus 4.8</span>
            </Row>
            <Row label="Effort" hint="Higher = deeper reasoning. xhigh is best for coding.">
              <div className="flex gap-1">
                {["low", "medium", "high", "xhigh", "max"].map((e) => (
                  <span key={e} className={`rounded-md px-2 py-1 font-mono text-[11px] ${e === "xhigh" ? "bg-charcoal text-warm-bone" : "text-pebble"}`}>
                    {e}
                  </span>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="Anthropic key">
            <Row label="API key" hint="Read from ANTHROPIC_API_KEY or your ant auth profile.">
              <span className="inline-flex items-center gap-2 font-mono text-[13px] text-charcoal">
                <IconKeyStub className="size-4 text-pebble" /> sk-ant-•••• 4f2a
              </span>
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

          <Section title="Safety">
            <Row label="Ask before commands & edits" hint="The approval prompt is the safety model. Recommended.">
              <Switch defaultChecked />
            </Row>
            <Row label="Safe mode — Docker sandbox" hint="Run tools in a throwaway container. Slower; for untrusted repos.">
              <Switch />
            </Row>
            <Row label="Egress allow-list" hint="Domains the sandbox may reach. Deny-all by default.">
              <span className="font-mono text-[12px] text-bark-grey">npmjs.org, github.com</span>
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
