// Hybrid discovery (T36, FR-21b, §6.2): central + cwd-side routines merged by
// (owner, id) with central precedence — the operator's central copy overrides the
// agent-native one, including the enabled:false kill-switch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRoutines } from "../src/discover";

let dir: string;
let routinesDir: string;
let agentCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-cwd-routines-"));
  routinesDir = join(dir, "central");
  agentCwd = join(dir, "repo");
  mkdirSync(routinesDir, { recursive: true });
  mkdirSync(join(agentCwd, ".muxeon", "routines"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function md(id: string, extra = ""): string {
  return `---\nid: ${id}\nschedule: once\n${extra}---\nbody of ${id}\n`;
}

function writeCentral(owner: string, id: string, extra?: string): void {
  mkdirSync(join(routinesDir, owner), { recursive: true });
  writeFileSync(join(routinesDir, owner, `${id}.md`), md(id, extra));
}

function writeCwd(id: string, extra?: string): void {
  writeFileSync(join(agentCwd, ".muxeon", "routines", `${id}.md`), md(id, extra));
}

const discover = (withCwd = true) =>
  discoverRoutines({
    routinesDir,
    knownAgents: ["researcher"],
    ...(withCwd ? { agentCwds: new Map([["researcher", agentCwd]]) } : {}),
  });

describe("cwd-side routine discovery + merge (§6.2)", () => {
  test("a cwd-only routine loads with the agent as owner and source in the repo", () => {
    writeCwd("repo-task");
    const { routines } = discover();
    expect(routines).toHaveLength(1);
    expect(routines[0]?.owner).toBe("researcher");
    expect(routines[0]?.target).toBe("researcher"); // default self (§6.2)
    expect(routines[0]?.source).toContain(".muxeon");
  });

  test("central overrides cwd on an id collision", () => {
    writeCwd("nightly", "target: researcher\n");
    writeCentral("researcher", "nightly", "tz: UTC\n");
    const { routines } = discover();
    expect(routines).toHaveLength(1);
    expect(routines[0]?.source).toContain("central"); // the central copy won
    expect(routines[0]?.tz).toBe("UTC");
  });

  test("central enabled:false kills the agent-native routine of the same id (kill-switch)", () => {
    writeCwd("risky"); // enabled defaults to true
    writeCentral("researcher", "risky", "enabled: false\n");
    const { routines } = discover();
    expect(routines).toHaveLength(1);
    expect(routines[0]?.enabled).toBe(false); // the merged view is disabled
  });

  test("distinct ids from both sides coexist", () => {
    writeCwd("repo-task");
    writeCentral("researcher", "central-task");
    const ids = discover()
      .routines.map((r) => r.id)
      .sort();
    expect(ids).toEqual(["central-task", "repo-task"]);
  });

  test("without a cwd (attach-only) only central applies", () => {
    writeCwd("repo-task");
    writeCentral("researcher", "central-task");
    const { routines } = discover(false);
    expect(routines.map((r) => r.id)).toEqual(["central-task"]);
  });

  test("a malformed cwd file is skipped with a reason, the rest load (§6.2)", () => {
    writeFileSync(join(agentCwd, ".muxeon", "routines", "broken.md"), "no frontmatter at all");
    writeCwd("good");
    const { routines, skipped } = discover();
    expect(routines.map((r) => r.id)).toEqual(["good"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("frontmatter");
  });

  test("a missing .muxeon/routines dir is simply empty", () => {
    rmSync(join(agentCwd, ".muxeon"), { recursive: true });
    expect(discover().routines).toHaveLength(0);
  });
});
