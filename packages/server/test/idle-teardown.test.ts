// Idle auto-teardown wired through bootstrap (FR-92, §5.1): a system-raised agent
// (auto-provisioned) with a resolved teardown.idle window is gracefully retired
// after the window of transport inactivity; an attached (external) agent is left
// alone; an agent without idle config is never registered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionControl } from "@teamai/lifecycle";
import type { SessionDriver } from "@teamai/orchestrator";
import { bootstrap } from "../src/bootstrap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-idle-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  const file = join(dir, "teamai.config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

/** A recording SessionControl that tracks created + killed sessions. */
function fakeControl() {
  const present = new Set<string>();
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
  return { control, created, killed };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const HOUR = 60 * 60 * 1000;

// teardown.idle on the TYPE (FR-66/FR-64 fallback) — exercises resolveTeardown's
// agent→type resolution for the idle window too. Idle-only ⇒ a hard kill.
function idleConfig(opts: { auto?: boolean } = {}) {
  return {
    server: { port: 0, mcp: false, cadence: { outputPollMs: 5 } },
    agents: [
      {
        name: "researcher",
        type: "claude",
        tmux: "researcher-session",
        provision: { command: "claude", ...(opts.auto !== undefined ? { auto: opts.auto } : {}) },
      },
    ],
    topology: { researcher: [] },
    types: { claude: { teardown: { idle: "1h" } } },
  };
}

describe("idle auto-teardown (FR-92, §5.1) — wired", () => {
  test("a system-raised agent is reaped after the inactivity window", async () => {
    const { control, created, killed } = fakeControl();
    let clock = 0;
    const server = await bootstrap({
      configFile: writeConfig(idleConfig({ auto: true })),
      probe: async () => false, // attach-miss → auto-provision raises it (origin "system")
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true, // dispatcher loops drain the teardown control-lane op
      startIdleTeardown: false, // drive the sweep manually via tick()
      idleTeardownNow: () => clock,
    });
    expect(created).toEqual(["researcher-session"]); // auto-provisioned at boot
    expect(server.status("researcher")).toBe("idle");
    expect(server.idleTeardown).toBeDefined();

    await server.idleTeardown?.tick(); // first sight — starts the clock at t=0
    clock = HOUR + 1; // past the window
    await server.idleTeardown?.tick(); // fires → lane op → graceful teardown (hard kill)

    await waitFor(() => killed.includes("researcher-session"));
    expect(server.status("researcher")).toBe("down");
    await server.stop();
  });

  test("an attached (external) agent is never reaped", async () => {
    const { control, killed } = fakeControl();
    let clock = 0;
    const server = await bootstrap({
      configFile: writeConfig(idleConfig()), // no auto
      probe: async () => true, // a live session → attach (origin "external")
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true,
      startIdleTeardown: false,
      idleTeardownNow: () => clock,
    });
    expect(server.status("researcher")).toBe("idle");
    expect(server.idleTeardown).toBeDefined(); // registered (idle configured)…

    await server.idleTeardown?.tick();
    clock = 10 * HOUR; // well past any window
    await server.idleTeardown?.tick();
    // …but never reaped — we only retire what we raised (origin "external").
    await new Promise((r) => setTimeout(r, 30));
    expect(killed).toEqual([]);
    expect(server.status("researcher")).toBe("idle");
    await server.stop();
  });

  test("no idle config → no sweeper is wired", async () => {
    const { control } = fakeControl();
    const server = await bootstrap({
      configFile: writeConfig({
        server: { port: 0, mcp: false },
        agents: [{ name: "researcher", type: "claude", tmux: "researcher-session" }],
        topology: { researcher: [] },
      }),
      probe: async () => true,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(server.idleTeardown).toBeUndefined();
    await server.stop();
  });
});
