// Keyless web tools that run on the user's own machine (their IP), so no
// server-side search product is required. web_fetch works anywhere with
// internet; web_search uses DuckDuckGo best-effort and a Tavily key if provided.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/");
}

/** Strip a full HTML document down to readable text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  s = s
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return title ? `# ${decodeEntities(title)}\n\n${s}` : s;
}

/** Fetch a URL and return readable text (truncated). */
export async function webFetch(url: string): Promise<{ ok: boolean; title: string; text: string }> {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(15000) });
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (!res.ok) return { ok: false, title: "", text: `HTTP ${res.status} fetching ${url}` };
  const body = ct.includes("html") ? htmlToText(raw) : raw;
  const capped = body.length > 30_000 ? body.slice(0, 30_000) + "\n… (truncated)" : body;
  const title = body.startsWith("# ") ? body.slice(2, body.indexOf("\n")) : url;
  return { ok: true, title, text: `Source: ${url}\n\n${capped}` };
}

type Result = { title: string; url: string; snippet: string };

async function tavilySearch(query: string, key: string): Promise<Result[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: 6, include_answer: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function ddgSearch(query: string): Promise<Result[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const results: Result[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 6) {
    let url = decodeEntities(m[1]);
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (url.startsWith("http")) results.push({ title, url, snippet: "" });
  }
  // snippets
  const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0, sm: RegExpExecArray | null;
  while ((sm = sre.exec(html)) && i < results.length) {
    results[i].snippet = decodeEntities(sm[1].replace(/<[^>]+>/g, "")).trim();
    i++;
  }
  return results;
}

/** Search the web. Uses Tavily when a key is configured, else DuckDuckGo. */
export async function webSearch(query: string, tavilyKey?: string): Promise<{ ok: boolean; count: number; text: string }> {
  let results: Result[] = [];
  try {
    results = tavilyKey ? await tavilySearch(query, tavilyKey) : await ddgSearch(query);
  } catch {
    if (tavilyKey) {
      try { results = await ddgSearch(query); } catch { /* both failed */ }
    }
  }
  if (!results.length) {
    return {
      ok: false,
      count: 0,
      text: `No results for "${query}". The search engine may be unreachable from this machine. If you know a likely URL, use web_fetch to read it directly, or add a free Tavily API key in Settings for reliable search.`,
    };
  }
  const text = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
    .join("\n\n");
  return { ok: true, count: results.length, text: `Results for "${query}":\n\n${text}` };
}
