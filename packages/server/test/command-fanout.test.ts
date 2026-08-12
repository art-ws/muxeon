// Operator slash-command to a group/tag/agent INTERSECTION (§15.8, FR-115,
// invariant §10.18). Two layers: the pure `commandFanout` orchestration (aggregate
// shape, partial failure, empty/unknown handling) and the end-to-end wiring
// (bootstrap → admin route `POST /admin/agents/command` + the `muxeon command`
// CLI), proving the intersection reaches real agent consoles via the control-lane.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Adapter, AdapterRegistry } from "@muxeon/adapters";
import type { SessionControl } from "@muxeon/lifecycle";
import { buildBroadcastResolver, commandFanout } from "@muxeon/orchestrator";
import { type MuxeonServer, bootstrap } from "../src/bootstrap";
import { runCli } from "../src/cli/cli";

// ── unit: the pure orchestration (no server) ───────────────────────────────
describe("commandFanout (§15.8, FR-115)", () => {
  const groups = [{ name: "eng" }, { name: "devs", parent: "eng" }, { name: "qa", parent: "eng" }];
  const agents = [
    { name: "alice", group: "devs", tags: ["backend"] },
    { name: "bob", group: "devs", tags: ["frontend"] },
    { name: "carol", group: "qa", tags: ["backend"] },
  ];
  const resolveBroadcast = buildBroadcastResolver(groups, agents);
  const isAgent = (n: string): boolean => agents.some((a) => a.name === n);

  /** dispatch that succeeds for everyone except the names in `down`. */
  const deps = (down: readonly string[] = []) => {
    const calls: string[] = [];
    return {
      calls,
      resolveBroadcast,
      isAgent,
      dispatchOne: async (agent: string, slash: string) => {
        calls.push(agent);
        return down.includes(agent)
          ? { to: agent, ok: false as const, code: "COMMAND_FAILED", output: "agent is down" }
          : { to: agent, ok: true as const, output: `ran /${slash} on ${agent}` };
      },
    };
  };

  test("group ∩ tag → dispatch to the intersection only, aggregate shape", async () => {
    const d = deps();
    // devs={alice,bob} ∩ backend={alice,carol} → {alice}
    const r = await commandFanout("ping", ["devs", "backend"], d);
    expect(r).toEqual({
      ok: true,
      kind: "command-fanout",
      slash: "ping",
      selectors: ["devs", "backend"],
      targets: ["alice"],
      fanout: [{ to: "alice", ok: true, output: "ran /ping on alice" }],
    });
    expect(d.calls).toEqual(["alice"]); // dispatched exactly once, only to the intersection
  });

  test("a per-agent failure does NOT sink the fan-out", async () => {
    const r = await commandFanout("ping", ["devs"], deps(["bob"]));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.targets).toEqual(["alice", "bob"]);
    expect(r.fanout).toEqual([
      { to: "alice", ok: true, output: "ran /ping on alice" },
      { to: "bob", ok: false, code: "COMMAND_FAILED", output: "agent is down" },
    ]);
  });

  test("empty intersection → ok with an empty fanout (not an error)", async () => {
    const d = deps();
    const r = await commandFanout("ping", ["backend", "frontend"], d);
    expect(r).toEqual({
      ok: true,
      kind: "command-fanout",
      slash: "ping",
      selectors: ["backend", "frontend"],
      targets: [],
      fanout: [],
    });
    expect(d.calls).toEqual([]); // nothing dispatched
  });

  test("an unknown selector rejects the whole request", async () => {
    expect(await commandFanout("ping", ["devs", "nope"], deps())).toEqual({
      ok: false,
      code: "UNKNOWN_SELECTOR",
      message: "unknown selector(s): nope",
    });
  });

  test("an empty selector list is INVALID_ARGS", async () => {
    expect(await commandFanout("ping", [], deps())).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      message: "selectors[] must be a non-empty list",
    });
  });
});

// ── end-to-end: bootstrap → admin route + CLI ──────────────────────────────
function dummyRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return new AdapterRegistry([adapter]);
}

class FakeSessions implements SessionControl {
  readonly live = new Set<string>(["alice-s", "bob-s", "carol-s"]);
  async hasSession(name: string): Promise<boolean> {
    return this.live.has(name);
  }
  async newSession(name: string): Promise<void> {
    this.live.add(name);
  }
  async killSession(name: string): Promise<void> {
    this.live.delete(name);
  }
  async sendLiteral(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> {
    return "";
  }
}

describe("admin /agents/command + CLI (§15.8, end-to-end)", () => {
  let dir: string;
  let server: MuxeonServer;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "muxeon-cmdfan-"));
    out = [];
    err = [];
    const configFile = join(dir, "muxeon.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { port: 0, mcp: false, queueDir: "./queue" },
        agents: [
          {
            name: "alice",
            type: "dummy",
            tmux: "alice-s",
            provision: { command: ["dummy"] },
            group: "devs",
            tags: ["backend"],
            commands: [{ slash: "ping" }],
          },
          {
            name: "bob",
            type: "dummy",
            tmux: "bob-s",
            provision: { command: ["dummy"] },
            group: "devs",
            tags: ["frontend"],
            commands: [{ slash: "ping" }],
          },
          {
            name: "carol",
            type: "dummy",
            tmux: "carol-s",
            provision: { command: ["dummy"] },
            group: "qa",
            tags: ["backend"],
            commands: [{ slash: "ping" }],
          },
        ],
        groups: [{ name: "eng" }, { name: "devs", parent: "eng" }, { name: "qa", parent: "eng" }],
        topology: { alice: ["bob"] },
        channels: [],
      }),
    );
    server = await bootstrap({
      configFile,
      registry: dummyRegistry(),
      probe: (name) => new FakeSessions().hasSession(name),
      makeDriver: () => ({ inject: async () => undefined, awaitTurn: async () => undefined }),
      sessionControl: new FakeSessions(),
      startRoutines: false,
    });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown): Promise<Response> =>
    server.adminFetch(
      new Request(`${server.adminUrl}/agents/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("POST /admin/agents/command dispatches to the intersection", async () => {
    const res = await post({ slash: "ping", selectors: ["devs", "backend"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      targets: string[];
      fanout: { to: string; ok: boolean; output?: string }[];
    };
    expect(body.kind).toBe("command-fanout");
    expect(body.targets).toEqual(["alice"]); // devs ∩ backend
    expect(body.fanout).toEqual([{ to: "alice", ok: true, output: "" }]);
  });

  test("a down agent in the set comes back COMMAND_FAILED, others still run", async () => {
    // take bob down; the whole devs group is targeted
    await server.adminFetch(new Request(`${server.adminUrl}/agents/bob/kill`, { method: "POST" }));
    const res = await post({ slash: "ping", selectors: ["devs"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fanout: { to: string; ok: boolean; code?: string }[] };
    const byName = Object.fromEntries(body.fanout.map((e) => [e.to, e]));
    expect(byName.alice?.ok).toBe(true);
    expect(byName.bob?.ok).toBe(false);
    expect(byName.bob?.code).toBe("COMMAND_FAILED");
  });

  test("unknown selector → 400 UNKNOWN_SELECTOR; missing fields → 400", async () => {
    const bad = await post({ slash: "ping", selectors: ["devs", "ghost"] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("UNKNOWN_SELECTOR");

    const noSel = await post({ slash: "ping" });
    expect(noSel.status).toBe(400);
    const noSlash = await post({ selectors: ["devs"] });
    expect(noSlash.status).toBe(400);
  });

  test("muxeon command <slash> <selector…> prints targets + per-agent results", async () => {
    const code = await runCli(["--url", server.adminUrl, "command", "ping", "devs", "backend"], {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      fetchImpl: (req) => server.adminFetch(req),
    });
    expect(code).toBe(0);
    expect(out[0]).toBe("/ping → 1 agent(s): alice");
    expect(out[1]).toBe("  alice: ok");
  });
});
