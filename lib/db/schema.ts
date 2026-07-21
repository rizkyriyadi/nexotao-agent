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
  scope: text("scope").notNull(), reportsTo: text("reports_to"), capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("idle"), adapterType: text("adapter_type").notNull().default("nexotao"),
  adapterConfig: text("adapter_config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  runtimeConfig: text("runtime_config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  permissions: text("permissions", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  budgetLimit: real("budget_limit"), spentAmount: real("spent_amount").notNull().default(0), pauseReason: text("pause_reason"), errorReason: text("error_reason"),
  lastHeartbeatAt: integer("last_heartbeat_at"), ...timestamps,
}, (t) => [uniqueIndex("agents_project_name_uq").on(t.projectId, t.name), index("agents_project_status_idx").on(t.projectId, t.status)]);
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(), parentId: text("parent_id"), title: text("title").notNull(), description: text("description").notNull().default(""),
  status: text("status").notNull(), stage: text("stage").notNull().default("execute"), priority: text("priority").notNull().default("medium"),
  assigneeAgentId: text("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdByAgentId: text("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }), checkoutRunId: text("checkout_run_id"),
  executionLockedAt: integer("execution_locked_at"), summary: text("summary").notNull().default(""), startedAt: integer("started_at"),
  completedAt: integer("completed_at"), cancelledAt: integer("cancelled_at"), ...timestamps,
}, (t) => [uniqueIndex("issues_project_identifier_uq").on(t.projectId, t.identifier), index("issues_project_status_idx").on(t.projectId, t.status), index("issues_parent_idx").on(t.parentId), index("issues_assignee_status_idx").on(t.assigneeAgentId, t.status)]);
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
  id: text("id").primaryKey(), type: text("type").notNull(), issueId: text("issue_id").references(() => issues.id, { onDelete: "cascade" }), runId: text("run_id"), payload: text("payload", { mode: "json" }).$type<unknown>().notNull(), status: text("status").notNull(), decisionNote: text("decision_note"), decidedAt: integer("decided_at"), createdAt: integer("created_at").notNull(),
}, (t) => [index("approvals_issue_status_idx").on(t.issueId, t.status)]);
export const costEvents = sqliteTable("cost_events", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(), agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }), model: text("model").notNull(), inputTokens: integer("input_tokens").notNull(), outputTokens: integer("output_tokens").notNull(), cost: real("cost").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [index("cost_events_agent_created_idx").on(t.agentId, t.createdAt), index("cost_events_run_idx").on(t.runId)]);
export const activityLog = sqliteTable("activity_log", {
  id: text("id").primaryKey(), actorType: text("actor_type").notNull(), actorId: text("actor_id"), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), summary: text("summary", { mode: "json" }).$type<unknown>().notNull(), runId: text("run_id"), createdAt: integer("created_at").notNull(),
}, (t) => [index("activity_entity_created_idx").on(t.entityType, t.entityId, t.createdAt), index("activity_created_idx").on(t.createdAt)]);
export const schema = { projects, sessions, tasks, agentRuns, runRecords, agents, issues, issueDependencies, issueMutationRequests, heartbeatRuns, wakeupRequests, runEvents, issueComments, documents, issueDocuments, documentRevisions, approvals, costEvents, activityLog };
