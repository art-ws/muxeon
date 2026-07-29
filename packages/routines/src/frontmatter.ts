// Routine frontmatter parsing (§6.1). A routine is a Markdown file: a YAML
// frontmatter block (--- … ---) of scheduling fields, then a body that is the signal
// text sent to the agent. This is pure SYNTAX — structure, types, required fields.
// Semantic checks (owner known, cron/tz parseable) live in discovery (§6.2). A
// malformed file is not fatal: parseFrontmatter throws RoutineParseError and the
// caller skips it with a log (§6.2, NFR-9).

export class RoutineParseError extends Error {}

export interface RoutineSpec {
  readonly id: string;
  /** "once" (one-shot) or a cron string (recurring) — there is no boolean `once` (§6.1). */
  readonly schedule: string;
  readonly once: boolean;
  /** Absolute time for schedule:once, in tz (§6.1); absent ⇒ run at the next start/tick. */
  readonly at?: string;
  /** IANA timezone for cron/at (§6.1); absent ⇒ UTC at scheduling. */
  readonly tz?: string;
  /** Explicit recipient; absent ⇒ the owning agent (self, §6.2). */
  readonly target?: string;
  readonly enabled: boolean;
  /** The signal text (body after the frontmatter), trimmed. */
  readonly body: string;
}

// Frontmatter is the leading `---\n … \n---` block; the rest is the body. The YAML
// capture is non-greedy so a `---` inside the body does not end it early.
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RoutineParseError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RoutineParseError(`"${field}" must be a non-empty string when present`);
  }
  return value;
}

export function parseFrontmatter(content: string): RoutineSpec {
  const match = FRONTMATTER.exec(content);
  if (match === null) throw new RoutineParseError("missing YAML frontmatter (--- … ---)");
  const [, yaml = "", body = ""] = match;

  let data: unknown;
  try {
    data = Bun.YAML.parse(yaml);
  } catch (error) {
    throw new RoutineParseError(`invalid YAML frontmatter: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RoutineParseError("frontmatter must be a mapping");
  }
  const fm = data as Record<string, unknown>;

  const id = requireNonEmptyString(fm.id, "id");
  const schedule = requireNonEmptyString(fm.schedule, "schedule");
  const at = optionalString(fm.at, "at");
  const tz = optionalString(fm.tz, "tz");
  const target = optionalString(fm.target, "target");
  if (fm.enabled !== undefined && typeof fm.enabled !== "boolean") {
    throw new RoutineParseError('"enabled" must be a boolean');
  }
  return {
    id,
    schedule,
    once: schedule === "once",
    ...(at !== undefined ? { at } : {}),
    ...(tz !== undefined ? { tz } : {}),
    ...(target !== undefined ? { target } : {}),
    enabled: fm.enabled === undefined ? true : fm.enabled,
    body: body.trim(),
  };
}
