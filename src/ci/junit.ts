/**
 * Minimal JUnit XML parser — the lingua franca of CI test reports (vitest, jest, pytest, and
 * most runners emit it). Dependency-free and deterministic: a small scanner, not a regex over
 * the whole document, so test names containing `>` or quotes (escaped as entities) parse
 * correctly. We read only what flaky detection needs: each test case's name, its file/suite, and
 * whether it passed, failed, errored, or was skipped.
 */

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface TestCaseResult {
  name: string;
  /** the suite/class the case belongs to (JUnit `classname`) */
  classname?: string;
  /** the test file, when the reporter records it (`file` attribute) */
  file?: string;
  /** wall time in milliseconds, when present */
  timeMs?: number;
  status: TestStatus;
  /** the failure/error message, when the case didn't pass */
  message?: string;
}

export interface JUnitReport {
  suiteName?: string;
  /** the suite's `timestamp` attribute (ISO 8601), when present */
  timestamp?: string;
  tests: TestCaseResult[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Index of the `>` that closes the tag opening at `from`, ignoring `>` inside quoted values. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Parse `key="value"` / `key='value'` pairs from a tag's text. */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1] ?? m[3]!;
    attrs[key] = decode(m[2] ?? m[4] ?? "");
  }
  return attrs;
}

/** The `message` attribute of the first `<failure>`/`<error>` in a case body, if any. */
function childMessage(body: string, tag: "failure" | "error"): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*?\\bmessage="([^"]*)"`).exec(body);
  return m ? decode(m[1]!) : undefined;
}

function statusOf(body: string): { status: TestStatus; message?: string } {
  if (/<failure\b/.test(body)) return { status: "failed", ...(childMessage(body, "failure") ? { message: childMessage(body, "failure") } : {}) };
  if (/<error\b/.test(body)) return { status: "error", ...(childMessage(body, "error") ? { message: childMessage(body, "error") } : {}) };
  if (/<skipped\b/.test(body)) return { status: "skipped" };
  return { status: "passed" };
}

/** Parse a JUnit XML document into a flat list of test cases (across all suites in the file). */
export function parseJUnit(xml: string): JUnitReport {
  const report: JUnitReport = { tests: [] };

  // The singular `<testsuite` (with a tag boundary), not the `<testsuites>` wrapper.
  const suiteMatch = /<testsuite(?=[\s>/])/.exec(xml);
  if (suiteMatch) {
    const suiteStart = suiteMatch.index;
    const end = tagEnd(xml, suiteStart);
    if (end >= 0) {
      const attrs = parseAttrs(xml.slice(suiteStart, end + 1));
      if (attrs["name"]) report.suiteName = attrs["name"];
      if (attrs["timestamp"]) report.timestamp = attrs["timestamp"];
    }
  }

  let i = 0;
  for (;;) {
    const start = xml.indexOf("<testcase", i);
    if (start < 0) break;
    const openEnd = tagEnd(xml, start);
    if (openEnd < 0) break;
    const openTag = xml.slice(start, openEnd + 1);
    const attrs = parseAttrs(openTag);

    let result: { status: TestStatus; message?: string } = { status: "passed" };
    let next = openEnd + 1;
    if (!/\/\s*>$/.test(openTag)) {
      const close = xml.indexOf("</testcase>", openEnd);
      const body = xml.slice(openEnd + 1, close < 0 ? undefined : close);
      result = statusOf(body);
      next = close < 0 ? openEnd + 1 : close + "</testcase>".length;
    }

    const time = attrs["time"] !== undefined ? Number(attrs["time"]) : undefined;
    report.tests.push({
      name: attrs["name"] ?? "",
      ...(attrs["classname"] ? { classname: attrs["classname"] } : {}),
      ...(attrs["file"] ? { file: attrs["file"] } : {}),
      ...(time !== undefined && Number.isFinite(time) ? { timeMs: Math.round(time * 1000) } : {}),
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
    });
    i = next;
  }

  return report;
}
