import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRoutineFile, setEnabledInContent, writeRoutineFile } from "../src/admin";
import { parseFrontmatter } from "../src/frontmatter";

const ROUTINE = `---
id: nightly
schedule: "0 9 * * *"
tz: "Europe/Moscow"
enabled: true
---
Compile the nightly report.
`;

describe("routine file admin (§8.5, §6.2, FR-23)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamai-routines-admin-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writeRoutineFile writes atomically, creating the owner dir", async () => {
    const path = join(dir, "owner", "nightly.md");
    await writeRoutineFile(path, ROUTINE);
    expect(readFileSync(path, "utf8")).toBe(ROUTINE);
    expect(existsSync(`${path}.tmp`)).toBe(false); // committed, no leftover
  });

  test("deleteRoutineFile removes the file", async () => {
    const path = join(dir, "owner", "nightly.md");
    await writeRoutineFile(path, ROUTINE);
    await deleteRoutineFile(path);
    expect(existsSync(path)).toBe(false);
  });

  test("setEnabledInContent flips an existing enabled line, preserving the rest", () => {
    const disabled = setEnabledInContent(ROUTINE, false);
    const spec = parseFrontmatter(disabled);
    expect(spec.enabled).toBe(false);
    expect(spec.id).toBe("nightly");
    expect(spec.tz).toBe("Europe/Moscow");
    expect(disabled).toContain("Compile the nightly report."); // body untouched
    expect(setEnabledInContent(disabled, true)).toContain("enabled: true");
  });

  test("setEnabledInContent appends the line when absent (default enabled, §6.1)", () => {
    const withoutEnabled = ROUTINE.replace("enabled: true\n", "");
    const disabled = setEnabledInContent(withoutEnabled, false);
    expect(parseFrontmatter(disabled).enabled).toBe(false);
  });

  test("setEnabledInContent on a file without frontmatter throws", () => {
    expect(() => setEnabledInContent("just text", false)).toThrow(/frontmatter/);
  });
});
