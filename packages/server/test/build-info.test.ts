// Server build info (FR-91): version + the deployed commit and its date. The git
// reads are gated like the loopback probe — present in dev/CI checkouts, absent in
// an exported tarball.

import { describe, expect, test } from "bun:test";
import { buildInfo } from "../src/build-info";

const HAS_GIT = (() => {
  try {
    return (
      Bun.spawnSync({
        cmd: ["git", "rev-parse", "--git-dir"],
        cwd: import.meta.dir,
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  } catch {
    return false;
  }
})();

describe("server build info (FR-91)", () => {
  test("reports a version string and memoizes the result", () => {
    const info = buildInfo();
    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
    expect(buildInfo()).toBe(info); // captured once, same object
  });

  test.skipIf(!HAS_GIT)(
    "in a git checkout, exposes a short commit and a parseable build time",
    () => {
      const info = buildInfo();
      expect(info.commit).toMatch(/^[0-9a-f]{7,}$/);
      expect(info.builtAt).toBeDefined();
      expect(Number.isNaN(new Date(info.builtAt as string).getTime())).toBe(false);
    },
  );
});
