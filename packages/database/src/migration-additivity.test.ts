import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { additivityExceptions } from "./migration-policy.js";
import { migrations } from "./migrations.js";

/** Statement kinds that drop, rename, retype, narrow, or rewrite existing schema or data. */
const DESTRUCTIVE_STATEMENTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["DROP TABLE", /\bDROP\s+TABLE\b/iu],
  ["DROP COLUMN", /\bDROP\s+COLUMN\b/iu],
  ["DROP TYPE", /\bDROP\s+TYPE\b/iu],
  ["DROP FUNCTION", /\bDROP\s+FUNCTION\b/iu],
  ["DROP TRIGGER", /\bDROP\s+TRIGGER\b/iu],
  ["DROP INDEX", /\bDROP\s+INDEX\b/iu],
  ["DROP CONSTRAINT", /\bDROP\s+CONSTRAINT\b/iu],
  ["DROP SCHEMA", /\bDROP\s+SCHEMA\b/iu],
  ["RENAME", /\bRENAME\b/iu],
  ["ALTER COLUMN TYPE", /\bALTER\s+COLUMN\s+\w+\s+(?:SET\s+DATA\s+)?TYPE\b/iu],
  ["SET NOT NULL", /\bSET\s+NOT\s+NULL\b/iu],
  ["TRUNCATE", /\bTRUNCATE\b/iu],
  ["DELETE", /\bDELETE\s+FROM\b/iu],
  ["UPDATE", /\bUPDATE\s+public\./iu],
  ["CREATE OR REPLACE FUNCTION", /\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/iu],
  ["CREATE OR REPLACE TRIGGER", /\bCREATE\s+OR\s+REPLACE\s+TRIGGER\b/iu],
];

/** Removes comments, dollar-quoted bodies, and string literals so only executed DDL/DML remains. */
const executableSql = (sql: string): string =>
  sql
    .replace(/\$\$[\s\S]*?\$\$/gu, "$$$$")
    .replace(/--[^\n]*/gu, "")
    .replace(/'(?:[^']|'')*'/gu, "''");

function destructiveStatementKinds(sql: string): string[] {
  const executable = executableSql(sql);
  return DESTRUCTIVE_STATEMENTS.filter(([, pattern]) => pattern.test(executable)).map(([kind]) => kind).sort();
}

/** Validates: Requirements 18.5 */
describe("additive migration policy", () => {
  it("lists every destructive or rewriting statement in an up migration as a justified exception", () => {
    const actual = Object.fromEntries(migrations
      .map((migration) => [migration.id, destructiveStatementKinds(readFileSync(migration.up, "utf8"))] as const)
      .filter(([, kinds]) => kinds.length > 0));
    const declared = Object.fromEntries(additivityExceptions
      .filter(({ statements }) => statements.length > 0)
      .map(({ migrationId, statements }) => [migrationId, [...statements].sort()]));
    expect(actual).toEqual(declared);
  });

  it("never drops a table, column, type, or function, renames, or retypes in an up migration", () => {
    const forbidden = new Set(["DROP TABLE", "DROP COLUMN", "DROP TYPE", "DROP FUNCTION", "DROP SCHEMA", "RENAME", "ALTER COLUMN TYPE", "TRUNCATE", "DELETE"]);
    for (const migration of migrations) {
      const kinds = destructiveStatementKinds(readFileSync(migration.up, "utf8")).filter((kind) => forbidden.has(kind));
      expect(kinds, migration.id).toEqual([]);
    }
  });

  it("names only registered migrations, once each, with a justification", () => {
    const ids = new Set(migrations.map(({ id }) => id));
    const seen = new Set<string>();
    for (const entry of additivityExceptions) {
      expect(ids.has(entry.migrationId), entry.migrationId).toBe(true);
      expect(seen.has(entry.migrationId), entry.migrationId).toBe(false);
      seen.add(entry.migrationId);
      expect(entry.justification.length).toBeGreaterThan(40);
      expect(entry.statements.length + entry.catalogFindings.length).toBeGreaterThan(0);
    }
  });

  it("ships a down migration for every up migration and keeps ids ordered", () => {
    const ids = migrations.map(({ id }) => id);
    expect([...ids].sort()).toEqual(ids);
    for (const migration of migrations) {
      expect(migration.up.pathname.endsWith(`${migration.id}.up.sql`)).toBe(true);
      expect(readFileSync(migration.down, "utf8").trim().length).toBeGreaterThan(0);
    }
  });

  it("detects destructive statements outside comments and literals", () => {
    expect(destructiveStatementKinds("-- DROP TABLE x\nSELECT 'DROP COLUMN';")).toEqual([]);
    expect(destructiveStatementKinds("ALTER TABLE public.t DROP COLUMN c;")).toEqual(["DROP COLUMN"]);
    expect(destructiveStatementKinds("ALTER TABLE public.t ALTER COLUMN c TYPE bigint;")).toEqual(["ALTER COLUMN TYPE"]);
    expect(destructiveStatementKinds("CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM public.t; END; $$;")).toEqual([]);
  });
});
