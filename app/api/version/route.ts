import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

let cache: { at: number; latest: string } | null = null;

function gt(a: string, b: string) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

async function currentVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Is a newer nexotao published on npm? Cached for an hour. Data lives in
 * ~/.nexotao (outside the package) so updating never touches it. */
export async function GET() {
  const current = await currentVersion();
  let latest = current;
  try {
    if (cache && Date.now() - cache.at < 60 * 60_000) {
      latest = cache.latest;
    } else {
      const r = await fetch("https://registry.npmjs.org/nexotao/latest", { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        latest = (await r.json())?.version ?? current;
        cache = { at: Date.now(), latest };
      }
    }
  } catch {
    /* offline or registry down — just report no update */
  }
  return NextResponse.json({ current, latest, updateAvailable: gt(latest, current) });
}
