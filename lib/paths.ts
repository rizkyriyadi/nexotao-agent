import os from "os";
import path from "path";

export function expandHome(p: string): string {
  if (!p) return process.cwd();
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** Resolve `p` relative to `root`, refusing anything that escapes the project. */
export function resolveWithin(root: string, p: string): string {
  const nroot = path.resolve(root);
  const abs = path.resolve(nroot, p);
  if (abs !== nroot && !abs.startsWith(nroot + path.sep)) {
    throw new Error(`Path escapes the project workspace: ${p}`);
  }
  return abs;
}

export function rel(root: string, abs: string): string {
  const r = path.relative(path.resolve(root), abs);
  return r || ".";
}
