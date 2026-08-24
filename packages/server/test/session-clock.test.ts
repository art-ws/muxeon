// The session clock wired through bootstrap (T331, §5.5, FR-194/FR-195). The unit
// tests own the clock's arithmetic (orchestrator/status.test.ts); what has to hold
// HERE is that the three witnesses are actually connected: the attach reads the
// session's real birth time off tmux instead of stamping "now", the router's single
// delivery point feeds both ends of every routed signal, and a session found by the
// liveness probe (FR-93) is dated by tmux too, not by the tick that noticed it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionControl } from "@muxeon/lifecycle";
import type { SessionDriver } from "@muxeon/orchestrator";
import { bootstrap } from "../src/bootstrap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-clock-"));
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

function fakeControl(initial: string[] = []) {
  const present = new Set<string>(initial);
  const control: SessionControl = {
    hasSession: async (name) => present.has(name),
    newSession: async (name) => {
      present.add(name);
    },
    killSession: async (name) => {
      present.delete(name);
    },
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    capturePane: async () => "",
  };
  return { control, present };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Two wired agents — enough for a routed signal to have two ends. */
function pairConfig() {
  return {
    server: { port: 0, mcp: false, cadence: { outputPollMs: 5 } },
    agents: [
      { name: "a", type: "claude", tmux: "a-session" },
      { name: "b", type: "claude", tmux: "b-session" },
    ],
    topology: { a: ["b"], b: ["a"] },
  };
}

// A session born long before this server booted — the number a stamp taken at
// attach time could never produce.
const BORN = 1_700_000_000_000;

describe("session clock, wired (§5.5, FR-194/FR-195)", () => {
  test("an attached session is dated by tmux, not by the moment we noticed it", async () => {
    const { control } = fakeControl(["a-session", "b-session"]);
    const server = await bootstrap({
      configFile: writeConfig(pairConfig()),
      probe: async () => true, // live at boot → attach → idle
      sessionStartedAt: async (name) => (name === "a-session" ? BORN : undefined),
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(server.agents.get("a")?.state.startedAt).toBe(BORN);
    // tmux could not answer for b — an unknown start time stays ABSENT rather than
    // being filled in with a plausible-looking "now" (§10.34).
    expect(server.agents.get("b")?.state.startedAt).toBeUndefined();
    await server.stop();
  });

  test("a down agent has no start time at all", async () => {
    const { control } = fakeControl();
    const server = await bootstrap({
      configFile: writeConfig(pairConfig()),
      probe: async () => false,
      sessionStartedAt: async () => BORN, // never consulted: there is no session
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(server.status("a")).toBe("down");
    expect(server.agents.get("a")?.state.startedAt).toBeUndefined();
    expect(server.agents.get("a")?.state.clock.signals).toEqual({});
    await server.stop();
  });

  test("a routed signal stamps BOTH ends — the single delivery point feeds the clock", async () => {
    const { control } = fakeControl(["a-session", "b-session"]);
    const server = await bootstrap({
      configFile: writeConfig(pairConfig()),
      probe: async () => true,
      sessionStartedAt: async () => BORN,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    const before = Date.now();
    await server.router.route({
      id: "c-1",
      from: "a",
      to: "b",
      kind: "message",
      ts: before,
      payload: "ping",
    });
    for (const name of ["a", "b"]) {
      const clock = server.agents.get(name)?.state.clock;
      expect(clock?.lastActivity).toBe("transport");
      expect(clock?.signals.transport).toBeGreaterThanOrEqual(before);
    }
    await server.stop();
  });

  test("a hand-started session found by the probe is dated by tmux too (FR-93)", async () => {
    const { control, present } = fakeControl(); // nothing up at boot
    const server = await bootstrap({
      configFile: writeConfig(pairConfig()),
      probe: async () => false,
      sessionStartedAt: async () => BORN,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true, // the dispatcher loop drains the reconcile lane op
      startLivenessProbe: false, // drive the sweep by hand
    });
    present.add("a-session"); // started by a hand, minutes before the tick notices
    await server.liveness?.tick();
    await waitFor(() => server.status("a") === "idle");
    await waitFor(() => server.agents.get("a")?.state.startedAt === BORN);
    // Coming up is itself a sign of life — but the START time is tmux's, not the tick's.
    expect(server.agents.get("a")?.state.clock.signals.session).toBeGreaterThan(BORN);
    await server.stop();
  });
});
