// Checkpoint 6 (§3.1): two agents discover each other and coordinate THROUGH the
// booted server — config → attach → agent-plane → list_peers / send. Proves the
// bootstrap wiring (peerStatus, isKnownIdentity, the plane on server.port). Gated on
// loopback-direct like the other network tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDriver } from "@teamai/orchestrator";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<
    string,
    unknown
  >;
}

function planeUrl(server: TeamaiServer): string {
  const plane = server.agentPlane;
  if (plane === undefined) throw new Error("expected an agent plane");
  return plane.url;
}

describe.skipIf(!LOOPBACK_DIRECT)("§3.1 two-agent coordination via the booted server", () => {
  let dir: string;
  let server: TeamaiServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamai-scenario-"));
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(config: unknown): Promise<TeamaiServer> {
    const configFile = join(dir, "teamai.config.json");
    writeFileSync(configFile, JSON.stringify(config));
    return bootstrap({
      configFile,
      probe: async () => true,
      makeDriver: noopDriver,
      autoStart: false,
    });
  }

  test("peers discover each other, send over the edge; a non-edge is denied", async () => {
    server = await boot({
      server: { port: 0, queueDir: "./queue" }, // mcp defaults true
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher" },
        { name: "writer", type: "claude", tmux: "writer" },
        { name: "loner", type: "claude", tmux: "loner" }, // not in topology → isolated
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    });

    const researcher = await connectClient(planeUrl(server), "researcher");
    try {
      // discovery: researcher sees only writer (loner is not a neighbor)
      expect(structured(await researcher.callTool({ name: "list_peers", arguments: {} }))).toEqual({
        // `paused` (§16.5, FR-119) rides beside the status — nothing is paused here.
        peers: [{ name: "writer", type: "agent", status: "idle", paused: false }],
      });

      // coordinate over the edge → enqueued into writer's queue
      const sent = await researcher.callTool({
        name: "send",
        arguments: { to: "writer", payload: "please draft this" },
      });
      expect(structured(sent).queued).toBe(true);
      const writerPending = readdirSync(join(dir, "queue", "writer", "pending")).filter((n) =>
        n.endsWith(".json"),
      );
      expect(writerPending).toHaveLength(1);

      // a non-edge is refused, nothing enqueued
      const denied = await researcher.callTool({
        name: "send",
        arguments: { to: "loner", payload: "x" },
      });
      expect(denied.isError).toBe(true);
      expect(structured(denied)).toEqual({ error: "TOPOLOGY_DENIED" });
    } finally {
      await researcher.close();
    }
  });

  test("an unknown agent cannot initialize (§8.6)", async () => {
    server = await boot({
      server: { port: 0 },
      agents: [{ name: "researcher", type: "claude", tmux: "researcher" }],
      topology: {},
    });
    await expect(connectClient(planeUrl(server), "intruder")).rejects.toThrow(
      /unknown agent identity/i,
    );
  });
});
