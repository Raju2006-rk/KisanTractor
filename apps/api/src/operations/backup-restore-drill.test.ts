import { migrations, type SqlPool } from "@kisantractor/database";
import { describe, expect, it } from "vitest";

import { DrillTargetRefusedError, runBackupRestoreDrill } from "./backup-restore-drill.js";
import { connectionParts, pgToolInvocation } from "./pg-tools.js";

const SOURCE = "postgresql://ops:test-password@db.internal:5432/kisantractor";
const refuseToOpen = (): SqlPool => {
  throw new Error("the drill must not open a pool before its safety checks pass");
};

/** Validates: Requirements 12.7, 18.5 */
describe("backup-restore drill safety", () => {
  it("refuses the source as target and any target not named as disposable, before connecting", async () => {
    for (const targetUrl of [SOURCE, "postgresql://ops:test-password@db.internal:5432/kisantractor_restore"]) {
      await expect(runBackupRestoreDrill({ sourceUrl: SOURCE, targetUrl, openPool: refuseToOpen, migrations }))
        .rejects.toBeInstanceOf(DrillTargetRefusedError);
    }
  });

  it("passes credentials to pg_dump and pg_restore only through the environment", () => {
    const parts = connectionParts(SOURCE);
    for (const options of [{}, { container: "kisan-e2e-pg" }, { binDirectory: "/usr/lib/postgresql/17/bin" }]) {
      const call = pgToolInvocation("pg_dump", ["--format=custom"], parts, options);
      expect(call.args.join(" ")).not.toContain("test-password");
      expect(call.args.join(" ")).not.toContain("postgresql://");
      expect(call.env.PGPASSWORD).toBe("test-password");
      expect(call.env.PGDATABASE).toBe("kisantractor");
    }
    const docker = pgToolInvocation("pg_restore", ["--dbname=kisantractor"], parts, { container: "kisan-e2e-pg" });
    expect(docker.command).toBe("docker");
    expect(docker.args.slice(0, 9)).toEqual(["exec", "-i", "-e", "PGUSER", "-e", "PGPASSWORD", "-e", "PGDATABASE", "kisan-e2e-pg"]);
    expect(() => pgToolInvocation("pg_dump", [], parts, { container: "x; rm -rf /" })).toThrow(TypeError);
    expect(pgToolInvocation("pg_dump", [], parts, {}).env.PGHOST).toBe("db.internal");
  });
});
