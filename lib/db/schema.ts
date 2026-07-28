import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = { createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull() };
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), name: text("name").notNull(), path: text("path").notNull(),
  mode: text("mode", { enum: ["single", "multi"] }).notNull(),
  agentSpecs: text("agent_specs", { mode: "json" }).$type<Array<{ name: string; scope: string }>>().notNull(),
  createdAt: integer("created_at").notNull(),
});
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(), messages: text("messages", { mode: "json" }).$type<Array<{ role: "user" | "assistant"; content: string }>>().notNull(), ...timestamps,
}, (t) => [index("sessions_project_updated_idx").on(t.projectId, t.updatedAt)]);
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(), ref: text("ref").notNull(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(), col: text("col").notNull(), runId: text("run_id"), agent: text("agent"), summary: text("summary"), ...timestamps,
}, (t) => [uniqueIndex("tasks_project_ref_uq").on(t.projectId, t.ref), index("tasks_project_col_idx").on(t.projectId, t.col)]);
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }), agent: text("agent").notNull(),
  task: text("task").notNull(), summary: text("summary").notNull(), ok: integer("ok", { mode: "boolean" }).notNull(), ts: integer("ts").notNull(),
}, (t) => [index("agent_runs_project_agent_ts_idx").on(t.projectId, t.agent, t.ts)]);
export const runRecords = sqliteTable("run_records", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["chat", "orchestrator"] }).notNull(), title: text("title").notNull(),
  status: text("status", { enum: ["running", "done", "error", "cancelled"] }).notNull(), events: text("events", { mode: "json" }).$type<unknown[]>().notNull(), ...timestamps,
}, (t) => [index("run_records_project_updated_idx").on(t.projectId, t.updatedAt)]);
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), role: text("role", { enum: ["lead", "worker"] }).notNull(), title: text("title").notNull().default(""),
  avatar: text("avatar"),
  scope: text("scope").notNull(), reportsTo: text("reports_to"), capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("idle"), adapterType: text("adapter_type").notNull().default("nexotao"),
  adapterConfig: text("adapter_config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  runtimeConfig: text("runtime_config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  permissions: text("permissions", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  instructions: text("instructions").notNull().default(""),
  projectAccess: text("project_access", { mode: "json" }).$type<string[]>().notNull().default([]),
  concurrency: integer("concurrency").notNull().default(1),
  budgetLimit: real("budget_limit"), spentAmount: real("spent_amount").notNull().default(0), pauseReason: text("pause_reason"), errorReason: text("error_reason"),
  lastHeartbeatAt: integer("last_heartbeat_at"), ...timestamps,
}, (t) => [uniqueIndex("agents_project_name_uq").on(t.projectId, t.name), index("agents_project_status_idx").on(t.projectId, t.status)]);
export const agentConfigRevisions = sqliteTable("agent_config_revisions", {
  id: text("id").primaryKey(), agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(), snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  actorType: text("actor_type").notNull(), actorId: text("actor_id"), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("agent_config_revisions_agent_revision_uq").on(t.agentId, t.revision), index("agent_config_revisions_agent_created_idx").on(t.agentId, t.createdAt)]);
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(), parentId: text("parent_id"), title: text("title").notNull(), description: text("description").notNull().default(""),
  status: text("status").notNull(), stage: text("stage").notNull().default("execute"), priority: text("priority").notNull().default("medium"),
  runMode: text("run_mode").notNull().default("agent"),
  // Per-conversation model override. Null means "whatever the project/agent is
  // configured for", so an issue created before the picker existed keeps working.
  model: text("model"),
  assigneeAgentId: text("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdByAgentId: text("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }), checkoutRunId: text("checkout_run_id"),
  executionLockedAt: integer("execution_locked_at"), summary: text("summary").notNull().default(""), startedAt: integer("started_at"),
  completedAt: integer("completed_at"), cancelledAt: integer("cancelled_at"),
  workspacePath: text("workspace_path"), workspaceBranch: text("workspace_branch"), workspaceBaseCommit: text("workspace_base_commit"),
  workspaceCommit: text("workspace_commit"), verificationStatus: text("verification_status"),
  // Work-management columns. `stateId` picks the board column; `status` above stays
  // authoritative for the engine. `sequence` is a fractional index for manual order.
  stateId: text("state_id"), cycleId: text("cycle_id"), estimatePoint: integer("estimate_point"),
  intakeStatus: text("intake_status"), intakeSource: text("intake_source"),
  startDate: integer("start_date"), targetDate: integer("target_date"), sequence: real("sequence"),
  ...timestamps,
}, (t) => [uniqueIndex("issues_project_identifier_uq").on(t.projectId, t.identifier), index("issues_project_status_idx").on(t.projectId, t.status), index("issues_parent_idx").on(t.parentId), index("issues_assignee_status_idx").on(t.assigneeAgentId, t.status), index("issues_state_idx").on(t.stateId), index("issues_cycle_idx").on(t.cycleId)]);
/* The work-management model. `workflow_states` are the columns a user sees on the
   board; `status_group` maps each one onto a canonical `issues.status`, which stays
   the single truth for the agent engine (see lib/issue-lifecycle.ts). Two states may
   share a group — "Code Review" and "QA" can both be `in_review` — so the board is
   configurable without loosening the lifecycle guards. */
export const workflowStates = sqliteTable("workflow_states", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), statusGroup: text("status_group").notNull(), color: text("color").notNull().default("#6b7280"),
  position: real("position").notNull(), isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false), ...timestamps,
}, (t) => [uniqueIndex("workflow_states_project_name_uq").on(t.projectId, t.name), index("workflow_states_project_position_idx").on(t.projectId, t.position)]);
export const labels = sqliteTable("labels", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), color: text("color").notNull().default("#6b7280"), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("labels_project_name_uq").on(t.projectId, t.name)]);
export const issueLabels = sqliteTable("issue_labels", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  labelId: text("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.issueId, t.labelId] }), index("issue_labels_label_idx").on(t.labelId)]);
export const cycles = sqliteTable("cycles", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""),
  startDate: integer("start_date"), endDate: integer("end_date"), completedAt: integer("completed_at"), ...timestamps,
}, (t) => [index("cycles_project_start_idx").on(t.projectId, t.startDate)]);
export const modules = sqliteTable("modules", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""),
  leadAgentId: text("lead_agent_id").references(() => agents.id, { onDelete: "set null" }),
  targetDate: integer("target_date"), status: text("status").notNull().default("planned"), completedAt: integer("completed_at"), ...timestamps,
}, (t) => [index("modules_project_idx").on(t.projectId)]);
export const moduleIssues = sqliteTable("module_issues", {
  moduleId: text("module_id").notNull().references(() => modules.id, { onDelete: "cascade" }),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.moduleId, t.issueId] }), index("module_issues_issue_idx").on(t.issueId)]);
/* Soft links only. Blocking lives in `issue_dependencies` because that is what the
   lifecycle reads to decide whether work may start; putting it here too would give
   the scheduler two disagreeing sources. */
export const issueRelations = sqliteTable("issue_relations", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  relatedIssueId: text("related_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  relationType: text("relation_type", { enum: ["relates_to", "duplicate"] }).notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.issueId, t.relatedIssueId, t.relationType] }), index("issue_relations_related_idx").on(t.relatedIssueId)]);
export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, (t) => [uniqueIndex("saved_views_project_name_uq").on(t.projectId, t.name)]);
/* Pages reuse `documents`/`document_revisions` so note history comes for free and
   there is one versioning mechanism rather than two. */
export const pages = sqliteTable("pages", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(), documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  archivedAt: integer("archived_at"), ...timestamps,
}, (t) => [uniqueIndex("pages_document_uq").on(t.documentId), index("pages_project_updated_idx").on(t.projectId, t.updatedAt)]);
/* Burn-down needs the daily *total*, which transition events alone cannot give:
   an issue added to a cycle mid-sprint raises the total without any transition. */
export const cycleSnapshots = sqliteTable("cycle_snapshots", {
  cycleId: text("cycle_id").notNull().references(() => cycles.id, { onDelete: "cascade" }),
  day: integer("day").notNull(), total: integer("total").notNull(), completed: integer("completed").notNull(), pending: integer("pending").notNull(),
}, (t) => [primaryKey({ columns: [t.cycleId, t.day] })]);
export const issueDependencies = sqliteTable("issue_dependencies", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), blockerIssueId: text("blocker_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.issueId, t.blockerIssueId] }), index("issue_dependencies_blocker_idx").on(t.blockerIssueId)]);
export const issueMutationRequests = sqliteTable("issue_mutation_requests", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  operation: text("operation", { enum: ["create", "delegate"] }).notNull(), idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("issue_mutation_requests_key_uq").on(t.projectId, t.operation, t.idempotencyKey)]);
export const heartbeatRuns = sqliteTable("heartbeat_runs", {
  id: text("id").primaryKey(), agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  wakeupId: text("wakeup_id"),
  source: text("source").notNull(), status: text("status").notNull(), sessionBefore: text("session_before"), sessionAfter: text("session_after"),
  usage: text("usage", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}), error: text("error"),
  workspacePath: text("workspace_path"), workspaceBranch: text("workspace_branch"),
  queuedAt: integer("queued_at"), startedAt: integer("started_at").notNull(), updatedAt: integer("updated_at"), finishedAt: integer("finished_at"),
}, (t) => [uniqueIndex("heartbeat_runs_wakeup_uq").on(t.wakeupId), index("heartbeat_runs_agent_started_idx").on(t.agentId, t.startedAt), index("heartbeat_runs_issue_idx").on(t.issueId)]);
export const wakeupRequests = sqliteTable("wakeup_requests", {
  id: text("id").primaryKey(), agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), issueId: text("issue_id").references(() => issues.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), idempotencyKey: text("idempotency_key").notNull(), status: text("status").notNull(), availableAt: integer("available_at").notNull(),
  runId: text("run_id"), attempt: integer("attempt").notNull().default(0), claimedAt: integer("claimed_at"), finishedAt: integer("finished_at"), lastError: text("last_error"), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("wakeup_agent_idempotency_uq").on(t.agentId, t.idempotencyKey), index("wakeup_status_available_idx").on(t.status, t.availableAt)]);
export const runEvents = sqliteTable("run_events", {
  runId: text("run_id").notNull(), seq: integer("seq").notNull(), type: text("type").notNull(), redactedPayload: text("redacted_payload", { mode: "json" }).$type<unknown>().notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.seq] }), index("run_events_created_idx").on(t.createdAt)]);
export const issueComments = sqliteTable("issue_comments", {
  id: text("id").primaryKey(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), authorType: text("author_type").notNull(), authorId: text("author_id"), runId: text("run_id"), body: text("body").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [index("issue_comments_issue_created_idx").on(t.issueId, t.createdAt)]);
export const documents = sqliteTable("documents", { id: text("id").primaryKey(), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull() });
export const issueDocuments = sqliteTable("issue_documents", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), key: text("key").notNull(), documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.issueId, t.key] }), uniqueIndex("issue_documents_document_uq").on(t.documentId)]);
export const documentRevisions = sqliteTable("document_revisions", {
  id: text("id").primaryKey(), documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }), revision: integer("revision").notNull(), body: text("body").notNull(), createdByType: text("created_by_type").notNull(), createdById: text("created_by_id"), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("document_revisions_document_revision_uq").on(t.documentId, t.revision)]);
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(), type: text("type").notNull(), projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "cascade" }), runId: text("run_id"), toolCallId: text("tool_call_id"),
  action: text("action"), target: text("target"), risk: text("risk"), preview: text("preview"),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(), status: text("status").notNull(), decisionNote: text("decision_note"),
  expiresAt: integer("expires_at"), decidedAt: integer("decided_at"), resumedAt: integer("resumed_at"), createdAt: integer("created_at").notNull(),
}, (t) => [index("approvals_issue_status_idx").on(t.issueId, t.status), index("approvals_project_status_idx").on(t.projectId, t.status), uniqueIndex("approvals_run_tool_uq").on(t.runId, t.toolCallId)]);
export const costEvents = sqliteTable("cost_events", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(), agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), model: text("model").notNull(), inputTokens: integer("input_tokens").notNull(), outputTokens: integer("output_tokens").notNull(), cost: real("cost").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [index("cost_events_agent_created_idx").on(t.agentId, t.createdAt), index("cost_events_run_idx").on(t.runId)]);
export const activityLog = sqliteTable("activity_log", {
  id: text("id").primaryKey(), actorType: text("actor_type").notNull(), actorId: text("actor_id"), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), summary: text("summary", { mode: "json" }).$type<unknown>().notNull(), runId: text("run_id"), createdAt: integer("created_at").notNull(),
}, (t) => [index("activity_entity_created_idx").on(t.entityType, t.entityId, t.createdAt), index("activity_created_idx").on(t.createdAt)]);
export const gitWorkspaces = sqliteTable("git_workspaces", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }), repositoryPath: text("repository_path").notNull(),
  workspacePath: text("workspace_path").notNull(), branch: text("branch").notNull(), targetBranch: text("target_branch").notNull(),
  baseCommit: text("base_commit").notNull(), commitSha: text("commit_sha"), state: text("state").notNull(),
  lastValidatedAt: integer("last_validated_at"), recoveryNote: text("recovery_note"), ...timestamps,
}, (t) => [uniqueIndex("git_workspaces_run_uq").on(t.runId), uniqueIndex("git_workspaces_path_uq").on(t.workspacePath), index("git_workspaces_state_idx").on(t.state)]);
export const schema = { projects, sessions, tasks, agentRuns, agentConfigRevisions, runRecords, agents, issues, issueDependencies, issueMutationRequests, heartbeatRuns, wakeupRequests, runEvents, issueComments, documents, issueDocuments, documentRevisions, approvals, costEvents, activityLog, gitWorkspaces, workflowStates, labels, issueLabels, cycles, modules, moduleIssues, issueRelations, savedViews, pages, cycleSnapshots };
