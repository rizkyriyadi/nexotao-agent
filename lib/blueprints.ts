// Agent Marketplace + one-click Team Blueprints.
//
// A *role template* is a curated, hireable specialist (scope, instructions,
// capabilities, and a recommended model for per-role routing). A *team
// blueprint* bundles several role templates plus a set of wired starter issues
// (with dependency chains) so a user can stand up a working team for a goal —
// e.g. "Ship a SaaS" — in one click.
//
// This module is the source of truth for both catalogs and owns the install
// engine that turns a selection into real agents and issues via the existing
// lifecycle services.

import { getDatabase } from "./db/database";
import { AgentLifecycleService, AgentLifecycleError, type AgentConfigInput } from "./agent-lifecycle";
import { createIssue, listAgents, seedAgents, leadAgent, type Agent } from "./issues";
import { getProject } from "./store";
import { DEFAULT_MODEL } from "./nexotao";

// Recommended model tiers. Every id below MUST exist in the live Nexotao
// catalog (see AVAILABLE_MODEL_IDS and the guard test in blueprints.test.ts) —
// otherwise the marketplace flags the role as routed to an unavailable model.
// Routing is a recommendation stored on each agent's adapterConfig.model; the
// executor honours it at run time. Claude speaks the Anthropic transport, GPT
// the OpenAI-compatible one.
export const MODEL = {
  reasoning: DEFAULT_MODEL, // claude-opus-4-8 — hardest architecture / product calls
  balanced: "claude-sonnet-4-6", // strong Sonnet default for day-to-day build work
  fast: "gpt-5.6-luna", // cheapest available tier — high-volume drafting / triage
  gpt: "gpt-5.6-terra", // cross-model option for growth / copy work
} as const;

// The model ids the Nexotao gateway currently serves and this app supports
// (Claude on the Anthropic transport + the GPT 5.6 series). Kept as an explicit
// allow-list so a stale recommendedModel is caught by tests instead of shipping
// a template the marketplace flags as unavailable. Must track `fetchModels`.
export const AVAILABLE_MODEL_IDS: readonly string[] = [
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
  "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna",
];

export type RoleCategory = "engineering" | "product" | "design" | "growth" | "data" | "operations";

export type RoleTemplate = {
  id: string;
  name: string; // default agent name when hired
  title: string; // role title shown on the card
  category: RoleCategory;
  summary: string; // one-line marketplace pitch
  scope: string;
  capabilities: string[];
  recommendedModel: string;
  touchesRepo: boolean; // whether the mandatory repo-contribution policy is injected
  instructions: string;
};

export type BlueprintIssueSpec = {
  title: string;
  detail: string;
  role: string; // role template id, or "lead" for the existing lead agent
  priority?: "low" | "medium" | "high";
  blockedBy?: number[]; // indexes into the blueprint's issues array (dependency chain)
};

export type TeamBlueprint = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string; // lucide icon name for the UI
  roles: string[]; // role template ids to hire
  issues: BlueprintIssueSpec[];
};

// Compact form of the company repository-contribution policy, injected into the
// managed instructions of every hired agent that will touch the repo. Keeping it
// here means one-click hires inherit the policy before they get repo access.
const REPO_POLICY = [
  "Repository contribution policy (mandatory when working in the product repo):",
  "- Never add AI/agent/vendor attribution to commits or Git history (no Co-authored-by, Generated-by, or agent signatures).",
  "- Use Conventional Commits in professional English: <type>(<scope>): <imperative summary>. Describe only the product change.",
  "- Never stage, commit, or push agent instruction/runbook Markdown (AGENTS.md, CLAUDE.md, files under .agents/ or agents/, etc.).",
  "- Before every commit/push, inspect staged paths and the full message across all local commits; fix violations before pushing.",
].join("\n");

function role(input: Omit<RoleTemplate, "touchesRepo"> & { touchesRepo?: boolean }): RoleTemplate {
  const touchesRepo = input.touchesRepo ?? input.category === "engineering";
  const instructions = touchesRepo ? `${input.instructions}\n\n${REPO_POLICY}` : input.instructions;
  return { ...input, touchesRepo, instructions };
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  role({
    id: "product-manager", name: "Priya", title: "Product Manager", category: "product",
    summary: "Turns fuzzy goals into scoped, sequenced issues and keeps the team pointed at outcomes.",
    scope: "Owns product scope, prioritisation, and issue breakdown. Writes crisp specs and acceptance criteria.",
    capabilities: ["product-spec", "roadmapping", "issue-breakdown", "prioritisation"],
    recommendedModel: MODEL.reasoning,
    instructions: "You are a product manager. Break goals into small, verifiable issues with clear acceptance criteria. Prefer the smallest slice that ships value. Sequence work by dependency and risk. Escalate scope trade-offs to the lead rather than deciding unilaterally.",
  }),
  role({
    id: "fullstack-engineer", name: "Dev", title: "Full-Stack Engineer", category: "engineering",
    summary: "Builds features end-to-end across API, data, and UI. The workhorse of most teams.",
    scope: "Implements features across the stack, writes tests, and keeps changes small and reviewable.",
    capabilities: ["typescript", "api", "database", "react", "testing"],
    recommendedModel: MODEL.reasoning,
    instructions: "You are a full-stack engineer. Implement features end-to-end with tests. Keep diffs focused, match the surrounding code style, and verify behaviour before marking work done.",
  }),
  role({
    id: "frontend-engineer", name: "Fern", title: "Frontend Engineer", category: "engineering",
    summary: "Ships polished, accessible UI and wires it to the API.",
    scope: "Owns the web UI: components, state, accessibility, and API integration.",
    capabilities: ["react", "nextjs", "css", "accessibility", "ui"],
    recommendedModel: MODEL.balanced,
    instructions: "You are a frontend engineer. Build accessible, responsive UI that matches the existing design system. Prefer existing components and utilities over new ones. Verify in the running app.",
  }),
  role({
    id: "backend-engineer", name: "Bela", title: "Backend Engineer", category: "engineering",
    summary: "Designs data models, APIs, and the reliability of the system underneath.",
    scope: "Owns data models, API surface, background work, and system correctness.",
    capabilities: ["api-design", "database", "concurrency", "reliability", "testing"],
    recommendedModel: MODEL.reasoning,
    instructions: "You are a backend engineer. Design clear data models and APIs, guard invariants, and cover behaviour with tests. Call out migration and backwards-compatibility concerns explicitly.",
  }),
  role({
    id: "qa-engineer", name: "Quinn", title: "QA / Test Engineer", category: "engineering",
    summary: "Catches regressions before users do — end-to-end and edge-case coverage.",
    scope: "Owns test coverage, E2E flows, and release-readiness verification.",
    capabilities: ["testing", "e2e", "fault-injection", "regression"],
    recommendedModel: MODEL.balanced,
    instructions: "You are a QA engineer. Exercise real user flows end-to-end, hunt edge cases, and report reproducible failures with steps and expected-vs-actual. Do not sign off on partial or failing runs.",
  }),
  role({
    id: "devops-engineer", name: "Dana", title: "DevOps / Platform Engineer", category: "operations",
    summary: "CI/CD, environments, and the plumbing that makes shipping boring.",
    scope: "Owns build/release pipelines, environments, observability, and deploy safety.",
    capabilities: ["ci-cd", "infrastructure", "observability", "release"],
    recommendedModel: MODEL.balanced, touchesRepo: true,
    instructions: "You are a DevOps engineer. Automate build, test, and release. Make pipelines fast and deterministic, add health checks, and keep deploys reversible.",
  }),
  role({
    id: "security-engineer", name: "Sami", title: "Security Engineer", category: "engineering",
    summary: "Threat-models features and hardens the system against abuse.",
    scope: "Owns security review, threat modelling, secrets hygiene, and hardening.",
    capabilities: ["security-review", "threat-modelling", "authz", "secrets"],
    recommendedModel: MODEL.reasoning,
    instructions: "You are a security engineer. Threat-model changes, review for authz gaps and secret leakage, and propose concrete mitigations. Prioritise findings by exploitability and impact.",
  }),
  role({
    id: "code-reviewer", name: "Remy", title: "Code Reviewer", category: "engineering",
    summary: "A second set of eyes on every diff — correctness, simplicity, and reuse.",
    scope: "Reviews diffs for correctness bugs and reuse/simplification opportunities.",
    capabilities: ["code-review", "correctness", "refactoring"],
    recommendedModel: MODEL.balanced,
    instructions: "You are a code reviewer. Focus on correctness bugs first, then simplification and reuse. Anchor every finding to a file and line with a concrete failure scenario. Be concise and high-signal.",
  }),
  role({
    id: "ui-designer", name: "Uma", title: "Product Designer", category: "design",
    summary: "Designs flows and interfaces that are clear, consistent, and on-brand.",
    scope: "Owns UX flows, visual design, and the component/design-system language.",
    capabilities: ["ux", "visual-design", "design-system", "prototyping"],
    recommendedModel: MODEL.balanced, touchesRepo: false,
    instructions: "You are a product designer. Design clear flows and interfaces grounded in the existing design system. Specify states, spacing, and accessibility. Hand engineers precise, buildable specs.",
  }),
  role({
    id: "technical-writer", name: "Tao", title: "Technical Writer", category: "product",
    summary: "Turns features into docs users can actually follow.",
    scope: "Owns user-facing documentation, changelogs, and onboarding copy.",
    capabilities: ["documentation", "changelog", "editing"],
    recommendedModel: MODEL.fast, touchesRepo: false,
    instructions: "You are a technical writer. Write clear, task-oriented user documentation. Never document internal agent instructions. Keep a consistent voice and verify steps against the real product.",
  }),
  role({
    id: "growth-marketer", name: "Gio", title: "Growth Marketer", category: "growth",
    summary: "Positioning, launch copy, and the loops that bring users in.",
    scope: "Owns positioning, launch messaging, and growth experiments.",
    capabilities: ["positioning", "copywriting", "growth-experiments", "seo"],
    recommendedModel: MODEL.gpt, touchesRepo: false,
    instructions: "You are a growth marketer. Sharpen positioning, write launch copy that converts, and propose measurable growth experiments. Ground claims in the product's real capabilities.",
  }),
  role({
    id: "data-analyst", name: "Della", title: "Data Analyst", category: "data",
    summary: "Instruments the product and turns usage into decisions.",
    scope: "Owns metrics definitions, analysis, and turning data into recommendations.",
    capabilities: ["analytics", "sql", "metrics", "visualisation"],
    recommendedModel: MODEL.balanced, touchesRepo: false,
    instructions: "You are a data analyst. Define the metrics that matter, analyse honestly, and translate findings into concrete recommendations. Flag data-quality caveats.",
  }),
];

export const TEAM_BLUEPRINTS: TeamBlueprint[] = [
  {
    id: "ship-a-saas", name: "Ship a SaaS", icon: "Rocket",
    tagline: "A full team + backlog to take a SaaS from zero to launch.",
    description: "Product, full-stack build, frontend polish, QA, and release engineering — plus a sequenced backlog covering scaffolding, auth, billing, a landing page, CI/CD, and a release-readiness pass.",
    roles: ["product-manager", "fullstack-engineer", "frontend-engineer", "qa-engineer", "devops-engineer"],
    issues: [
      { title: "Define MVP scope and success metrics", detail: "Draft the one-paragraph product thesis, the must-have MVP feature list, and the metrics that define launch success. Break the rest of the backlog against it.", role: "product-manager", priority: "high" },
      { title: "Scaffold app skeleton and data model", detail: "Stand up the app skeleton, core data model, and local dev loop so features have a foundation to build on.", role: "fullstack-engineer", priority: "high", blockedBy: [0] },
      { title: "Implement authentication and accounts", detail: "Add sign-up, sign-in, sessions, and account management with tests.", role: "fullstack-engineer", priority: "high", blockedBy: [1] },
      { title: "Implement billing and subscription plans", detail: "Integrate billing, plan selection, and entitlement checks behind a clean interface.", role: "backend-engineer", priority: "medium", blockedBy: [2] },
      { title: "Build marketing landing page", detail: "Ship a fast, accessible landing page with clear positioning and a call to action.", role: "frontend-engineer", priority: "medium", blockedBy: [1] },
      { title: "Set up CI/CD and health checks", detail: "Automate build, test, and deploy with health checks and a reversible release path.", role: "devops-engineer", priority: "medium", blockedBy: [1] },
      { title: "Release-readiness QA pass", detail: "Exercise auth, billing, and core flows end-to-end; file reproducible bugs; sign off only on a green run.", role: "qa-engineer", priority: "high", blockedBy: [2, 3, 4, 5] },
    ],
  },
  {
    id: "launch-mvp", name: "Launch an MVP", icon: "Sparkles",
    tagline: "A lean trio to get one core flow in front of users fast.",
    description: "Product, design, and full-stack — scoped to build and ship a single core flow with a coherent design language.",
    roles: ["product-manager", "ui-designer", "fullstack-engineer"],
    issues: [
      { title: "Scope the single core flow", detail: "Pick the one flow that proves the value proposition and define its acceptance criteria.", role: "product-manager", priority: "high" },
      { title: "Design the core flow and states", detail: "Design the screens, states, and empty/error cases for the core flow within the design system.", role: "ui-designer", priority: "high", blockedBy: [0] },
      { title: "Build the core flow end-to-end", detail: "Implement the flow across UI, API, and data with tests, matching the design spec.", role: "fullstack-engineer", priority: "high", blockedBy: [1] },
      { title: "Polish and ship the MVP", detail: "Handle loading/error states, verify in the running app, and prepare the release.", role: "fullstack-engineer", priority: "medium", blockedBy: [2] },
    ],
  },
  {
    id: "content-growth-engine", name: "Content & Growth Engine", icon: "TrendingUp",
    tagline: "Positioning, docs, and instrumentation to turn a product into a funnel.",
    description: "Growth, technical writing, and data — a loop that sharpens positioning, ships docs, and measures what works.",
    roles: ["growth-marketer", "technical-writer", "data-analyst"],
    issues: [
      { title: "Sharpen positioning and messaging", detail: "Define the audience, the core promise, and the launch messaging framework.", role: "growth-marketer", priority: "high" },
      { title: "Write user documentation and onboarding", detail: "Produce task-oriented docs and onboarding copy for the core features.", role: "technical-writer", priority: "medium", blockedBy: [0] },
      { title: "Instrument the funnel and define metrics", detail: "Define the funnel metrics and the events needed to measure activation and retention.", role: "data-analyst", priority: "medium", blockedBy: [0] },
      { title: "Design three growth experiments", detail: "Propose measurable experiments with hypotheses and success thresholds, informed by the funnel metrics.", role: "growth-marketer", priority: "medium", blockedBy: [2] },
    ],
  },
  {
    id: "harden-and-scale", name: "Harden & Scale", icon: "Shield",
    tagline: "A reliability squad to take a prototype to production-grade.",
    description: "Security, backend, DevOps, and QA — sequenced to threat-model, shore up reliability, automate release, and verify under load.",
    roles: ["security-engineer", "backend-engineer", "devops-engineer", "qa-engineer"],
    issues: [
      { title: "Threat-model the system", detail: "Map the attack surface, authz boundaries, and secret flows; rank findings by exploitability and impact.", role: "security-engineer", priority: "high" },
      { title: "Harden data model and invariants", detail: "Close correctness and reliability gaps in the data layer; add invariant checks and tests.", role: "backend-engineer", priority: "high", blockedBy: [0] },
      { title: "Automate release with rollback", detail: "Build a deterministic, reversible release pipeline with health checks and observability.", role: "devops-engineer", priority: "medium", blockedBy: [1] },
      { title: "Fault-injection and load QA", detail: "Run fault-injection and load scenarios against the hardened system; file reproducible failures.", role: "qa-engineer", priority: "high", blockedBy: [1, 2] },
    ],
  },
];

export function getRoleTemplate(id: string): RoleTemplate | null {
  return ROLE_TEMPLATES.find((r) => r.id === id) ?? null;
}
export function getTeamBlueprint(id: string): TeamBlueprint | null {
  return TEAM_BLUEPRINTS.find((b) => b.id === id) ?? null;
}

export type InstalledAgent = { id: string; name: string; roleId: string; title: string; model: string };
export type InstalledIssue = { id: string; ref: string; title: string; assigneeAgentId: string | null };
export type InstallResult = {
  blueprintId?: string;
  agents: InstalledAgent[];
  issues: InstalledIssue[];
  reusedAgents: number; // roles already present that we linked to instead of duplicating
};

// Build the lifecycle config for a role template, pinning the recommended model
// as the per-role routing recommendation.
function configFor(role: RoleTemplate, name: string, leadId: string | null): AgentConfigInput {
  return {
    name, role: "worker", title: role.title, scope: role.scope, reportsTo: leadId,
    capabilities: role.capabilities, adapterType: "nexotao",
    adapterConfig: { model: role.recommendedModel }, runtimeConfig: {}, permissions: {},
    instructions: role.instructions, projectAccess: [], concurrency: 1,
  };
}

// Pick a name that is not already taken in the roster (Priya, Priya 2, ...).
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

async function ensureRoster(projectId: string): Promise<{ agents: Agent[]; lead: Agent | null }> {
  const project = await getProject(projectId);
  let agents = await listAgents(projectId);
  if (!agents.length) agents = await seedAgents(projectId, project?.agents ?? []);
  const lead = (await leadAgent(projectId)) ?? agents.find((a) => a.role === "lead") ?? null;
  return { agents, lead };
}

// Hire a single role template. If an agent already carries this role's title we
// reuse it rather than creating a duplicate.
export async function installRoleTemplate(
  projectId: string,
  roleId: string,
  opts: { name?: string } = {},
): Promise<InstalledAgent> {
  const role = getRoleTemplate(roleId);
  if (!role) throw new AgentLifecycleError("not_found", `Unknown role template: ${roleId}`);
  const { agents, lead } = await ensureRoster(projectId);
  const service = new AgentLifecycleService(await getDatabase());
  const taken = new Set(agents.map((a) => a.name.toLowerCase()));
  const name = freeName(opts.name?.trim() || role.name, taken);
  const created = await service.create(projectId, configFor(role, name, lead?.id ?? null));
  return { id: created.id, name: created.name, roleId: role.id, title: role.title, model: role.recommendedModel };
}

// One-click install of a team blueprint: hire each role (reusing existing
// agents by title where possible), then create the wired starter issues with
// their dependency chains, assigned to the right role.
export async function installBlueprint(projectId: string, blueprintId: string): Promise<InstallResult> {
  const blueprint = getTeamBlueprint(blueprintId);
  if (!blueprint) throw new AgentLifecycleError("not_found", `Unknown team blueprint: ${blueprintId}`);
  const { agents, lead } = await ensureRoster(projectId);
  const service = new AgentLifecycleService(await getDatabase());

  const taken = new Set(agents.map((a) => a.name.toLowerCase()));
  const byTitle = new Map(agents.map((a) => [a.name.toLowerCase(), a] as const));
  const roleToAgentId = new Map<string, string>();
  const installed: InstalledAgent[] = [];
  let reused = 0;

  for (const roleId of blueprint.roles) {
    if (roleToAgentId.has(roleId)) continue;
    const role = getRoleTemplate(roleId);
    if (!role) continue;
    // Reuse an existing agent whose default name matches this role, so
    // re-installing or overlapping blueprints don't spawn duplicates.
    const existing = byTitle.get(role.name.toLowerCase());
    if (existing && existing.role === "worker") {
      roleToAgentId.set(roleId, existing.id);
      reused++;
      continue;
    }
    const name = freeName(role.name, taken);
    taken.add(name.toLowerCase());
    const created = await service.create(projectId, configFor(role, name, lead?.id ?? null));
    roleToAgentId.set(roleId, created.id);
    installed.push({ id: created.id, name: created.name, roleId, title: role.title, model: role.recommendedModel });
  }

  // Create issues in declaration order so dependency indexes always point at an
  // already-created issue.
  const createdIssues: InstalledIssue[] = [];
  const idByIndex: string[] = [];
  for (let i = 0; i < blueprint.issues.length; i++) {
    const spec = blueprint.issues[i];
    const assigneeAgentId = spec.role === "lead" ? lead?.id ?? null : roleToAgentId.get(spec.role) ?? lead?.id ?? null;
    const blockedBy = (spec.blockedBy ?? [])
      .map((idx) => idByIndex[idx])
      .filter((id): id is string => Boolean(id));
    const issue = await createIssue({
      projectId, title: spec.title, detail: spec.detail, assigneeAgentId,
      status: "backlog", priority: spec.priority ?? "medium", blockedBy,
      actor: { type: "user" },
      idempotencyKey: `blueprint:${blueprintId}:issue:${i}`,
    });
    idByIndex[i] = issue.id;
    createdIssues.push({ id: issue.id, ref: issue.ref, title: issue.title, assigneeAgentId });
  }

  return { blueprintId, agents: installed, issues: createdIssues, reusedAgents: reused };
}
