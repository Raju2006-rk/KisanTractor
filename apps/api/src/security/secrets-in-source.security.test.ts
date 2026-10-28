import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SECRET_ENV_KEYS, loadRuntimeSecrets } from "../runtime-config.js";

/**
 * Secrets stay outside source (Requirement 12.1): the repository holds no key material,
 * provider credentials, or real environment files, and runtime keys come only from the
 * process environment.
 *
 * Validates: Requirements 12.1
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".pnpm-store", ".turbo"]);
const SKIPPED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".glb", ".gltf", ".woff", ".woff2", ".pdf"]);
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

const repositoryFiles = (directory: string): string[] => {
  try {
    const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: directory,
      encoding: "utf8",
    });
    return stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((entry) => join(directory, entry))
      .filter((path) => {
        if (SKIPPED_EXTENSIONS.has(extname(path).toLowerCase())) return false;
        try {
          return statSync(path).size <= MAX_SCANNED_BYTES;
        } catch {
          return false;
        }
      });
  } catch {
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : scan(path);
        if (!entry.isFile() || SKIPPED_EXTENSIONS.has(extname(entry.name).toLowerCase())) return [];
        if (/^\.env(?!\..*\.example$)/u.test(entry.name)) return [];
        return statSync(path).size > MAX_SCANNED_BYTES ? [] : [path];
      });
    return scan(directory);
  }
};

/** Credential shapes that must never be committed. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u],
  ["Stripe/Razorpay live key", /\b(?:sk_live|rk_live|rzp_live)_[A-Za-z0-9]{8,}\b/u],
  ["Twilio account SID with auth token", /\bAC[0-9a-f]{32}\b/u],
  // A runtime secret name assigned a literal 32-byte hex value anywhere in source or config.
  ["hard-coded runtime key", new RegExp(`\\b(?:${SECRET_ENV_KEYS.join("|")})\\b["']?\\s*[:=]\\s*["'\`]?[0-9a-fA-F]{64}`, "u")],
];

/** Synthetic values that tests use deliberately (for example to prove a redactor removes them). */
const TEST_ONLY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u],
];

/** Connection URLs may only carry obvious placeholder or disposable local credentials. */
const CREDENTIALED_URL = /\b(?:postgres(?:ql)?|redis|amqp|mongodb):\/\/[^\s:@/]+:([^\s@/]+)@/gu;
const PLACEHOLDER_PASSWORDS = new Set([
  "kisantractor", "PASSWORD", "password", "unused", "secret", "test-password", "runtime-password", "${password}",
]);
const isTestFile = (file: string): boolean => /\.test\.tsx?$/u.test(file) || file.includes(`${sep}test-utils${sep}`);

describe("secrets are not stored in source", () => {
  const files = repositoryFiles(ROOT);

  it("scans the repository's source, configuration, and documentation files", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((file) => file.endsWith(`apps${sep}api${sep}src${sep}runtime-config.ts`))).toBe(true);
  });

  it("finds no key material, provider credentials, or tokens in tracked files", () => {
    const findings: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const patterns = isTestFile(file) ? SECRET_PATTERNS : [...SECRET_PATTERNS, ...TEST_ONLY_PATTERNS];
      for (const [name, pattern] of patterns) {
        if (pattern.test(text)) findings.push(`${relative(ROOT, file)}: ${name}`);
      }
      for (const [, password] of text.matchAll(CREDENTIALED_URL)) {
        if (!PLACEHOLDER_PASSWORDS.has(password!)) findings.push(`${relative(ROOT, file)}: credentialed URL with a real-looking password`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("commits only environment examples, and they carry no secret values", () => {
    const environmentFiles = files.filter((file) => /^\.env/u.test(file.slice(file.lastIndexOf(sep) + 1)));
    expect(environmentFiles.map((file) => relative(ROOT, file)).sort()).toEqual([
      ".env.local.example", ".env.production.example", ".env.staging.example", ".env.test.example",
    ]);
    for (const file of environmentFiles) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
        const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
        if (match === null) continue;
        const [, name, value] = match;
        // No runtime key or other secret-named variable ships a value.
        if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/u.test(name!)) expect(value, `${file} ${name}`).toBe("");
      }
    }
    for (const file of environmentFiles.filter((path) => /production|staging/u.test(path))) {
      expect(readFileSync(file, "utf8")).toMatch(/^DATABASE_URL=postgresql:\/\/USER:PASSWORD@/mu);
    }
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/u);
    expect(gitignore).toEqual(expect.arrayContaining([".env", ".env.*", "!.env.*.example"]));
  });

  it("loads every runtime key only from the environment and fails closed without it", () => {
    expect(() => loadRuntimeSecrets({})).toThrow(/Missing required secret environment variable FIELD_ENCRYPTION_KEY/u);
    const short = Object.fromEntries(SECRET_ENV_KEYS.map((name) => [name, "ab".repeat(16)]));
    expect(() => loadRuntimeSecrets(short)).toThrow(/expected 64 hex characters/u);
    // Error messages never echo the supplied value.
    try {
      loadRuntimeSecrets({ ...short, FIELD_ENCRYPTION_KEY: "zz".repeat(32) });
    } catch (error) {
      expect(String(error)).not.toContain("zz".repeat(32));
    }
  });
});
