// Checkpoint 7 wiring: a central routine fires through the BOOTED server (§6, §8.2).
// The scheduler starts after the dispatchers, discovers <config_dir>/routines/<agent>,
// and on its first tick sends the once routine's signal via the router into the
// agent's own queue (self-delivery, from==to, no edge needed §10.2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDriver } from "@teamai/orchestrator";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for the routine signal");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("routine scheduler wired into the server (§6, §8.2)", () => {
  let dir: string;
  let server: TeamaiServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamai-routsrv-"));
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a once routine fires on boot and lands in the owner's queue", async () => {
    writeFileSync(
      join(dir, "teamai.config.json"),
      JSON.stringify({
        server: { port: 0, queueDir: "./queue", mcp: false },
        agents: [{ name: "researcher", type: "claude", tmux: "researcher" }],
        topology: {},
      }),
    );
    mkdirSync(join(dir, "routines", "researcher"), { recursive: true });
    writeFileSync(
      join(dir, "routines", "researcher", "kick.md"),
      "---\nid: kick\nschedule: once\n---\ngood morning",
    );

    server = await bootstrap({
      configFile: join(dir, "teamai.config.json"),
      probe: async () => false, // agent down — the signal still queues for its return (§5.1)
      makeDriver: noopDriver,
      autoStart: false, // no dispatcher draining; we inspect pending/ directly
    });

    const pending = join(dir, "queue", "researcher", "pending");
    await waitFor(() => readdirSync(pending).some((n) => n.endsWith(".json")));

    const files = readdirSync(pending).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const signal = JSON.parse(readFileSync(join(pending, files[0] ?? ""), "utf8"));
    expect(signal).toMatchObject({ from: "researcher", to: "researcher", payload: "good morning" });
    expect(signal.id).toBe("routine:researcher:kick:once"); // deterministic (§10.9)
  });
});
