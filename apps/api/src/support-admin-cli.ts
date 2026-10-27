import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { validateEnvironment } from "@kisantractor/config";
import { Pool } from "pg";

import { PgPoolAdapter } from "./sql-pool.js";
import {
  grantSupportAccess,
  listActiveSupportGrants,
  revokeSupportAccess,
  SupportAdminError,
} from "./support/support-admin.js";
import type { SupportGrantScope } from "./support/support.contracts.js";

/**
 * Support access administration (ops/runbooks/support-disputes.md). The only way to issue support
 * access; run by an administrator with database access, never exposed over HTTP.
 *
 *   grant  --operator <userId> --case <caseId> --scope READ|RESOLVE --ticket <ref> [--hours 24]
 *   revoke --grant <grantId>
 *   list   [--operator <userId>]
 *
 * Output is JSON with ids, scopes, and timestamps only. Connection URLs are never printed.
 */
const commands = ["grant", "revoke", "list"] as const;
type Command = (typeof commands)[number];

async function main(command: Command, argv: readonly string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      operator: { type: "string" }, case: { type: "string" }, scope: { type: "string" },
      ticket: { type: "string" }, hours: { type: "string" }, grant: { type: "string" },
    },
    strict: true,
  });
  const pool = new PgPoolAdapter(new Pool({ connectionString: validateEnvironment(process.env).DATABASE_URL, max: 2 }));
  const correlationId = `support-admin:${randomUUID()}`;
  try {
    switch (command) {
      case "grant": {
        const hours = values.hours === undefined ? 24 : Number(values.hours);
        return await grantSupportAccess(pool, {
          operatorUserId: values.operator ?? "",
          caseId: values.case ?? "",
          // Validated by grantSupportAccess: anything but READ or RESOLVE is refused.
          scope: (values.scope ?? "") as SupportGrantScope,
          ticketReference: values.ticket ?? "",
          durationMs: Math.round(hours * 60 * 60 * 1_000),
          correlationId,
        });
      }
      case "revoke":
        return await revokeSupportAccess(pool, { grantId: values.grant ?? "", correlationId });
      case "list":
        return { grants: await listActiveSupportGrants(pool, values.operator) };
    }
  } finally {
    await pool.end();
  }
}

const command = process.argv[2];
if (!commands.some((known) => known === command)) {
  console.error(`Usage: support-admin-cli <${commands.join("|")}> [options]`);
  process.exitCode = 2;
} else {
  main(command as Command, process.argv.slice(3)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }, (error: unknown) => {
    const code = error instanceof SupportAdminError ? error.code
      : typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNCLASSIFIED";
    console.error(JSON.stringify({ error: error instanceof Error ? error.name : "Error", code, message: error instanceof Error ? error.message : "" }));
    process.exitCode = 1;
  });
}
