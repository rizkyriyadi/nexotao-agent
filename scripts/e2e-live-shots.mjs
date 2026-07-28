// Drives the *live* HTTPS site with a real browser and captures the two things
// the fix was about: a run that closes with a report the user can read, and
// sub-tasks the lead handed off rendered as links you can follow.
//
// Usage: node scripts/e2e-live-shots.mjs <rootIssueId>
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowser } from "./e2e/browser.mjs";

const ORIGIN = process.env.NEXOTAO_ORIGIN ?? "https://human.nexotao.com";
const SHOTS = join(process.cwd(), "e2e-artifacts", "live");
const rootId = process.argv[2];
if (!rootId) { console.error("usage: node scripts/e2e-live-shots.mjs <rootIssueId>"); process.exit(2); }

const token = readFileSync(join(process.cwd(), ".env.runtime"), "utf8")
  .split("\n").find((l) => l.startsWith("NEXOTAO_SESSION_TOKEN="))?.slice("NEXOTAO_SESSION_TOKEN=".length).trim();
if (!token) { console.error("no NEXOTAO_SESSION_TOKEN in .env.runtime"); process.exit(2); }

const executablePath = resolveBrowser();
if (!executablePath) { console.error("no chrome; run: npx @puppeteer/browsers install chrome-headless-shell@stable"); process.exit(2); }

mkdirSync(SHOTS, { recursive: true });
let failures = 0;
// Distinct from a failure: the run simply has not finished, so the closing-report
// checks have nothing to assert against yet. Reported as its own exit code so a
// caller can retry rather than treat it as a regression.
let unsettled = false;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const browser = await puppeteer.launch({
  executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1600, deviceScaleFactor: 2 });

  // The session_token query sets the httpOnly cookie for the rest of the run.
  await page.goto(`${ORIGIN}/board/${rootId}?session_token=${token}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 4000));

  const shot = async (name) => {
    const file = join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  const text = () => page.evaluate(() => document.body.innerText);

  const body = await text();
  check(!/Authentication required/i.test(body), "authenticated page renders");
  // A wrong id renders an empty shell, and every later check then fails for a
  // reason that has nothing to do with what is being tested. Refs repeat across
  // projects (each numbers its own NX-1…), so passing the id of a task from the
  // wrong project is easy to do and reads exactly like a product bug.
  // Throwing rather than exiting here so the `finally` below still closes the
  // browser instead of leaving a headless chrome behind.
  if (/This task doesn't exist/i.test(body)) {
    throw new Error(`no task ${rootId} on ${ORIGIN} — check you took the id from the right project`);
  }

  // These checks describe a *settled* run that delegated. Pointed at a task that
  // is still going, every one of them fails for the same uninteresting reason —
  // which reads as four separate defects. Say so once and stop instead.
  const stillRunning = await page.evaluate(() => {
    const header = document.querySelector("header")?.innerText ?? document.body.innerText.slice(0, 400);
    return /\b(running|queued)\b/i.test(header);
  });
  if (stillRunning) {
    console.log(`\nshot: ${await shot("01-parent-run")}`);
    console.log("\nthis task has not settled yet — the closing-report checks need a finished run");
    unsettled = true;
  }

  // Everything below describes a finished run. Running them anyway against a
  // live task turns one "not done yet" into four failures that read like
  // product defects, so skip to the board shot instead.
  if (!unsettled) {
    // 1. The closing report. Before the fix a finished run just stopped mid-thought
    //    and there was no such block at all. Matched on the block itself rather
    //    than its label: the heading is uppercased in CSS, so innerText reads
    //    "RESULT" and a `/\bResult\b/` search misses it entirely.
    const report = await page.evaluate(() => {
      const block = Array.from(document.querySelectorAll("div")).find((el) =>
        /^RESULT\b/i.test(el.innerText.trim()) && el.querySelector("svg.lucide-flag"));
      return block ? block.innerText.trim().slice(0, 120) : "";
    });
    check(Boolean(report), "the run closes with a Result block", report || "missing");

    // 2. The hand-off panel in the transcript, and the sub-task list on the issue.
    // Case-insensitive: these headings are uppercased in CSS, so innerText reads
    // "HANDED OFF" no matter what the source says.
    // Only a run that actually handed work off owes us a hand-off panel. A leaf
    // worker task delegates nothing, so demanding one there fails a page that is
    // behaving correctly — the same reason the link check below is conditional.
    // Whether *this* task delegated is read from the board's own sub-task list.
    const handoff = /handed off/i.test(body);
    const subtasks = /sub-tasks/i.test(body);
    const delegated = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href^="/board/"]')).some((a) => /\bNX-\d+\b/.test(a.innerText)));
    if (delegated) {
      check(handoff || subtasks, "delegated work is surfaced",
        `transcript:${handoff ? "yes" : "no"} panel:${subtasks ? "yes" : "no"}`);
    } else {
      console.log("SKIP  hand-off panel — this task delegated nothing");
    }

    // 3. Those sub-tasks must be reachable — a ref the user can click through to.
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href^="/board/"]')).map((a) => ({ href: a.getAttribute("href"), text: a.innerText.trim() })));
    const childLinks = links.filter((l) => l.href !== `/board/${rootId}`);
    // A leaf task legitimately has none, so only a task that says it handed work
    // off owes us links. Asserting unconditionally would fail every worker page.
    if (handoff || subtasks) {
      check(childLinks.length > 0, "sub-tasks render as followable links", `${childLinks.length} link(s)`);
    } else {
      console.log("SKIP  sub-task links — this task delegated nothing");
    }

    // 4. No false "Done": a run is either genuinely finished, paused, or failed —
    //    and whichever it is, it must say so rather than leaving the section open.
    //    Scoped to the pill that closes the run: every tool row also carries a
    //    "Done" badge, so a bare text search would pass on any transcript at all.
    const outcome = await page.evaluate(() => {
      const words = ["Done", "Paused", "Cancelled", "Failed", "Ended"];
      for (const el of document.querySelectorAll("span.rounded-full")) {
        const label = el.innerText.trim();
        if (words.includes(label)) return label;
      }
      return "";
    });
    check(Boolean(outcome), "the run closes with an outcome chip", outcome || "none");

    console.log(`\nshot: ${await shot("01-parent-run")}`);

    // Follow the first sub-task link the way a user would.
    if (childLinks.length) {
      const href = childLinks[0].href;
      await page.goto(`${ORIGIN}${href}`, { waitUntil: "networkidle2" });
      await new Promise((r) => setTimeout(r, 3000));
      const childBody = await text();
      check(!/Authentication required/i.test(childBody) && childBody.length > 40,
        "the sub-task link opens its own task page", href);
      console.log(`shot: ${await shot("02-subtask")}`);
    }
  }

  // The board, so the hand-off is visible as tracked work and not just chat.
  await page.goto(`${ORIGIN}/board`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`shot: ${await shot("03-board")}`);
} finally {
  await browser.close();
}

// Three outcomes, three codes: 0 checked and good, 1 a real regression, 2 the run
// was still going so there was nothing to check — retry rather than investigate.
if (failures > 0) { console.log(`\n${failures} live check(s) failed`); process.exit(1); }
if (unsettled) { console.log("\ninconclusive: the run had not settled — re-run once it finishes"); process.exit(2); }
console.log("\nall live checks passed");
process.exit(0);
