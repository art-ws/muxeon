import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCentralRoutines } from "../src/discover";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teamai-routines-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Write <root>/routines/<owner>/<name>.md and return the routines dir.
function write(owner: string, name: string, content: string): string {
  const dir = join(root, "routines", owner);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  return join(root, "routines");
}

const discover = (knownAgents: string[]) =>
  discoverCentralRoutines({ routinesDir: join(root, "routines"), knownAgents });

describe("discoverCentralRoutines (§6.2)", () => {
  test("loads valid routines under a known owner; target defaults to the owner (self)", () => {
    write("researcher", "a.md", "---\nid: a\nschedule: once\n---\nhello");
    const { routines, skipped } = discover(["researcher"]);
    expect(skipped).toHaveLength(0);
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      id: "a",
      owner: "researcher",
      target: "researcher",
      once: true,
    });
  });

  test("an explicit target is preserved (edge-checked later at route time, §10.2)", () => {
    write("researcher", "a.md", "---\nid: a\nschedule: once\ntarget: writer\n---\nx");
    expect(discover(["researcher", "writer"]).routines[0]?.target).toBe("writer");
  });

  test("a routine under an unknown owner is rejected with a log (§6.2)", () => {
    write("ghost", "a.md", "---\nid: a\nschedule: once\n---\nx");
    const { routines, skipped } = discover(["researcher"]);
    expect(routines).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/unknown owner "ghost"/);
  });

  test("a malformed file is skipped with a log; valid siblings still load (§6.2, NFR-9)", () => {
    const dir = write("researcher", "good.md", "---\nid: good\nschedule: once\n---\nok");
    writeFileSync(join(dir, "researcher", "bad.md"), "---\nschedule: once\n---\nno id");
    const { routines, skipped } = discover(["researcher"]);
    expect(routines.map((r) => r.id)).toEqual(["good"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toMatch(/bad\.md$/);
  });

  test("an unparseable cron / invalid tz is skipped (§6.2)", () => {
    write("researcher", "cron.md", `---\nid: c\nschedule: "not a cron"\n---\nx`);
    write("researcher", "tz.md", `---\nid: t\nschedule: "0 9 * * *"\ntz: Mars/Phobos\n---\nx`);
    const { routines, skipped } = discover(["researcher"]);
    expect(routines).toHaveLength(0);
    expect(skipped.map((s) => s.reason).join("|")).toMatch(
      /invalid cron.*invalid timezone|invalid timezone.*invalid cron/s,
    );
  });

  test("a duplicate id within an owner is skipped (id unique per agent, §6.2)", () => {
    const dir = write("researcher", "one.md", "---\nid: dup\nschedule: once\n---\nfirst");
    writeFileSync(join(dir, "researcher", "two.md"), "---\nid: dup\nschedule: once\n---\nsecond");
    const { routines, skipped } = discover(["researcher"]);
    expect(routines).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/duplicate routine id "dup"/);
  });

  test("a disabled routine still loads (so its state is not orphan-pruned, §6.3)", () => {
    write("researcher", "a.md", `---\nid: a\nschedule: "0 9 * * *"\nenabled: false\n---\nx`);
    expect(discover(["researcher"]).routines[0]).toMatchObject({ id: "a", enabled: false });
  });

  test("a missing routines directory yields an empty result, not an error", () => {
    expect(
      discoverCentralRoutines({ routinesDir: join(root, "nope"), knownAgents: ["a"] }),
    ).toEqual({
      routines: [],
      skipped: [],
    });
  });
});
