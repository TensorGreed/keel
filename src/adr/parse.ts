/**
 * Minimal Markdown ADR (Architecture Decision Record) parser — MADR-style, dependency-free. We read
 * only what a decision record needs: a title (the first heading), a status, and the context/decision
 * prose when the doc has those sections. Tolerant of the common MADR shapes: a leading numbered title
 * ("1. Use X"), a `## Status` section, YAML frontmatter (`status:`/`date:`), or an inline `Status:`
 * line. Anything it can't find is simply absent — the record still carries its title and body.
 */

export interface ParsedAdr {
  title: string;
  status?: string;
  /** the context / problem-statement section, when present */
  context?: string;
  /** the decision / outcome section, when present */
  decision?: string;
  /** a date from frontmatter (`date:`), when present */
  date?: string;
  /** the markdown body with any YAML frontmatter stripped — for link scanning + embedding text */
  body: string;
}

interface Section {
  heading: string;
  body: string;
}

/** Split leading `---` YAML frontmatter into simple key/value fields and the remaining body. */
function splitFrontmatter(content: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>();
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { fields, body: content };
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1]!.toLowerCase(), kv[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  return { fields, body: content.slice(m[0].length) };
}

/** Break the body into heading → text sections (any heading level). */
function sections(body: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      cur = { heading: h[1]!.trim(), body: "" };
      out.push(cur);
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  return out;
}

/** Strip an ADR number/prefix from a title ("1. Use X", "ADR-5: Use X" → "Use X"). */
function cleanTitle(text: string): string {
  return text.replace(/^\s*(?:ADR[-\s]*)?\d+[.:)\]]*\s*/i, "").trim() || text.trim();
}

const firstNonEmptyLine = (text: string): string | undefined =>
  text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);

export function parseAdr(content: string): ParsedAdr {
  const { fields, body } = splitFrontmatter(content);
  const secs = sections(body);

  // Title: the first ATX heading, else the frontmatter `title`, else the first non-empty line.
  const headingTitle = secs[0]?.heading;
  const title = cleanTitle(headingTitle ?? fields.get("title") ?? firstNonEmptyLine(body) ?? "Untitled ADR");

  const sectionBy = (re: RegExp): string | undefined => {
    const s = secs.find((x) => re.test(x.heading));
    const text = s?.body.trim();
    return text ? text : undefined;
  };

  // Status: frontmatter, else a `## Status` section, else an inline `Status: accepted` line.
  const inlineStatus = /^\s*[*-]?\s*status\s*:\s*(.+)$/im.exec(body);
  const statusSection = sectionBy(/^status$/i);
  const status = (fields.get("status") ?? (statusSection && firstNonEmptyLine(statusSection)) ?? (inlineStatus ? inlineStatus[1]!.trim() : undefined))?.trim();

  const context = sectionBy(/context|problem/i);
  const decision = sectionBy(/decision|outcome|chosen/i);
  const date = fields.get("date");

  return {
    title,
    ...(status ? { status } : {}),
    ...(context ? { context } : {}),
    ...(decision ? { decision } : {}),
    ...(date ? { date } : {}),
    body,
  };
}
