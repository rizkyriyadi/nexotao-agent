/** The run modes, and nothing else.
 *
 *  Split out of `execution-policy.ts` because the browser needs these three
 *  strings and that module reaches the database: importing `AgentMode` into a
 *  client component dragged `node:crypto`, drizzle and `node:fs` into the client
 *  bundle, and the build failed outright with "the chunking context does not
 *  support external modules (request: node:fs)".
 *
 *  A type and three literals have no business owning that dependency. The policy
 *  functions that act on them stay where they are, on the server. */
export type AgentMode = "agent" | "plan" | "ask";
export const AGENT_MODES: readonly AgentMode[] = ["agent", "plan", "ask"];
export const DEFAULT_MODE: AgentMode = "agent";
