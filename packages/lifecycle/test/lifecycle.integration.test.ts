// Checkpoint 5 integration: drive the real tmux-backed lifecycle end-to-end —
// provision a fresh session, send a slash command into it, kill it (→down), restart
// it (→idle). Gated on a real tmux (skipped in CI without it), like the walking
// skeleton. The provision command is a bare `cat`: it stays alive (keeps the session
// up) and echoes typed input so the slash command is observable in the pane.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "@teamai/adapters";
import type { AgentConfig } from "@teamai/config";
import { AgentState } from "@teamai/orchestrator";
import { capturePane, hasSession, hasTmux, killSession } from "@teamai/tmux";
import type { AgentTarget } from "../src";
import { attach, kill, provision, restart, sendSlash, tmuxSessionControl } from "../src";

const HAS_TMUX = await hasTmux();
const control = tmuxSessionControl;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!HAS_TMUX)("lifecycle against real tmux (Checkpoint 5) [requires tmux]", () => {
  let stateDir: string;
  let configDir: string;
  let session: string;
  let target: AgentTarget;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "teamai-lc-state-"));
    configDir = mkdtempSync(join(tmpdir(), "teamai-lc-cfg-"));
    session = `teamai-lc-${randomUUID()}`;
    const agent: AgentConfig = {
      name: "dummy",
      type: "claude",
      tmux: session,
      provision: { command: ["cat"] }, // stays alive, echoes input — argv, no shell (§8.7)
    };
    target = { agent, adapter: createClaudeAdapter({ stateDir }), state: new AgentState("down") };
  });

  afterEach(async () => {
    await killSession(session).catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test("attach to a missing session reports down (not fatal)", async () => {
    expect(await attach(target, control)).toBe("down");
  });

  test("provision → slash → kill (down) → restart (idle)", async () => {
    // provision: a fresh, live session in <config_dir>; agent config untouched —
    // nothing is written outside the session itself (FR-11b, §5.2)
    expect(await provision(target, { control, configDir })).toBe("idle");
    expect(await hasSession(session)).toBe(true);
    expect(existsSync(join(stateDir, "adapters"))).toBe(false); // no hook install, no state writes

    // slash command lands in the pane (cat echoes it)
    await sendSlash(target, { control, name: "help" });
    await waitFor(async () => (await capturePane(session)).includes("/help"));

    // kill → down, session gone
    expect(await kill(target, control)).toBe("down");
    await waitFor(async () => !(await hasSession(session)));

    // restart → idle, session back up
    expect(await restart(target, { control, configDir })).toBe("idle");
    expect(await hasSession(session)).toBe(true);
  });
});
