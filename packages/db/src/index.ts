import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { runMigrations } from "./migrate.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function connectDb(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end() };
}

/**
 * Tenant scoping (spec 01 §7): every query against projection or console-native
 * data must carry the org id. The API layer resolves the caller's org once per
 * request and passes this scope down; nothing else may construct queries.
 * The reconciler and webhook workers use `systemScope` — the single, greppable
 * escape hatch — because they act across tenants by design.
 */
export interface TenantScope {
  orgId: string;
}

export function tenantScope(orgId: string): TenantScope {
  if (!orgId) throw new Error("tenantScope requires an orgId");
  return { orgId };
}

export const SYSTEM_SCOPE_MARKER = "__system__";

export function systemScope(): TenantScope {
  return { orgId: SYSTEM_SCOPE_MARKER };
}

export function isSystemScope(scope: TenantScope): boolean {
  return scope.orgId === SYSTEM_SCOPE_MARKER;
}
