// The operator's view of deferred self-chains (§21.7, FR-192), end-to-end through
// bootstrap: what an agent armed for itself is visible from outside, and can be
// disarmed from outside. That is not a convenience — this subsystem types into
// live panes by the clock, and the agent that armed it may have cleared its own
// memory of doing so.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@muxeon/adapters";
import { createFsScheduleStore } from "@muxeon/schedules";
import { type MuxeonServer, bootstrap } from "../src/bootstrap";

function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

let dir: string;
let server: MuxeonServer;

const call = async (
  method: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await server.adminFetch(new Request(`${server.adminUrl}${path}`, { method }));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "muxeon-admin-schedules-"));
  const configFile = join(dir, "muxeon.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue" },
      agents: [{ name: "researcher", type: "dummy", tmux: "researcher-s" }],
      topology: { researcher: [] },
      channels: [],
      schedules: { maxItems: 4 },
    }),
  );
  server = await bootstrap({
    configFile,
    registry: dummyRegistry(),
    probe: async () => true,
    makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
    startRoutines: false, // the tick stays off; this is about the view, not the firing
  });
  // Arm something the way an agent would, straight into the same store the
  // server reads — the planning path has its own tests (mcp-schedules).
  await createFsScheduleStore(join(dir, "state")).write({
    id: "self-heal",
    agent: "researcher",
    created: Date.now(),
    items: [
      { index: 0, kind: "message", at: Date.now() + 60_000, state: "pending", text: "save" },
      { index: 1, kind: "command", at: Date.now() + 120_000, state: "pending", command: "clear" },
    ],
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET/DELETE /admin/schedules (§21.7)", () => {
  test("the operator sees what is armed, item by item", async () => {
    const { status, json } = await call("GET", "/schedules");
    expect(status).toBe(200);
    const chains = json.schedules as { id: string; agent: string; items: unknown[] }[];
    expect(chains).toHaveLength(1);
    expect(chains[0]?.agent).toBe("researcher");
    expect(chains[0]?.items).toHaveLength(2);
  });

  test("the agent filter narrows, and an agent with nothing armed is empty, not an error", async () => {
    expect((await call("GET", "/schedules?agent=researcher")).json.schedules).toHaveLength(1);
    expect((await call("GET", "/schedules?agent=nobody")).json.schedules).toEqual([]);
  });

  test("one item can be disarmed without the rest", async () => {
    const { json } = await call("DELETE", "/schedules/researcher/self-heal?index=1");
    expect(json).toEqual({ id: "self-heal", cancelled: 1 });
    const chains = (await call("GET", "/schedules")).json.schedules as {
      items: { state: string }[];
    }[];
    expect(chains[0]?.items.map((item) => item.state)).toEqual(["pending", "cancelled"]);
  });

  test("the whole chain goes in one call", async () => {
    expect((await call("DELETE", "/schedules/researcher/self-heal")).json.cancelled).toBe(2);
  });

  // A refusal is a status and a code, never a 200 that did nothing.
  test("cancelling what is not there is a 404 that says so", async () => {
    const { status, json } = await call("DELETE", "/schedules/researcher/ghost");
    expect(status).toBe(404);
    expect(json.code).toBe("UNKNOWN_SCHEDULE");
    expect(json.error).toContain("ghost");
  });

  test("a non-integer index is refused before anything is touched", async () => {
    const { status } = await call("DELETE", "/schedules/researcher/self-heal?index=half");
    expect(status).toBe(400);
    const chains = (await call("GET", "/schedules")).json.schedules as {
      items: { state: string }[];
    }[];
    expect(chains[0]?.items.every((item) => item.state === "pending")).toBe(true);
  });
});
