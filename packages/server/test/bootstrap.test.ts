import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import type { SessionControl } from "@teamai/lifecycle";
import type { SessionDriver } from "@teamai/orchestrator";
import { queuePaths } from "@teamai/queue";
import { bootstrap } from "../src/bootstrap";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-server-"));
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

const CONFIG = {
  server: { port: 8080, mcp: false }, // these tests exercise boot/routing, not the MCP listener
  agents: [
    { name: "researcher", type: "claude", tmux: "researcher-session" },
    { name: "writer", type: "claude", tmux: "writer-session" },
  ],
  topology: { researcher: ["writer"], writer: ["researcher"] },
};

describe("server bootstrap (§8.2, FR-1/FR-7)", () => {
  test("an attach-miss leaves the agent down but the server still boots (FR-7)", async () => {
    const server = await bootstrap({
      configFile: writeConfig(CONFIG),
      probe: async () => false, // no live tmux session
      makeDriver: noopDriver,
      autoStart: false,
    });
    expect(server.status("researcher")).toBe("down");
    expect(server.status("writer")).toBe("down");
    expect(server.agents.size).toBe(2); // server is alive with both agents
    await server.stop();
  });

  test("a live session attaches as idle", async () => {
    const server = await bootstrap({
      configFile: writeConfig(CONFIG),
      probe: async () => true,
      makeDriver: noopDriver,
      autoStart: false,
    });
    expect(server.status("researcher")).toBe("idle");
    await server.stop();
  });

  test("exactly one dispatcher per agent, plus a router", async () => {
    const server = await bootstrap({
      configFile: writeConfig(CONFIG),
      probe: async () => false,
      makeDriver: noopDriver,
      autoStart: false,
    });
    expect([...server.agents.keys()].sort()).toEqual(["researcher", "writer"]);
    expect(server.router).toBeDefined();
    await server.stop();
  });

  test("routing through the booted server enqueues to the recipient (§8.2)", async () => {
    const server = await bootstrap({
      configFile: writeConfig(CONFIG),
      probe: async () => false,
      makeDriver: noopDriver,
      autoStart: false,
    });
    const result = await server.router.route({
      id: "m1",
      from: "researcher",
      to: "writer",
      kind: "message",
      ts: 0,
      payload: "hi",
    });
    expect(result.ok).toBe(true);
    await server.stop();
  });

  test("an unknown adapter type is rejected at boot (config §7.5)", async () => {
    const configFile = writeConfig({
      ...CONFIG,
      agents: [{ name: "x", type: "mystery", tmux: "x" }],
    });
    await expect(
      bootstrap({ configFile, probe: async () => false, makeDriver: noopDriver, autoStart: false }),
    ).rejects.toThrow();
  });
});

describe("rendezvous after a WIP strike (§8.2, FR-105)", () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const m = (from: string, to: string, id: string): Signal => ({
    id,
    from,
    to,
    kind: "message",
    ts: 0,
    payload: "hi",
  });
  // port 0 → OS-assigned, so this runs regardless of anything holding 8080.
  const rzConfig = {
    server: { port: 0, mcp: false, queueDir: "./queue" },
    agents: [
      { name: "researcher", type: "claude", tmux: "researcher-session" },
      { name: "writer", type: "claude", tmux: "writer-session", wipLimit: 1 },
    ],
    topology: { researcher: ["writer"], writer: ["researcher"] },
  };

  function noticesTo(root: string, tmux: string): Signal[] {
    const dirPath = queuePaths(root, tmux).pending;
    return readdirSync(dirPath)
      .map((f) => JSON.parse(readFileSync(join(dirPath, f), "utf8")) as Signal)
      .filter((s) => s.kind === "rendezvous");
  }

  test("a WIP-refused send registers an intent; the idle sender's target gets a bypass notice", async () => {
    const server = await bootstrap({
      configFile: writeConfig(rzConfig),
      probe: async () => true, // both attach idle
      makeDriver: noopDriver,
      autoStart: false, // nothing drains writer's queue → it stays at its WIP limit
    });
    expect(server.rendezvous).toBeDefined(); // enabled by default (FR-105)
    const root = join(dir, "queue");
    // fill writer to its WIP limit (1), then a second send is refused
    expect((await server.router.route(m("researcher", "writer", "m1"))).ok).toBe(true);
    const refused = await server.router.route(m("researcher", "writer", "m2"));
    expect(refused).toMatchObject({ ok: false, code: "WIP_LIMIT" });
    // researcher is idle → the onRefused fast-path notifies writer past its WIP gate
    await settle();
    const notices = noticesTo(root, "writer-session");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ from: "researcher", to: "writer", kind: "rendezvous" });
    await server.stop();
  });

  test("an accepted counter-send from the target clears the intent (no re-notify)", async () => {
    const server = await bootstrap({
      configFile: writeConfig(rzConfig),
      probe: async () => true,
      makeDriver: noopDriver,
      autoStart: false,
    });
    const root = join(dir, "queue");
    await server.router.route(m("researcher", "writer", "m1")); // fill writer
    await server.router.route(m("researcher", "writer", "m2")); // WIP strike → intent
    await settle();
    // writer replies to researcher (the counter-send B→A) → intent resolved
    await server.router.route(m("writer", "researcher", "reply1"));
    await settle();
    await server.rendezvous?.sweep(); // a further sweep must not emit a second notice
    await settle();
    expect(noticesTo(root, "writer-session")).toHaveLength(1); // still just the first
    await server.stop();
  });
});

describe("auto-provision (FR-50/FR-51, §5.1)", () => {
  /** A recording SessionControl whose newSession can be made to fail. */
  function fakeControl(opts: { newThrows?: boolean } = {}) {
    const present = new Set<string>();
    const created: string[] = [];
    const control: SessionControl = {
      hasSession: async (name) => present.has(name),
      newSession: async (name) => {
        if (opts.newThrows) throw new Error("provision exploded");
        created.push(name);
        present.add(name);
      },
      killSession: async (name) => {
        present.delete(name);
      },
      sendLiteral: async () => undefined,
      sendKeys: async () => undefined,
      capturePane: async () => "",
    };
    return { control, created };
  }

  function provisionedConfig(auto: boolean | undefined) {
    return {
      server: { port: 8080, mcp: false, cadence: { outputPollMs: 5 } },
      agents: [
        {
          name: "researcher",
          type: "claude",
          tmux: "researcher-session",
          provision: { command: "claude", ...(auto !== undefined ? { auto } : {}) },
        },
        { name: "writer", type: "claude", tmux: "writer-session" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    };
  }

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("provision.auto=true provisions on attach-miss at boot (FR-50)", async () => {
    const { control, created } = fakeControl();
    const server = await bootstrap({
      configFile: writeConfig(provisionedConfig(true)),
      probe: async () => false,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(created).toEqual(["researcher-session"]); // only the auto agent
    expect(server.status("researcher")).toBe("idle");
    expect(server.status("writer")).toBe("down"); // no provision block — plain attach-miss
    await server.stop();
  });

  test("a provision block WITHOUT auto does not provision at boot", async () => {
    const { control, created } = fakeControl();
    const server = await bootstrap({
      configFile: writeConfig(provisionedConfig(undefined)),
      probe: async () => false,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(created).toEqual([]);
    expect(server.status("researcher")).toBe("down");
    await server.stop();
  });

  test("a failed startup auto-provision is a warning, not a fatal (FR-50)", async () => {
    const { control } = fakeControl({ newThrows: true });
    const server = await bootstrap({
      configFile: writeConfig(provisionedConfig(true)),
      probe: async () => false,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: false,
    });
    expect(server.status("researcher")).toBe("down"); // stays down, server is alive
    await server.stop();
  });

  test("a routed message lazily revives a down provision-configured agent (FR-51)", async () => {
    const { control, created } = fakeControl();
    const server = await bootstrap({
      configFile: writeConfig(provisionedConfig(undefined)), // no auto — lazy only
      probe: async () => false,
      makeDriver: noopDriver,
      sessionControl: control,
      autoStart: true, // the dispatcher loop drives the revive
    });
    expect(server.status("researcher")).toBe("down");
    const result = await server.router.route({
      id: "m1",
      from: "writer",
      to: "researcher",
      kind: "message",
      ts: 0,
      payload: "wake up",
    });
    expect(result.ok).toBe(true);
    await waitFor(() => server.status("researcher") !== "down");
    expect(created).toEqual(["researcher-session"]); // revived by its own dispatcher
    await waitFor(() => server.status("researcher") === "idle");
    await server.stop();
  });
});
