/* Seeds a work-management fixture into NEXOTAO_DATA_DIR: a project, some agents,
   labels, a cycle, a module, and issues spread across the board columns with
   dates so the calendar and timeline layouts have something to draw. Prints the
   identifiers as JSON so the driver can assert against them. */
import { saveConfig } from "../../lib/config";
import { addProject } from "../../lib/store";
import { createIssue, seedAgents, updateIssue } from "../../lib/issues";
import { createCycle, createLabel, createModule, setIssueLabels, setIssueModules, updateIssueWorkFields } from "../../lib/work-model";

const DAY = 86_400_000;

async function main() {
  const now = Date.now();
  const project = await addProject({
    name: "Work Demo", path: process.env.NEXOTAO_PROJECT_PATH || process.cwd(), mode: "multi",
    agents: [{ name: "Builder", scope: "Implement" }],
  });
  await saveConfig({ apiKey: "e2e-" + "k".repeat(40), model: "nexotao-default", onboarded: true, activeProjectId: project.id });
  const [lead, worker] = await seedAgents(project.id, project.agents ?? []);

  const ui = await createLabel({ projectId: project.id, name: "ui", color: "#8b5cf6" });
  const backend = await createLabel({ projectId: project.id, name: "backend", color: "#10b981" });
  const cycle = await createCycle({ projectId: project.id, name: "Sprint 1", startDate: now - 3 * DAY, endDate: now + 11 * DAY });
  const platform = await createModule({ projectId: project.id, name: "Platform", leadAgentId: lead.id });

  const make = async (title: string, status: "backlog" | "todo" | "in_review", extras: Parameters<typeof updateIssueWorkFields>[1] = {}, priority = "medium") => {
    const issue = await createIssue({ projectId: project.id, title, status, priority, assigneeAgentId: worker.id, actor: { type: "user" } });
    if (Object.keys(extras).length) await updateIssueWorkFields(issue.id, extras);
    return issue;
  };

  const drag = await make("Wire the settings page", "backlog", { estimatePoint: 3, cycleId: cycle.id, targetDate: now + 2 * DAY, startDate: now }, "high");
  const refuse = await make("Rewrite the executor", "todo", { estimatePoint: 8, cycleId: cycle.id, targetDate: now + 5 * DAY, startDate: now + DAY }, "urgent");
  const review = await make("Verify the smoke matrix", "in_review", { estimatePoint: 2, cycleId: cycle.id, targetDate: now + DAY }, "medium");
  const plain = await make("Tidy the changelog", "backlog", {}, "low");

  await setIssueLabels(drag.id, [ui.id]);
  await setIssueLabels(refuse.id, [backend.id, ui.id]);
  await setIssueModules(refuse.id, [platform.id]);
  // A blocked card, so the board shows the status a column cannot express.
  await updateIssue(plain.id, { blockedBy: [refuse.id], status: "blocked" }, { type: "user" });

  process.stdout.write(JSON.stringify({
    projectId: project.id, lead: lead.id, worker: worker.id,
    drag: drag.id, refuse: refuse.id, review: review.id, plain: plain.id,
    cycleId: cycle.id, moduleId: platform.id,
  }) + "\n");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
