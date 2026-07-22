import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the store singleton at a throwaway dir before importing any lib module
// (the db is captured on first import). Each test uses a distinct projectId so
// writes never collide.
const dir = await mkdtemp(path.join(tmpdir(), "nexotao-blueprints-"));
process.env.NEXOTAO_DATA_DIR = dir;

const { getDatabase } = await import("../lib/db/database");
const schema = await import("../lib/db/schema");
const { installBlueprint, installRoleTemplate, getTeamBlueprint, ROLE_TEMPLATES, TEAM_BLUEPRINTS, getRoleTemplate } = await import("../lib/blueprints");
const { listAgents, listIssues, getAgentModel } = await import("../lib/issues");
const { listIssueDependencies } = await import("../lib/store");

async function makeProject(id: string) {
  const db = await getDatabase();
  await db.write((d) => d.insert(schema.projects).values({ id, name: "Nexotao", path: dir, mode: "multi", agentSpecs: [], createdAt: 1 }).run());
}

after(async () => {
  await (await getDatabase()).close();
  await rm(dir, { recursive: true, force: true });
});

test("installBlueprint hires each role with its recommended model and wires the starter backlog", async () => {
  await makeProject("bp1");
  const blueprint = getTeamBlueprint("ship-a-saas")!;
  const result = await installBlueprint("bp1", "ship-a-saas");

  // Every unique role hired, plus the seeded lead exists.
  const uniqueRoles = new Set(blueprint.roles);
  assert.equal(result.agents.length, uniqueRoles.size, "one new agent per unique role");
  const agents = await listAgents("bp1");
  assert.ok(agents.some((a) => a.role === "lead"), "lead seeded");
  assert.equal(agents.filter((a) => a.role === "worker").length, uniqueRoles.size);

  // Per-role model routing is pinned on each hired agent.
  for (const hired of result.agents) {
    const role = getRoleTemplate(hired.roleId)!;
    assert.equal(await getAgentModel(hired.id), role.recommendedModel, `model routed for ${hired.roleId}`);
  }

  // All starter issues created and assigned; count matches the blueprint.
  const issues = await listIssues("bp1");
  assert.equal(result.issues.length, blueprint.issues.length);
  for (const created of result.issues) {
    assert.ok(created.assigneeAgentId, `issue ${created.ref} has an assignee`);
    assert.ok(issues.some((i) => i.id === created.id), "created issue is listed");
  }

  // Dependency chains are materialised: the QA pass (blockedBy several) has deps.
  const deps = await listIssueDependencies("bp1");
  const qa = result.issues[result.issues.length - 1];
  const qaSpec = blueprint.issues[blueprint.issues.length - 1];
  const qaDeps = deps.filter((d) => d.issueId === qa.id);
  assert.equal(qaDeps.length, (qaSpec.blockedBy ?? []).length, "QA issue blocked by its declared predecessors");
});

test("re-installing a blueprint reuses existing agents instead of duplicating", async () => {
  await makeProject("bp2");
  const first = await installBlueprint("bp2", "launch-mvp");
  const before = (await listAgents("bp2")).filter((a) => a.role === "worker").length;

  const second = await installBlueprint("bp2", "launch-mvp");
  const after = (await listAgents("bp2")).filter((a) => a.role === "worker").length;

  assert.equal(after, before, "no duplicate agents on re-install");
  assert.equal(second.agents.length, 0, "nothing newly hired");
  assert.ok(second.reusedAgents > 0, "existing agents reused");
  // Idempotent issue keys mean the backlog is not duplicated either.
  const issues = await listIssues("bp2");
  const launch = getTeamBlueprint("launch-mvp")!;
  assert.equal(issues.length, launch.issues.length, "starter backlog created once");
  assert.equal(first.issues.length, second.issues.length);
});

test("installRoleTemplate hires a single specialist with model routing", async () => {
  await makeProject("bp3");
  const agent = await installRoleTemplate("bp3", "security-engineer");
  const role = getRoleTemplate("security-engineer")!;
  assert.equal(agent.title, role.title);
  assert.equal(await getAgentModel(agent.id), role.recommendedModel);

  // Hiring the same role again picks a non-colliding name rather than failing.
  const second = await installRoleTemplate("bp3", "security-engineer");
  assert.notEqual(second.name, agent.name, "second hire gets a distinct name");
});

test("every blueprint references only known roles and valid dependency indexes", () => {
  const roleIds = new Set(ROLE_TEMPLATES.map((r) => r.id));
  for (const bp of TEAM_BLUEPRINTS) {
    for (const rid of bp.roles) assert.ok(roleIds.has(rid), `${bp.id} references unknown role ${rid}`);
    for (let i = 0; i < bp.issues.length; i++) {
      const spec = bp.issues[i];
      assert.ok(spec.role === "lead" || roleIds.has(spec.role), `${bp.id} issue ${i} unknown role ${spec.role}`);
      for (const dep of spec.blockedBy ?? []) {
        assert.ok(dep >= 0 && dep < i, `${bp.id} issue ${i} depends on out-of-range/forward index ${dep}`);
      }
    }
  }
});
