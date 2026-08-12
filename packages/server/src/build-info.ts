// Server build info (FR-91): the version plus the deployed commit and its date,
// shown on the panel's Settings page. MUXEON runs from SOURCE (no build step, R1),
// so "build time" is the HEAD commit's committer date — the honest marker of when
// the running code was produced. Captured once at boot (git is cheap and cached);
// a non-git deployment (tarball) degrades gracefully to version-only.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Package version (semver placeholder today; the commit is the real identity). */
  readonly version: string;
  /** Short HEAD hash, when the deploy is a git checkout. */
  readonly commit?: string;
  /** ISO committer date of HEAD — the "build time". */
  readonly builtAt?: string;
}

/** Run a git query under `cwd`; undefined on any failure (git absent, not a checkout). */
function git(args: readonly string[], cwd: string): string | undefined {
  try {
    const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function readVersion(srcDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let cached: BuildInfo | undefined;

/** The running server's build info, computed once and memoized. */
export function buildInfo(): BuildInfo {
  if (cached !== undefined) return cached;
  const cwd = import.meta.dir; // inside the repo whether run from source or dist
  const commit = git(["rev-parse", "--short", "HEAD"], cwd);
  const builtAt = git(["log", "-1", "--format=%cI"], cwd);
  cached = {
    version: readVersion(cwd),
    ...(commit !== undefined ? { commit } : {}),
    ...(builtAt !== undefined ? { builtAt } : {}),
  };
  return cached;
}
