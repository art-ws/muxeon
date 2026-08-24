import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { capturePane } from "../src/capture";
import { exactTarget, hasTmux } from "../src/run";
import { sendKeys, sendLiteral } from "../src/send";
import { hasSession, killSession, newSession, sessionCreatedAt } from "../src/session";

const HAS_TMUX = await hasTmux();

test("exactTarget pins an exact session (=name:) so tmux never prefix-matches", () => {
  expect(exactTarget("dev")).toBe("=dev:");
});

// Polls the pane until `pattern` appears (real tmux + shell have timing); avoids
// fixed sleeps.
async function waitForPane(session: string, pattern: RegExp, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = await capturePane(session);
    if (pattern.test(pane)) return pane;
    if (Date.now() > deadline)
      throw new Error(`pane never matched ${pattern}; last pane:\n${pane}`);
    await Bun.sleep(50);
  }
}

describe.skipIf(!HAS_TMUX)("tmux transport (§4, §5.2, FR-5) [requires tmux]", () => {
  let session: string;

  beforeEach(() => {
    session = `muxeon-test-${randomUUID()}`;
  });

  afterEach(async () => {
    await killSession(session).catch(() => undefined); // ignore if already gone
  });

  test("newSession creates a live session; hasSession detects it; killSession ends it", async () => {
    expect(await hasSession(session)).toBe(false);
    await newSession(session, { command: ["sh"] });
    expect(await hasSession(session)).toBe(true);
    await killSession(session);
    expect(await hasSession(session)).toBe(false);
  });

  test("hasSession is false for an unknown session", async () => {
    expect(await hasSession(`absent-${randomUUID()}`)).toBe(false);
  });

  // §5.5 (FR-194): the session clock's only source of truth for a session Muxeon
  // did not raise itself. tmux answers in unix SECONDS — the ×1000 is the whole
  // reason this is worth a live test.
  test("sessionCreatedAt reads the session's birth time in unix ms", async () => {
    const before = Date.now();
    await newSession(session, { command: ["sh"] });
    const created = await sessionCreatedAt(session);
    expect(created).toBeDefined();
    // Second-resolution: the stamp can land up to a second before `before`.
    expect(created ?? 0).toBeGreaterThan(before - 2_000);
    expect(created ?? 0).toBeLessThan(Date.now() + 2_000);
  });

  test("sessionCreatedAt is undefined for an unknown session — never a fabricated time", async () => {
    expect(await sessionCreatedAt(`absent-${randomUUID()}`)).toBeUndefined();
  });

  test("sendLiteral delivers input and capturePane reads the pane", async () => {
    await newSession(session, { command: ["sh"] });
    await sendLiteral(session, "echo MUXEON_MARKER_42");
    await sendKeys(session, "Enter");
    expect(await waitForPane(session, /MUXEON_MARKER_42/)).toContain("MUXEON_MARKER_42");
  });

  test("literal text starting with '-' is not parsed as a tmux flag (-- guard)", async () => {
    await newSession(session, { command: ["sh"] });
    await sendLiteral(session, "-n --weird"); // would be a flag error without `--`
    expect(await waitForPane(session, /-n --weird/)).toContain("-n --weird");
  });

  test("session names are matched exactly — a longer-named session never bleeds in (the dev→devops bug)", async () => {
    // tmux resolves a bare `-t name` by PREFIX: with only `${session}ops` alive,
    // a naive `-t ${session}` would silently hit it. Every op must stay exact.
    const longer = `${session}ops`;
    try {
      await newSession(longer, { command: ["sh"] });
      // hasSession for the (absent) short name must NOT be fooled by `${longer}`:
      expect(await hasSession(session)).toBe(false);
      // capture/send to the absent short name must fail, not hit `${longer}`:
      await expect(capturePane(session)).rejects.toThrow();
      await expect(sendKeys(session, "Enter")).rejects.toThrow();

      // With both alive, a marker sent to the short name must not appear in `${longer}`:
      await newSession(session, { command: ["sh"] });
      await sendLiteral(session, "echo MUXEON_SHORT_ONLY_99");
      await sendKeys(session, "Enter");
      await waitForPane(session, /MUXEON_SHORT_ONLY_99/);
      expect(await capturePane(longer)).not.toContain("MUXEON_SHORT_ONLY_99");
    } finally {
      await killSession(longer).catch(() => undefined);
    }
  });

  test("newSession honors cwd", async () => {
    await newSession(session, { cwd: "/tmp", command: ["sh"] });
    await sendLiteral(session, "pwd");
    await sendKeys(session, "Enter");
    // macOS resolves /tmp to /private/tmp:
    expect(await waitForPane(session, /\/(private\/)?tmp/)).toMatch(/\/(private\/)?tmp/);
  });
});
