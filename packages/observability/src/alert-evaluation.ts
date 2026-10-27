import type { MetricSample } from "./metrics.js";

/**
 * A deterministic evaluator for the PromQL subset used by `ops/observability/alerts`, so alert
 * thresholds can be tested without a metrics backend (Requirements 12.7, 18.2). It is not a
 * general PromQL engine. Supported: instant and range vector selectors with `=`, `!=`, `=~`, `!~`
 * matchers; `rate`, `increase` (Prometheus extrapolation), `clamp_min`, `histogram_quantile`,
 * `absent`; `sum`/`max`/`min`/`count` with `by`; arithmetic `+ - * /`; filtering comparisons
 * `> < >= <= == !=`; and `and`. Anything else is a parse error, which keeps the alert files
 * inside what these tests can prove.
 */

export type Labels = Readonly<Record<string, string>>;

export interface Series {
  readonly labels: Labels; // includes __name__
  readonly points: Array<readonly [timeMs: number, value: number]>;
}

/** Time series built from successive registry snapshots, as a scraper would see them. */
export class SeriesStore {
  readonly #series = new Map<string, Series>();

  /** Records one scrape of `samples` at `timeMs` (histograms become `_bucket`/`_sum`/`_count`). */
  scrape(timeMs: number, samples: readonly MetricSample[]): void {
    for (const sample of samples) {
      if (sample.kind === "histogram") {
        for (const bucket of sample.buckets) {
          this.#append(`${sample.name}_bucket`, { ...sample.labels, le: String(bucket.le) }, timeMs, bucket.count);
        }
        this.#append(`${sample.name}_sum`, sample.labels, timeMs, sample.sum);
        this.#append(`${sample.name}_count`, sample.labels, timeMs, sample.count);
      } else {
        this.#append(sample.name, sample.labels, timeMs, sample.value);
      }
    }
  }

  #append(name: string, labels: Labels, timeMs: number, value: number): void {
    const full = { ...labels, __name__: name };
    const key = labelKey(full);
    const existing = this.#series.get(key);
    if (existing === undefined) this.#series.set(key, { labels: full, points: [[timeMs, value]] });
    else existing.points.push([timeMs, value]);
  }

  all(): readonly Series[] {
    return [...this.#series.values()];
  }
}

const labelKey = (labels: Labels): string =>
  Object.keys(labels).sort().map((key) => `${key}=${JSON.stringify(labels[key])}`).join(",");

const withoutName = (labels: Labels): Labels => {
  const { __name__: _name, ...rest } = labels;
  return rest;
};

// ---------------------------------------------------------------------------------------------
// Parsing

type Matcher = { readonly label: string; readonly op: "=" | "!=" | "=~" | "!~"; readonly value: string };

type Node =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "selector"; readonly name: string; readonly matchers: readonly Matcher[]; readonly rangeMs?: number }
  | { readonly type: "call"; readonly name: string; readonly args: readonly Node[] }
  | { readonly type: "aggregate"; readonly op: "sum" | "max" | "min" | "count"; readonly by: readonly string[] | undefined; readonly expr: Node }
  | { readonly type: "binary"; readonly op: string; readonly left: Node; readonly right: Node };

interface Token {
  readonly kind: "ident" | "number" | "string" | "duration" | "punct";
  readonly text: string;
}

const DURATION_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd])$/u.exec(text.trim());
  if (match === null) throw new SyntaxError(`Unsupported duration ${text}`);
  return Number(match[1]) * DURATION_MS[match[2]!]!;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/u.exec(rest);
    if (space !== null) {
      index += space[0].length;
      continue;
    }
    const duration = /^\[(\d+[smhd])\]/u.exec(rest);
    if (duration !== null) {
      tokens.push({ kind: "duration", text: duration[1]! });
      index += duration[0].length;
      continue;
    }
    const number = /^(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)/iu.exec(rest);
    if (number !== null) {
      tokens.push({ kind: "number", text: number[0] });
      index += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
    if (ident !== null) {
      tokens.push({ kind: "ident", text: ident[0] });
      index += ident[0].length;
      continue;
    }
    if (rest.startsWith("\"")) {
      let end = 1;
      let value = "";
      while (end < rest.length && rest[end] !== "\"") {
        if (rest[end] === "\\") {
          value += rest[end + 1];
          end += 2;
        } else {
          value += rest[end];
          end += 1;
        }
      }
      if (end >= rest.length) throw new SyntaxError("Unterminated string");
      tokens.push({ kind: "string", text: value });
      index += end + 1;
      continue;
    }
    const punct = /^(?:=~|!~|!=|>=|<=|==|[{}(),=<>/*+-])/u.exec(rest);
    if (punct !== null) {
      tokens.push({ kind: "punct", text: punct[0] });
      index += punct[0].length;
      continue;
    }
    throw new SyntaxError(`Unexpected character ${rest[0]} at ${index}`);
  }
  return tokens;
}

const AGGREGATES = new Set(["sum", "max", "min", "count"]);
const FUNCTIONS = new Set(["rate", "increase", "clamp_min", "histogram_quantile", "absent"]);
const COMPARISONS = new Set([">", "<", ">=", "<=", "==", "!="]);

export function parseExpression(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const next = (): Token => {
    const token = tokens[position];
    if (token === undefined) throw new SyntaxError("Unexpected end of expression");
    position += 1;
    return token;
  };
  const expect = (text: string): void => {
    const token = next();
    if (token.text !== text) throw new SyntaxError(`Expected ${text} but found ${token.text}`);
  };
  const isPunct = (text: string): boolean => peek()?.kind === "punct" && peek()?.text === text;

  const labelList = (): string[] => {
    expect("(");
    const labels: string[] = [];
    while (!isPunct(")")) {
      const token = next();
      if (token.kind !== "ident") throw new SyntaxError(`Expected label name, found ${token.text}`);
      labels.push(token.text);
      if (isPunct(",")) next();
    }
    expect(")");
    return labels;
  };

  const primary = (): Node => {
    const token = next();
    if (token.kind === "number") return { type: "number", value: Number(token.text) };
    if (token.kind === "punct" && token.text === "(") {
      const inner = orExpr();
      expect(")");
      return inner;
    }
    if (token.kind !== "ident") throw new SyntaxError(`Unexpected ${token.text}`);
    if (AGGREGATES.has(token.text)) {
      let by: string[] | undefined;
      if (peek()?.text === "by") {
        next();
        by = labelList();
      }
      expect("(");
      const expr = orExpr();
      expect(")");
      if (peek()?.text === "by") {
        next();
        by = labelList();
      }
      return { type: "aggregate", op: token.text as "sum", by, expr };
    }
    if (FUNCTIONS.has(token.text) && isPunct("(")) {
      next();
      const args: Node[] = [];
      while (!isPunct(")")) {
        args.push(orExpr());
        if (isPunct(",")) next();
      }
      expect(")");
      return { type: "call", name: token.text, args };
    }
    // Vector selector.
    const matchers: Matcher[] = [];
    if (isPunct("{")) {
      next();
      while (!isPunct("}")) {
        const label = next();
        const op = next();
        const value = next();
        if (label.kind !== "ident" || value.kind !== "string" || !["=", "!=", "=~", "!~"].includes(op.text)) {
          throw new SyntaxError(`Invalid matcher near ${label.text}`);
        }
        matchers.push({ label: label.text, op: op.text as Matcher["op"], value: value.text });
        if (isPunct(",")) next();
      }
      expect("}");
    }
    if (peek()?.kind === "duration") {
      return { type: "selector", name: token.text, matchers, rangeMs: parseDuration(next().text) };
    }
    return { type: "selector", name: token.text, matchers };
  };

  const binaryLevel = (operand: () => Node, ops: (token: Token) => boolean) => (): Node => {
    let left = operand();
    while (peek() !== undefined && ops(peek()!)) {
      const op = next().text;
      left = { type: "binary", op, left, right: operand() };
    }
    return left;
  };
  const mulExpr = binaryLevel(primary, (token) => token.kind === "punct" && (token.text === "*" || token.text === "/"));
  const addExpr = binaryLevel(mulExpr, (token) => token.kind === "punct" && (token.text === "+" || token.text === "-"));
  const cmpExpr = binaryLevel(addExpr, (token) => token.kind === "punct" && COMPARISONS.has(token.text));
  const andExpr = binaryLevel(cmpExpr, (token) => token.kind === "ident" && token.text === "and");
  function orExpr(): Node {
    const node = andExpr();
    if (peek()?.kind === "ident" && (peek()!.text === "or" || peek()!.text === "unless")) {
      throw new SyntaxError(`${peek()!.text} is not supported by this evaluator`);
    }
    return node;
  }

  const root = orExpr();
  if (position !== tokens.length) throw new SyntaxError(`Unexpected ${tokens[position]!.text}`);
  return root;
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface VectorElement {
  readonly labels: Labels;
  readonly value: number;
}
type Value = { readonly kind: "scalar"; readonly value: number } | { readonly kind: "vector"; readonly elements: readonly VectorElement[] };
type RangeElement = { readonly labels: Labels; readonly points: ReadonlyArray<readonly [number, number]> };

/** Prometheus's default staleness lookback for instant selectors. */
const LOOKBACK_MS = 5 * 60_000;

const matches = (labels: Labels, name: string, matchers: readonly Matcher[]): boolean =>
  labels.__name__ === name && matchers.every(({ label, op, value }) => {
    const actual = labels[label] ?? "";
    if (op === "=") return actual === value;
    if (op === "!=") return actual !== value;
    const regex = new RegExp(`^(?:${value})$`, "u");
    return op === "=~" ? regex.test(actual) : !regex.test(actual);
  });

/** Prometheus `extrapolatedRate` for counters (rate when `asRate`, otherwise increase). */
function extrapolatedDelta(points: ReadonlyArray<readonly [number, number]>, rangeStart: number, rangeEnd: number, asRate: boolean): number | undefined {
  if (points.length < 2) return undefined;
  const [firstT, firstV] = points[0]!;
  const [lastT, lastV] = points.at(-1)!;
  let delta = lastV - firstV;
  let previous = firstV;
  for (const [, value] of points.slice(1)) {
    if (value < previous) delta += previous; // counter reset
    previous = value;
  }
  const sampled = (lastT - firstT) / 1_000;
  const average = sampled / (points.length - 1);
  let toStart = (firstT - rangeStart) / 1_000;
  const toEnd = (rangeEnd - lastT) / 1_000;
  if (delta > 0 && firstV >= 0) {
    const toZero = sampled * (firstV / delta);
    if (toZero < toStart) toStart = toZero;
  }
  const threshold = average * 1.1;
  let interval = sampled;
  interval += toStart < threshold ? toStart : average / 2;
  interval += toEnd < threshold ? toEnd : average / 2;
  const result = delta * (interval / sampled);
  return asRate ? result / ((rangeEnd - rangeStart) / 1_000) : result;
}

function bucketQuantile(quantile: number, buckets: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...buckets].sort(([a], [b]) => a - b);
  if (sorted.length < 2 || sorted.at(-1)![0] !== Number.POSITIVE_INFINITY) return Number.NaN;
  const total = sorted.at(-1)![1];
  if (total === 0) return Number.NaN;
  const rank = quantile * total;
  const index = sorted.findIndex(([, count]) => count >= rank);
  if (index === sorted.length - 1) return sorted.at(-2)![0];
  const [upper, count] = sorted[index]!;
  const [lower, below] = index === 0 ? [0, 0] : sorted[index - 1]!;
  return lower + (upper - lower) * ((rank - below) / (count - below));
}

const compare = (op: string, left: number, right: number): boolean => {
  switch (op) {
    case ">": return left > right;
    case "<": return left < right;
    case ">=": return left >= right;
    case "<=": return left <= right;
    case "==": return left === right;
    default: return left !== right;
  }
};

const arithmetic = (op: string, left: number, right: number): number => {
  switch (op) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    default: return left / right;
  }
};

export class Evaluator {
  constructor(private readonly store: SeriesStore) {}

  #range(node: Extract<Node, { type: "selector" }>, timeMs: number): RangeElement[] {
    if (node.rangeMs === undefined) throw new SyntaxError(`${node.name} needs a range`);
    const start = timeMs - node.rangeMs;
    return this.store.all()
      .filter((series) => matches(series.labels, node.name, node.matchers))
      .map((series) => ({ labels: series.labels, points: series.points.filter(([t]) => t > start && t <= timeMs) }))
      .filter(({ points }) => points.length > 0);
  }

  evaluate(node: Node, timeMs: number): Value {
    switch (node.type) {
      case "number":
        return { kind: "scalar", value: node.value };
      case "selector": {
        if (node.rangeMs !== undefined) throw new SyntaxError("Range vectors are only valid inside rate/increase");
        const elements: VectorElement[] = [];
        for (const series of this.store.all()) {
          if (!matches(series.labels, node.name, node.matchers)) continue;
          const latest = series.points.filter(([t]) => t <= timeMs && t > timeMs - LOOKBACK_MS).at(-1);
          if (latest !== undefined) elements.push({ labels: series.labels, value: latest[1] });
        }
        return { kind: "vector", elements };
      }
      case "call":
        return this.#call(node, timeMs);
      case "aggregate": {
        const inner = this.#vector(node.expr, timeMs);
        const groups = new Map<string, { labels: Labels; values: number[] }>();
        for (const element of inner) {
          const labels: Record<string, string> = {};
          for (const label of node.by ?? []) if (element.labels[label] !== undefined) labels[label] = element.labels[label]!;
          const key = labelKey(labels);
          const group = groups.get(key) ?? { labels, values: [] };
          group.values.push(element.value);
          groups.set(key, group);
        }
        const reduce = (values: number[]): number => {
          if (node.op === "sum") return values.reduce((sum, value) => sum + value, 0);
          if (node.op === "count") return values.length;
          return node.op === "max" ? Math.max(...values) : Math.min(...values);
        };
        return { kind: "vector", elements: [...groups.values()].map(({ labels, values }) => ({ labels, value: reduce(values) })) };
      }
      case "binary":
        return this.#binary(node, timeMs);
    }
  }

  #vector(node: Node, timeMs: number): readonly VectorElement[] {
    const value = this.evaluate(node, timeMs);
    if (value.kind !== "vector") throw new TypeError("Expected an instant vector");
    return value.elements;
  }

  #call(node: Extract<Node, { type: "call" }>, timeMs: number): Value {
    const [first, second] = node.args;
    switch (node.name) {
      case "rate":
      case "increase": {
        if (first?.type !== "selector") throw new SyntaxError(`${node.name} needs a range selector`);
        const elements: VectorElement[] = [];
        for (const range of this.#range(first, timeMs)) {
          const value = extrapolatedDelta(range.points, timeMs - first.rangeMs!, timeMs, node.name === "rate");
          if (value !== undefined) elements.push({ labels: withoutName(range.labels), value });
        }
        return { kind: "vector", elements };
      }
      case "clamp_min": {
        const minimum = this.evaluate(second!, timeMs);
        if (minimum.kind !== "scalar") throw new TypeError("clamp_min needs a scalar minimum");
        return { kind: "vector", elements: this.#vector(first!, timeMs).map((element) => ({
          labels: withoutName(element.labels), value: Math.max(element.value, minimum.value),
        })) };
      }
      case "histogram_quantile": {
        const quantile = this.evaluate(first!, timeMs);
        if (quantile.kind !== "scalar") throw new TypeError("histogram_quantile needs a scalar quantile");
        const groups = new Map<string, { labels: Labels; buckets: Array<readonly [number, number]> }>();
        for (const element of this.#vector(second!, timeMs)) {
          const { le, ...labels } = withoutName(element.labels);
          if (le === undefined) continue;
          const key = labelKey(labels);
          const group = groups.get(key) ?? { labels, buckets: [] };
          group.buckets.push([le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le), element.value]);
          groups.set(key, group);
        }
        return { kind: "vector", elements: [...groups.values()].map(({ labels, buckets }) => ({ labels, value: bucketQuantile(quantile.value, buckets) })) };
      }
      case "absent":
        return { kind: "vector", elements: this.#vector(first!, timeMs).length === 0 ? [{ labels: {}, value: 1 }] : [] };
      default:
        throw new SyntaxError(`Unsupported function ${node.name}`);
    }
  }

  #binary(node: Extract<Node, { type: "binary" }>, timeMs: number): Value {
    const left = this.evaluate(node.left, timeMs);
    const right = this.evaluate(node.right, timeMs);
    if (node.op === "and") {
      if (left.kind !== "vector" || right.kind !== "vector") throw new TypeError("and needs two vectors");
      const keys = new Set(right.elements.map(({ labels }) => labelKey(withoutName(labels))));
      return { kind: "vector", elements: left.elements.filter(({ labels }) => keys.has(labelKey(withoutName(labels)))) };
    }
    const isComparison = COMPARISONS.has(node.op);
    if (left.kind === "scalar" && right.kind === "scalar") {
      if (isComparison) throw new SyntaxError("Scalar comparisons need the bool modifier, which is not supported");
      return { kind: "scalar", value: arithmetic(node.op, left.value, right.value) };
    }
    const combine = (leftValue: number, rightValue: number, labels: Labels): VectorElement | undefined => {
      if (!isComparison) return { labels: withoutName(labels), value: arithmetic(node.op, leftValue, rightValue) };
      return compare(node.op, leftValue, rightValue) ? { labels, value: leftValue } : undefined;
    };
    if (left.kind === "vector" && right.kind === "scalar") {
      return { kind: "vector", elements: left.elements.flatMap((element) => combine(element.value, right.value, element.labels) ?? []) };
    }
    if (left.kind === "scalar" && right.kind === "vector") {
      return { kind: "vector", elements: right.elements.flatMap((element) => {
        const result = combine(left.value, element.value, element.labels);
        return result === undefined ? [] : [{ labels: result.labels, value: isComparison ? element.value : result.value }];
      }) };
    }
    const rightByKey = new Map((right as Extract<Value, { kind: "vector" }>).elements.map((element) => [labelKey(withoutName(element.labels)), element]));
    return { kind: "vector", elements: (left as Extract<Value, { kind: "vector" }>).elements.flatMap((element) => {
      const partner = rightByKey.get(labelKey(withoutName(element.labels)));
      return partner === undefined ? [] : combine(element.value, partner.value, element.labels) ?? [];
    }) };
  }
}

export interface AlertRuleLike {
  readonly id: string;
  readonly expr: string;
  readonly for: string;
}

export type AlertState = "INACTIVE" | "PENDING" | "FIRING";

/**
 * Evaluates a rule every `stepMs` over [fromMs, toMs] the way an alert manager does: an output
 * series is PENDING while the expression returns it, and FIRING once it has been returned
 * continuously for the rule's `for` duration. Returns the state at each step.
 */
export function evaluateAlert(store: SeriesStore, rule: AlertRuleLike, fromMs: number, toMs: number, stepMs = 60_000): Array<{ timeMs: number; state: AlertState }> {
  const expression = parseExpression(rule.expr);
  const holdMs = parseDuration(rule.for);
  const evaluator = new Evaluator(store);
  const activeSince = new Map<string, number>();
  const states: Array<{ timeMs: number; state: AlertState }> = [];
  for (let timeMs = fromMs; timeMs <= toMs; timeMs += stepMs) {
    const result = evaluator.evaluate(expression, timeMs);
    if (result.kind !== "vector") throw new TypeError(`${rule.id} must evaluate to a vector`);
    const keys = new Set(result.elements.filter(({ value }) => !Number.isNaN(value)).map(({ labels }) => labelKey(withoutName(labels))));
    for (const key of [...activeSince.keys()]) if (!keys.has(key)) activeSince.delete(key);
    for (const key of keys) if (!activeSince.has(key)) activeSince.set(key, timeMs);
    const firing = [...activeSince.values()].some((since) => timeMs - since >= holdMs);
    states.push({ timeMs, state: firing ? "FIRING" : activeSince.size > 0 ? "PENDING" : "INACTIVE" });
  }
  return states;
}
