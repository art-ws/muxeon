// Central routine discovery + owner validation (§6.2). Walks the central directory
// <config_dir>/routines/<agent>/*.md. The directory name is the OWNER (and the
// signal's `from`, §6.2): it must be a configured agent, else every routine under it
// is rejected with a log — otherwise self-delivery (from==to) would queue into an
// unserved <root>/<unknown>/. A file that is malformed, has an unparseable cron/tz, or
// duplicates an id within its owner is skipped with a log (NFR-9); the rest load.
// (cwd-side routines — FR-21b — are a Should add-on, T36; baseline is central-only.)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { type RoutineSpec, parseFrontmatter } from "./frontmatter";

export interface Routine {
  readonly id: string;
  /** Owning agent = the signal's `from` (§6.2). */
  readonly owner: string;
  /** Resolved recipient: explicit target, else the owner (self, §6.2). Edge-checked at route time. */
  readonly target: string;
  readonly schedule: string;
  readonly once: boolean;
  readonly at?: string;
  readonly tz?: string;
  readonly enabled: boolean;
  readonly body: string;
  /** The source file path (for re-scan, CRUD, logs). */
  readonly source: string;
}

export interface SkippedRoutine {
  readonly path: string;
  readonly reason: string;
}

export interface DiscoveryResult {
  readonly routines: Routine[];
  readonly skipped: SkippedRoutine[];
}

export interface DiscoverOptions {
  /** Central routines base, <config_dir>/routines (§6.2/§7.4). */
  readonly routinesDir: string;
  /** Configured agent names — the valid owners. */
  readonly knownAgents: Iterable<string>;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return []; // missing dir → no routines
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Semantic validation beyond syntax: tz resolvable, cron parseable, `at` a real date.
function semanticError(spec: RoutineSpec): string | null {
  if (spec.tz !== undefined && !isValidTz(spec.tz)) return `invalid timezone "${spec.tz}"`;
  if (spec.once) {
    if (spec.at !== undefined && Number.isNaN(Date.parse(spec.at))) {
      return `invalid "at" datetime "${spec.at}"`;
    }
    return null;
  }
  try {
    new Cron(spec.schedule, spec.tz !== undefined ? { timezone: spec.tz } : {});
  } catch (error) {
    return `invalid cron "${spec.schedule}": ${(error as Error).message}`;
  }
  return null;
}

/** Discover and validate central routines; valid ones load, the rest are reported skipped. */
export function discoverCentralRoutines(options: DiscoverOptions): DiscoveryResult {
  const known = new Set(options.knownAgents);
  const routines: Routine[] = [];
  const skipped: SkippedRoutine[] = [];

  for (const owner of safeReaddir(options.routinesDir)) {
    const ownerDir = join(options.routinesDir, owner);
    if (!isDir(ownerDir)) continue;
    if (!known.has(owner)) {
      skipped.push({ path: ownerDir, reason: `unknown owner "${owner}" (not a configured agent)` });
      continue;
    }
    const scanned = scanOwnerDir(ownerDir, owner);
    routines.push(...scanned.routines);
    skipped.push(...scanned.skipped);
  }
  return { routines, skipped };
}

/** Scan one owner's routine directory: every valid *.md loads, the rest report skipped. */
function scanOwnerDir(ownerDir: string, owner: string): DiscoveryResult {
  const routines: Routine[] = [];
  const skipped: SkippedRoutine[] = [];
  const seen = new Set<string>();
  for (const name of safeReaddir(ownerDir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(ownerDir, name);
    if (isDir(path)) continue;

    let spec: RoutineSpec;
    try {
      spec = parseFrontmatter(readFileSync(path, "utf8"));
    } catch (error) {
      skipped.push({ path, reason: (error as Error).message });
      continue;
    }
    const semantic = semanticError(spec);
    if (semantic !== null) {
      skipped.push({ path, reason: semantic });
      continue;
    }
    if (seen.has(spec.id)) {
      skipped.push({ path, reason: `duplicate routine id "${spec.id}" for owner "${owner}"` });
      continue;
    }
    seen.add(spec.id);
    routines.push({
      id: spec.id,
      owner,
      target: spec.target ?? owner, // default self (§6.2)
      schedule: spec.schedule,
      once: spec.once,
      ...(spec.at !== undefined ? { at: spec.at } : {}),
      ...(spec.tz !== undefined ? { tz: spec.tz } : {}),
      enabled: spec.enabled,
      body: spec.body,
      source: path,
    });
  }
  return { routines, skipped };
}

export interface MergedDiscoverOptions extends DiscoverOptions {
  /**
   * agent → its cwd (§7.1) for the cwd-side discovery (FR-21b, §6.2):
   * <cwd>/.muxeon/routines/*.md, versioned with the agent's repo. An agent with
   * no cwd (attach-only) gets central routines only.
   */
  readonly agentCwds?: ReadonlyMap<string, string>;
}

/**
 * Hybrid discovery (§6.2, FR-21b): the union of central and cwd-side routines,
 * merged by (owner, id) with CENTRAL precedence — the operator's central copy
 * overrides the agent-native one; in particular a central `enabled: false` kills
 * the cwd routine of the same id (the FR-23 kill-switch via override).
 */
export function discoverRoutines(options: MergedDiscoverOptions): DiscoveryResult {
  const central = discoverCentralRoutines(options);
  const skipped = [...central.skipped];
  const merged = new Map<string, Routine>();
  const key = (routine: Routine): string => `${routine.owner}\x00${routine.id}`;

  for (const [owner, cwd] of options.agentCwds ?? []) {
    const scanned = scanOwnerDir(join(cwd, ".muxeon", "routines"), owner);
    for (const routine of scanned.routines) merged.set(key(routine), routine);
    skipped.push(...scanned.skipped);
  }
  for (const routine of central.routines) merged.set(key(routine), routine); // central wins

  return { routines: [...merged.values()], skipped };
}
