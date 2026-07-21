"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

/** Optional Tavily key for reliable web search. Web search works keyless via
 * DuckDuckGo out of the box; a key just makes it robust. */
export function SearchKeyRow() {
  const [has, setHas] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((d) => setHas(!!d.hasSearchKey)).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ searchApiKey: value.trim() }) }).catch(() => {});
    setSaving(false);
    setSaved(true);
    setHas(!!value.trim());
    setValue("");
    setTimeout(() => setSaved(false), 1600);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && value.trim() && save()}
        placeholder={has ? "tvly-•••• (set)" : "tvly-… (optional)"}
        className="w-52 rounded-lg border border-line-strong bg-paper-white px-2.5 py-1.5 font-mono text-[12px] text-charcoal outline-none focus:border-charcoal"
      />
      <button
        onClick={save}
        disabled={!value.trim() || saving}
        className="flex items-center gap-1.5 rounded-lg bg-charcoal px-2.5 py-1.5 text-[12px] text-warm-bone disabled:opacity-40"
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : null}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}
