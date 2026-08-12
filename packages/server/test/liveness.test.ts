// Liveness probe wired through bootstrap (FR-93, §5.1): a hand-started or
// hand-killed tmux session is reconciled into AgentState.status WITHOUT a server
// restart. The sweep's reconcile runs on the session's control lane (drained by the
// dispatcher loop), mirroring idle-teardown. Drives the sweep via tick() for
// determinism; the live scenario is the no-provision agent (e.g. `muxeon`) whose
// session the operator brings up by hand after the server booted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionControl } from "@muxeon/lifecycle";
import type { SessionDriver } from "@muxeon/orchestrator";
import { bootstrap } from "../src/bootstrap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-liveness-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  const file = join(dir, "muxeon.config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

/** A recording SessionControl whose `present` set is mutable to simulate hand start/kill. */
function fakeControl(initial: string[] = []) {
  const present = new Set<string>(initial);
  const created: string[] = [];
  const killed: string[] = [];
  const control: SessionControl = {
    hasSession: async (name) => present.has(name),
    newSession: async (name) => {
      created.push(name);
      present.add(name);
    },
    killSession: async (name) => {
      killed.push(name);
      present.delete(name);
    },
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    capturePane: async () => "",
  };
  return { control, present, created, killed };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A no-provision agent — the live `muxeon` case: the server only attaches, never
// raises it, so nothing flips its status to idle once its session appears.
function bareConfig() {
  return {
    server: { port: 0, mcp: false, cadence: { outputPollMs: 5 } },
    agents: [{ name: "muxeon", type: "claude", tmux: "muxeon-session" }],
    topology: { muxeon: [] },
  };
}

describe("liveness probe (FR-93, §5.1) — wired", () => {
  test("a down agent over a hand-started session is reconciled to idle (no restart)", async () => {
    const { control, present, created } = fakeControl(); // session absent at boot
    const server = await bootstrap({
      configFile: writeConfig(bareConfig()),
      probe: async () => false, // attach-miss → down at boot; no provision → stays down
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true, // dispatcher loop drains the reconcile control-lane op
      startLivenessProbe: false, // drive the sweep manually via tick()
    });
    expect(server.status("muxeon")).toBe("down");
    expect(server.liveness).toBeDefined();

    present.add("muxeon-session"); // operator starts it by hand AFTER the server booted
    await server.liveness?.tick(); // → lane op → reconcile down→idle

    await waitFor(() => server.status("muxeon") === "idle");
    expect(server.agents.get("muxeon")?.state.origin).toBe("external"); // not ours → FR-92 safe
    expect(created).toEqual([]); // attach-only: the sweep never provisioned/spawned
    await server.stop();
  });

  test("an idle agent whose session was killed by hand is reconciled to down", async () => {
    const { control, present } = fakeControl(["muxeon-session"]); // live at boot
    const server = await bootstrap({
      configFile: writeConfig(bareConfig()),
      probe: async () => true, // live session → attach → idle at boot
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true,
      startLivenessProbe: false,
    });
    expect(server.status("muxeon")).toBe("idle");

    present.delete("muxeon-session"); // operator kills it by hand
    await server.liveness?.tick(); // → lane op → reconcile idle→down

    await waitFor(() => server.status("muxeon") === "down");
    await server.stop();
  });
});
