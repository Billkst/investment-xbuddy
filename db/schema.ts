import {
  sqliteTable,
  text,
  integer,
  index,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const serviceConnections = sqliteTable("service_connections", {
  id: text("id").primaryKey(),
  credentialHash: text("credential_hash").notNull(),
  state: text("state").notNull(),
});
export const modelUsage = sqliteTable(
  "model_usage",
  {
    bucket: text("bucket").primaryKey(),
    calls: integer("calls").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    callLimit: integer("call_limit").notNull().default(5000),
    tokenLimit: integer("token_limit").notNull().default(2000000),
  },
  (t) => [
    check("model_calls_limit", sql`${t.calls} <= ${t.callLimit}`),
    check("model_tokens_limit", sql`${t.tokens} <= ${t.tokenLimit}`),
  ],
);
export const researchWorkspaces = sqliteTable("research_workspaces", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
export const researchRuns = sqliteTable(
  "research_runs",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull().default(0),
    leaseId: text("lease_id"),
    leaseUntil: integer("lease_until").notNull().default(0),
    stopRequested: integer("stop_requested").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("research_runs_owner_updated").on(t.owner, t.updatedAt)],
);
export const researchCheckpoints = sqliteTable(
  "research_checkpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    owner: text("owner").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("research_checkpoints_run").on(t.runId)],
);
export const researchMemories = sqliteTable(
  "research_memories",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    content: text("content").notNull(),
    sourceRunId: text("source_run_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("research_memories_owner").on(t.owner)],
);
