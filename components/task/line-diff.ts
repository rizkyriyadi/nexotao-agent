/** Minimal line diff for the transcript's edit/write previews.
 *
 *  Deliberately dependency-free: the transcript only ever diffs the `old_str` /
 *  `new_str` a single `edit_file` call carried, so an O(n·m) LCS over a few
 *  hundred lines is cheaper than pulling in a diff library. Inputs are capped so
 *  a pathological paste can never lock the render thread. */

export type DiffLine = { type: "add" | "del" | "ctx"; text: string; oldNo: number | null; newNo: number | null };

const MAX_LINES = 400;

function split(value: string): string[] {
  const lines = value.length ? value.split("\n") : [];
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
}

/** Longest-common-subsequence line diff. `context` trims unchanged runs down to
 *  a few lines around each hunk so a large edit stays skimmable. */
export function lineDiff(oldText: string, newText: string, context = 2): DiffLine[] {
  const a = split(oldText);
  const b = split(newText);

  // lcs[i][j] = length of the LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null }); i++; }
    else { out.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 }); j++; }
  }
  while (i < a.length) { out.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null }); i++; }
  while (j < b.length) { out.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 }); j++; }

  return trimContext(out, context);
}

/** Drop unchanged lines that sit further than `context` from any change. */
function trimContext(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.type === "ctx") return;
    for (let k = index - context; k <= index + context; k++) if (k >= 0 && k < lines.length) keep.add(k);
  });
  if (keep.size === 0) return lines.slice(0, context * 2);
  return lines.filter((_, index) => keep.has(index));
}

export function diffStat(lines: DiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}
