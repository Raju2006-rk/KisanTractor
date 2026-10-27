import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { METRIC_DEFINITIONS, isMetricName, type MetricName, type OperationalIndicator } from "./metrics.js";

const repoRoot = new URL("../../../", import.meta.url);
const opsFile = (path: string): URL => new URL(path, repoRoot);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(opsFile(path), "utf8")) as T;

interface Panel {
  readonly id: string;
  readonly indicator: OperationalIndicator;
  readonly phase: number;
  readonly query: string;
}
interface Dashboard {
  readonly status: string;
  readonly sections: readonly { readonly panels: readonly Panel[] }[];
}
interface AlertRule {
  readonly id: string;
  readonly indicator: OperationalIndicator;
  readonly phase: number;
  readonly severity: string;
  readonly expr: string;
  readonly runbook: string;
  readonly enabled?: boolean;
}
interface AlertFile {
  readonly status: string;
  readonly rules: readonly AlertRule[];
}

const dashboardFiles = readdirSync(opsFile("ops/observability/dashboards/"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => `ops/observability/dashboards/${name}`);
const alertFiles = readdirSync(opsFile("ops/observability/alerts/"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => `ops/observability/alerts/${name}`);
const panels = dashboardFiles.flatMap((file) => readJson<Dashboard>(file).sections.flatMap((section) => section.panels));
const rules = alertFiles.flatMap((file) => readJson<AlertFile>(file).rules);

/** Resolves PromQL series names (including histogram `_bucket/_sum/_count`) to catalog metrics. */
const referencedMetrics = (expression: string): string[] =>
  [...expression.matchAll(/\bkt_[a-z0-9_]+/gu)].map(([name]) => {
    const base = name.replace(/_(bucket|sum|count)$/u, "");
    return base !== name && isMetricName(base) && METRIC_DEFINITIONS[base].kind === "histogram" ? base : name;
  });

/** GitHub-style heading anchors for a markdown file. */
const anchors = (markdown: string): Set<string> =>
  new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map(([, title]) =>
    title!.trim().toLowerCase().replace(/[^a-z0-9 -]/gu, "").replace(/ /gu, "-")));

/** Validates: Requirements 12.7, 18.2 */
describe("ops dashboards and alerts", () => {
  it("are marked as defined but not deployed", () => {
    expect(dashboardFiles.length).toBeGreaterThan(0);
    expect(alertFiles.length).toBeGreaterThan(0);
    for (const file of [...dashboardFiles, ...alertFiles]) {
      expect(readJson<{ status: string }>(file).status).toBe("DEFINED_NOT_DEPLOYED");
    }
  });

  it("reference only metrics defined in the catalog", () => {
    for (const { id, query } of panels) {
      const names = referencedMetrics(query);
      expect(names.length, `panel ${id} references no metric`).toBeGreaterThan(0);
      for (const name of names) expect(isMetricName(name), `panel ${id} references ${name}`).toBe(true);
    }
    for (const { id, expr } of rules) {
      const names = referencedMetrics(expr);
      expect(names.length, `alert ${id} references no metric`).toBeGreaterThan(0);
      for (const name of names) expect(isMetricName(name), `alert ${id} references ${name}`).toBe(true);
    }
  });

  it("use only histogram series suffixes on histograms and label keys each metric declares", () => {
    for (const expression of [...panels.map((panel) => panel.query), ...rules.map((rule) => rule.expr)]) {
      for (const match of expression.matchAll(/\b(kt_[a-z0-9_]+)\{([^}]*)\}/gu)) {
        const metric = referencedMetrics(match[1]!)[0] as MetricName;
        const labels = [...match[2]!.matchAll(/([a-z_]+)\s*(?:=~|!=|!~|=)/gu)].map(([, label]) => label!);
        const declared = Object.keys(METRIC_DEFINITIONS[metric].labels);
        for (const label of labels.filter((name) => name !== "le")) {
          expect(declared, `${metric} has no label ${label}`).toContain(label);
        }
      }
    }
  });

  it("cover every Requirement 18.2 indicator with a dashboard panel and an alert", () => {
    const required: OperationalIndicator[] = [
      "OTP_ABUSE_FAILURE", "ZERO_RESULT_DISCOVERY", "BOOKING_CONVERSION", "ACCEPTANCE_CONFLICTS",
      "INVALID_TRANSITIONS", "INVOICE_DISPUTES", "PAYMENT_VERIFICATION_FAILURES", "OUTBOX_LAG",
      "IVR_ABANDONMENT", "TRANSLATION_MISSES", "WEB_VITALS", "LANDING_3D_FALLBACK",
    ];
    for (const indicator of required) {
      expect(panels.some((panel) => panel.indicator === indicator), `panel for ${indicator}`).toBe(true);
      expect(rules.some((rule) => rule.indicator === indicator), `alert for ${indicator}`).toBe(true);
    }
  });

  it("keep later-phase alerts disabled and match each metric's delivery phase", () => {
    for (const rule of rules) {
      const phases = referencedMetrics(rule.expr).map((name) => METRIC_DEFINITIONS[name as MetricName].phase);
      expect(rule.phase, `alert ${rule.id} phase`).toBe(Math.max(...phases));
      if (rule.phase >= 3) expect(rule.enabled, `alert ${rule.id} must stay disabled`).toBe(false);
      else expect(rule.enabled ?? true).toBe(true);
    }
    for (const panel of panels) {
      const phases = referencedMetrics(panel.query).map((name) => METRIC_DEFINITIONS[name as MetricName].phase);
      expect(panel.phase, `panel ${panel.id} phase`).toBe(Math.max(...phases));
    }
  });

  it("link every alert to an existing runbook section", () => {
    for (const rule of rules) {
      const [path, anchor] = rule.runbook.split("#");
      expect(existsSync(opsFile(path!)), `${rule.id} runbook file ${path}`).toBe(true);
      expect(anchors(readFileSync(opsFile(path!), "utf8")).has(anchor!), `${rule.id} anchor #${anchor}`).toBe(true);
      expect(["critical", "warning", "info"]).toContain(rule.severity);
    }
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
  });

  it("ship error-monitoring, backup/restore, and incident-response procedures (Requirement 12.7)", () => {
    for (const file of ["error-monitoring.md", "backup-restore.md", "incident-response.md"]) {
      const text = readFileSync(opsFile(`ops/runbooks/${file}`), "utf8");
      expect(text).toMatch(/^Status: /mu);
    }
  });
});
