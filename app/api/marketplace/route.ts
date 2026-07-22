import { NextResponse } from "next/server";
import { ROLE_TEMPLATES, TEAM_BLUEPRINTS } from "@/lib/blueprints";
import { fetchModels } from "@/lib/nexotao";

export const runtime = "nodejs";

// The marketplace catalog: curated hireable role templates and installable team
// blueprints, plus the live model catalog so the UI can flag which recommended
// models are currently available for routing.
export async function GET() {
  const models = await fetchModels().catch(() => []);
  const available = new Set(models.map((m) => m.id));
  const roles = ROLE_TEMPLATES.map((r) => ({
    id: r.id, name: r.name, title: r.title, category: r.category, summary: r.summary,
    scope: r.scope, capabilities: r.capabilities, recommendedModel: r.recommendedModel,
    modelAvailable: available.size === 0 ? true : available.has(r.recommendedModel),
    touchesRepo: r.touchesRepo,
  }));
  const blueprints = TEAM_BLUEPRINTS.map((b) => ({
    id: b.id, name: b.name, tagline: b.tagline, description: b.description, icon: b.icon,
    roles: b.roles, roleCount: b.roles.length, issueCount: b.issues.length,
    issues: b.issues.map((i) => ({ title: i.title, role: i.role, priority: i.priority ?? "medium" })),
  }));
  return NextResponse.json({ roles, blueprints, models });
}
