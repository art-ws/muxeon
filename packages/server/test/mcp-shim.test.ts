// The durable agent-side shim (FR-89): the agent's stdio link stays up while the upstream
// agent-plane session is disposable — a server restart, or a server that isn't up yet, is
// ridden out by lazy connect + reconnect-on-failure, with no `muxeon restart <agent>`.
//
// Two layers: a deterministic suite drives the real shim Server (linked in-memory to a real
// SDK Client) over an INJECTED fake upstream that models a server epoch (restart) and a down
// state — so reconnect/cache/recovery are exercised without a network. A proxy-gated suite
// then proves the genuine HTTP reconnect by restarting a real agent-plane on the same port.

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Connect, SuperviseOptions, UpstreamClient } from "../src/mcp/shim";
import {
  Upstream,
  buildShim,
  exitWhenAgentGone,
  httpConnect,
  probeMsFromEnv,
} from "../src/mcp/shim";
import { type AgentPlaneHandle, startAgentPlane } from "../src/mcp/transport";
import { LOOPBACK_DIRECT } from "./mcp-helpers";

const TOOLS = [
  {
    name: "whoami",
    description: "echo identity",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// A fake agent-plane the test drives directly: `restart` bumps the epoch so live clients go
// stale (their next call 404s, just like a real server restart), while a fresh connect lands
// on the new epoch; `setDown` refuses connections and calls (server booting / crashed).
class FakePlane {
  up = true;
  epoch = 0;
  connects = 0;

  /** Server restarts on the same URL: existing sessions die, new ones succeed. */
  restart(): void {
    this.epoch++;
  }
  setDown(down: boolean): void {
    this.up = !down;
    if (!down) this.epoch++; // a recovered server is a new instance — old sessions are gone
  }

  readonly connect: Connect = async () => {
    this.connects++;
    if (!this.up) throw new Error("ECONNREFUSED");
    const epoch = this.epoch;
    const alive = (): boolean => this.up && epoch === this.epoch;
    const client: UpstreamClient = {
      listTools: async () => {
        if (!alive()) throw new Error("unknown session");
        return { tools: TOOLS };
      },
      callTool: async (args) => {
        if (!alive()) throw new Error("unknown session");
        return { content: [{ type: "text", text: `ok:${args.name}` }], structuredContent: args };
      },
      close: async () => {},
    };
    return client;
  };
}

/** Wire the real shim Server to a real SDK Client over an in-memory pipe. */
async function linkShim(
  connect: Connect,
): Promise<{ client: Client; supervise: (options?: SuperviseOptions) => Promise<void> }> {
  const { server, supervise } = buildShim(connect, "http://test/mcp");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "agent-cli", version: "0" });
  await client.connect(clientTransport);
  return { client, supervise };
}

describe("durable shim wiring (FR-89)", () => {
  test("forwards tools/list and tools/call from a live upstream verbatim", async () => {
    const plane = new FakePlane();
    const { client } = await linkShim(plane.connect);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "ok:whoami" }]);
    await client.close();
  });

  test("rides out a server restart on the next call — no manual reconnect", async () => {
    const plane = new FakePlane();
    const { client } = await linkShim(plane.connect);
    await client.callTool({ name: "whoami", arguments: {} }); // establishes a live session
    const connectsBefore = plane.connects;

    plane.restart(); // the live session is now stale (would 404)

    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "ok:whoami" }]);
    expect(plane.connects).toBe(connectsBefore + 1); // reconnected exactly once
    await client.close();
  });

  test("tools/list serves the last-known set during a momentary outage", async () => {
    const plane = new FakePlane();
    const { client } = await linkShim(plane.connect);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]); // caches

    plane.setDown(true);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]); // from cache
    await client.close();
  });

  test("a call while down returns a clean retryable error, then self-heals on recovery", async () => {
    const plane = new FakePlane();
    const { client } = await linkShim(plane.connect);
    await client.callTool({ name: "whoami", arguments: {} });

    plane.setDown(true);
    const errored = await client.callTool({ name: "whoami", arguments: {} });
    expect(errored.isError).toBe(true);
    expect((errored.structuredContent as { error?: string }).error).toBe("UPSTREAM_UNAVAILABLE");

    plane.setDown(false); // server back up
    const healed = await client.callTool({ name: "whoami", arguments: {} });
    expect(healed.isError ?? false).toBe(false);
    expect(healed.content).toEqual([{ type: "text", text: "ok:whoami" }]);
    await client.close();
  });

  test("tools/list errors (not empty) when the upstream has never connected", async () => {
    const plane = new FakePlane();
    plane.setDown(true); // never reachable, no cache to fall back to
    const { client } = await linkShim(plane.connect);
    await expect(client.listTools()).rejects.toThrow();
    await client.close();
  });

  test("emits tools/list_changed when the connection recovers after a gap", async () => {
    const plane = new FakePlane();
    plane.setDown(true); // shim starts before the server is reachable
    const { client } = await linkShim(plane.connect);

    let changed = 0;
    let signal!: () => void;
    const notified = new Promise<void>((resolve) => {
      signal = resolve;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
      signal();
    });

    await client.callTool({ name: "whoami", arguments: {} }); // fails — still degraded
    plane.setDown(false);
    await client.callTool({ name: "whoami", arguments: {} }); // connects → fires the notification

    await Promise.race([
      notified,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no notification")), 1000)),
    ]);
    expect(changed).toBeGreaterThanOrEqual(1);
    await client.close();
  });
});

describe("Upstream.run reconnect (FR-89)", () => {
  test("a cold connect failure propagates without a doomed retry", async () => {
    const plane = new FakePlane();
    plane.setDown(true);
    const upstream = new Upstream({ connect: plane.connect });
    await expect(upstream.run((c) => c.listTools())).rejects.toThrow(/ECONNREFUSED/);
    expect(plane.connects).toBe(1); // one attempt, not two — nothing live to retry against
  });

  test("onReady fires on recovery but not on the steady state", async () => {
    const plane = new FakePlane();
    let ready = 0;
    const upstream = new Upstream({ connect: plane.connect, onReady: () => ready++ });

    await upstream.run((c) => c.listTools()); // first connect after the degraded start
    expect(ready).toBe(1);
    await upstream.run((c) => c.listTools()); // already live — no signal
    expect(ready).toBe(1);

    plane.restart();
    await upstream.run((c) => c.listTools()); // stale → reconnect → recovery
    expect(ready).toBe(2);
  });
});

// ── T265 (FR-158): supervision — the session is restored WITHOUT the agent calling ──

describe("shim supervision (FR-158)", () => {
  /** A sleep the test drives: every wait is recorded and returns immediately, so the loop
   *  runs at full speed and its cadence is still observable. It yields through a real
   *  macrotask rather than a microtask — a resolved-promise await would let the loop spin
   *  inside the microtask queue and starve the test's own timers (it hangs, silently). */
  function fakeClock(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
    const waits: number[] = [];
    return {
      waits,
      sleep: (ms) => {
        waits.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
  }

  test("a session killed by a server restart comes back with no tool call at all", async () => {
    const plane = new FakePlane();
    const clock = fakeClock();
    const abort = new AbortController();
    const { client, supervise } = await linkShim(plane.connect);
    const loop = supervise({ probeMs: 10, sleep: clock.sleep, signal: abort.signal });

    // Let the loop establish the first connection.
    while (plane.connects < 1) await new Promise((r) => setTimeout(r, 1));
    const afterFirst = plane.connects;

    // The coordinator restarts. NOTHING calls a tool — this is the exact deadlock
    // found on the T261 deploy: the agent is handed the file contract, which never
    // touches MCP, so before FR-158 the session stayed dead forever.
    plane.restart();
    while (plane.connects <= afterFirst) await new Promise((r) => setTimeout(r, 1));
    expect(plane.connects).toBeGreaterThan(afterFirst); // repaired by the probe alone

    abort.abort();
    await loop;
    // and the agent's own path works against the fresh session
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
    await client.close();
  });

  test("keeps probing after the first success — the loop does not end there", async () => {
    const plane = new FakePlane();
    const clock = fakeClock();
    const abort = new AbortController();
    const { client, supervise } = await linkShim(plane.connect);
    const loop = supervise({ probeMs: 25, sleep: clock.sleep, signal: abort.signal });
    // Several probe intervals must elapse: the pre-FR-158 warm-up returned after one
    // success and slept never again.
    while (clock.waits.filter((ms) => ms === 25).length < 3) {
      await new Promise((r) => setTimeout(r, 1));
    }
    abort.abort();
    await loop;
    expect(clock.waits.filter((ms) => ms === 25).length).toBeGreaterThanOrEqual(3);
    await client.close();
  });

  test("probeMs 0 keeps the old warm-up shape: stop at the first success", async () => {
    const plane = new FakePlane();
    const clock = fakeClock();
    const { client, supervise } = await linkShim(plane.connect);
    await supervise({ probeMs: 0, sleep: clock.sleep }); // resolves — no endless loop
    expect(plane.connects).toBe(1);
    expect(clock.waits).toEqual([]); // connected first try, so nothing was ever waited on
    await client.close();
  });

  test("an unreachable plane backs off and recovers when it returns", async () => {
    const plane = new FakePlane();
    plane.setDown(true);
    const clock = fakeClock();
    const abort = new AbortController();
    const { supervise } = await linkShim(plane.connect);
    const loop = supervise({ probeMs: 10, sleep: clock.sleep, signal: abort.signal });

    while (clock.waits.length < 4) await new Promise((r) => setTimeout(r, 1));
    // backoff grows and is capped — a down server is not hammered
    expect(clock.waits.slice(0, 4)).toEqual([500, 1000, 2000, 4000]);

    plane.setDown(false);
    while (!clock.waits.includes(10)) await new Promise((r) => setTimeout(r, 1));
    abort.abort();
    await loop;
    expect(clock.waits.at(-1)).toBe(10); // back to the steady cadence, not the backoff
  });

  test("probeMsFromEnv: default, explicit disable, and junk falls back", () => {
    expect(probeMsFromEnv(undefined)).toBe(30_000);
    expect(probeMsFromEnv("")).toBe(30_000);
    expect(probeMsFromEnv("5000")).toBe(5000);
    expect(probeMsFromEnv("0")).toBe(0); // explicit opt-out
    // Junk must NOT read as 0 — silently disabling supervision is the one outcome
    // that recreates the deadlock this feature exists to prevent.
    expect(probeMsFromEnv("nonsense")).toBe(30_000);
    expect(probeMsFromEnv("-1")).toBe(30_000);
  });
});

// The other half of supervision: a shim that outlives its agent is not harmless.
// Every probe RE-REGISTERS the name upstream, so a ghost keeps taking the identity
// from the live shim, which takes it back — found on dev1 with four claimants and
// ~16 evictions a minute (T284). The stdio link is therefore also the lifetime.
describe("shim lifetime — the agent's link is the shim's (T284)", () => {
  test("the stdio link closing stops the shim", async () => {
    const plane = new FakePlane();
    const { server } = buildShim(plane.connect, "http://test/mcp");
    let stopped = 0;
    exitWhenAgentGone(server, () => {
      stopped += 1;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "agent-cli", version: "0" });
    await client.connect(clientTransport);

    expect(stopped).toBe(0); // the agent is there — the shim stays
    await client.close(); // the CLI agent exits / its session is killed
    while (stopped === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(stopped).toBe(1);
  });

  test("a handler already on the server still runs — the hook adds, never replaces", async () => {
    const plane = new FakePlane();
    const { server } = buildShim(plane.connect, "http://test/mcp");
    const calls: string[] = [];
    server.onclose = () => calls.push("existing");
    exitWhenAgentGone(server, () => calls.push("stop"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "agent-cli", version: "0" });
    await client.connect(clientTransport);
    await client.close();
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toEqual(["existing", "stop"]);
  });
});

// ── Real HTTP reconnect: proves the genuine path over the actual agent-plane transport ──

const KNOWN = new Set(["alice"]);

function echoServer(caller: string): Server {
  const server = new Server({ name: "muxeon", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echo the caller",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: caller }],
  }));
  return server;
}

describe.skipIf(!LOOPBACK_DIRECT)("durable shim over real MCP (FR-89)", () => {
  let plane: AgentPlaneHandle | undefined;

  async function start(port: number): Promise<AgentPlaneHandle> {
    // A just-stopped listener may not have released the port yet — retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        plane = startAgentPlane({
          port,
          makeServer: echoServer,
          isKnownIdentity: (n) => KNOWN.has(n),
        });
        return plane;
      } catch (error) {
        if (attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  afterEach(async () => {
    await plane?.stop();
    plane = undefined;
  });

  test("an upstream call survives a server restart on the same port, no manual reconnect", async () => {
    const first = await start(0);
    const url = `http://localhost:${first.port}/mcp`;
    const upstream = new Upstream({ connect: httpConnect("alice", url) });

    const before = await upstream.run((c) => c.callTool({ name: "echo", arguments: {} }));
    expect(before.content).toEqual([{ type: "text", text: "alice" }]);

    await first.stop(); // server restarts: the live session is now dead
    await start(first.port);

    const after = await upstream.run((c) => c.callTool({ name: "echo", arguments: {} }));
    expect(after.content).toEqual([{ type: "text", text: "alice" }]);
  });
});
