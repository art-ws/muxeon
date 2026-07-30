// Users mode end-to-end through the composition root (§17, FR-121…FR-135): a
// user is a full participant — own queue (§5.3), own egress whose sink is their
// history (§17.5), presence derived from outgoing traffic (FR-133), DND through
// the shared pause registry (FR-134), and membership in group broadcasts (FR-130).
//
// The panel port is 0 (ephemeral) so the suite never collides with a stand.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import type { SessionDriver } from "@teamai/orchestrator";
import { bootstrap } from "../src/bootstrap";

// Unprivileged high ports unlikely to collide; every boot takes a FRESH one, so a
// panel that is still winding down can never block the next test.
let nextPanelPort = 19100 + Math.floor(Math.random() * 800);
const panelPort = (): number => nextPanelPort++;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-users-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noopDriver = (): SessionDriver => ({
  inject: async () => undefined,
  awaitTurn: async () => undefined,
});

const CONFIG = {
  server: { port: 0, mcp: false, queueDir: "./queue", presenceTtl: "1h" },
  agents: [{ name: "dev", type: "claude", tmux: "dev-session", group: "engineering" }],
  groups: [{ name: "engineering" }],
  users: [
    {
      name: "alex",
      displayName: "Alexander",
      role: "admin",
      group: "engineering",
      auth: { password: "alex-pw" },
      channels: { web: true },
    },
    { name: "kim", auth: { password: "kim-pw" }, channels: { web: true } },
  ],
  channels: [{ name: "web", type: "webchat", auth: { mode: "users" } }],
  topology: { alex: ["dev", "kim", "engineering"], kim: ["dev"] },
};

/** Stamps a fresh panel port onto the (users-mode) webchat channel of a config. */
function withPanelPort(config: unknown): unknown {
  const record = config as { channels?: { type: string }[] };
  return {
    ...record,
    channels: (record.channels ?? []).map((channel) =>
      channel.type === "webchat" ? { ...channel, port: panelPort() } : channel,
    ),
  };
}

function writeConfig(config: unknown = CONFIG): string {
  const file = join(dir, "teamai.config.json");
  writeFileSync(file, JSON.stringify(withPanelPort(config)));
  return file;
}

async function boot(config: unknown = CONFIG) {
  return bootstrap({
    configFile: writeConfig(config),
    env: (name) => (name === "TG_TOKEN" ? "token-value" : undefined),
    probe: async () => true,
    makeDriver: noopDriver,
    autoStart: false,
    startRoutines: false,
    startRetention: false,
  });
}

const historyFile = (user: string, peer: string): string =>
  join(dir, "webchat", "history", user, `${peer}.jsonl`);

const readHistory = (user: string, peer: string): Signal[] =>
  readFileSync(historyFile(user, peer), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Signal);

describe("users as participants (§17.1/§17.5, FR-121/FR-124)", () => {
  test("every user gets a pseudo-session queue of their own (§5.3)", async () => {
    const server = await boot();
    expect(existsSync(join(dir, "queue", "alex", "pending"))).toBe(true);
    expect(existsSync(join(dir, "queue", "kim", "pending"))).toBe(true);
    expect([...server.users.keys()]).toEqual(["alex", "kim"]);
    await server.stop();
  });

  test("an agent's message to a user lands in the user's history — the sink (§17.5)", async () => {
    const server = await boot();
    const routed = await server.router.route({
      id: "m1",
      from: "dev",
      to: "alex",
      kind: "message",
      ts: 1,
      payload: "the build is green",
    });
    expect(routed.ok).toBe(true);
    // one drain of the user's egress: history append IS the delivery
    expect(await server.users.get("alex")?.egress.pump()).toBe(1);
    expect(readHistory("alex", "dev").map((r) => r.payload)).toEqual(["the build is green"]);
    // …and the record is completed out of the queue (§5.3)
    expect(readdirSync(join(dir, "queue", "alex", "pending"))).toEqual([]);
    expect(readdirSync(join(dir, "queue", "alex", "done"))).toHaveLength(1);
    await server.stop();
  });

  test("user → user is an ordinary edge, and the note reaches the recipient (FR-123)", async () => {
    const server = await boot();
    expect((await server.router.route(mkMessage("alex", "kim", "u1"))).ok).toBe(true);
    await server.users.get("kim")?.egress.pump();
    expect(readHistory("kim", "alex")).toHaveLength(1);
    await server.stop();
  });

  test("a user with no edge to the target is refused (§10.2 still rules)", async () => {
    // zoe is declared but wired to nobody — the topology is undirected, so this
    // is the only way to have two users that genuinely cannot reach each other.
    const server = await boot({
      ...CONFIG,
      users: [...CONFIG.users, { name: "zoe", auth: { password: "zoe-pw" } }],
    });
    expect(await server.router.route(mkMessage("kim", "zoe", "u2"))).toEqual({
      ok: false,
      code: "TOPOLOGY_DENIED",
    });
    await server.stop();
  });

  test("a note to SELF needs no edge and lands in the user's own pair log (§17.7)", async () => {
    const server = await boot();
    expect((await server.router.route(mkMessage("kim", "kim", "n1"))).ok).toBe(true);
    await server.users.get("kim")?.egress.pump();
    expect(readHistory("kim", "kim").map((r) => r.payload)).toEqual(["hi"]);
    await server.stop();
  });

  test("a duplicate delivery is written once (§10.9 dedup at the sink)", async () => {
    const server = await boot();
    await server.router.route(mkMessage("dev", "alex", "dup"));
    await server.users.get("alex")?.egress.pump();
    await server.router.route(mkMessage("dev", "alex", "dup"));
    await server.users.get("alex")?.egress.pump();
    expect(readHistory("alex", "dev")).toHaveLength(1);
    await server.stop();
  });
});

describe("presence (§17.5, FR-133)", () => {
  test("a user is offline until they send, then online (sliding window)", async () => {
    const server = await boot();
    expect(server.presence.presence("alex")).toBe("offline");
    await server.router.route(mkMessage("alex", "dev", "p1"));
    expect(server.presence.presence("alex")).toBe("online");
    expect(server.presence.onlineUsers()).toEqual(["alex"]);
    await server.stop();
  });

  test("an agent's traffic does not make a user look online", async () => {
    const server = await boot();
    await server.router.route(mkMessage("dev", "alex", "p2"));
    expect(server.presence.presence("alex")).toBe("offline");
    await server.stop();
  });
});

describe("groups and broadcast (§17.5, FR-130)", () => {
  test("a broadcast to a group reaches its USER members too", async () => {
    const server = await boot();
    const result = await server.router.route({
      id: "b1",
      from: "alex",
      to: "engineering",
      kind: "message",
      ts: 1,
      payload: "standup in 5",
    });
    expect(result.ok).toBe(true);
    if (!("fanout" in result)) throw new Error("expected a broadcast receipt");
    // the sender excludes itself; the agent and no one else is left in this group
    expect(result.fanout.map((entry) => entry.to)).toEqual(["dev"]);

    // kim joins the group → the copy reaches their pseudo-session
    await server.stop();
    const withKim = await boot({
      ...CONFIG,
      users: [CONFIG.users[0], { ...CONFIG.users[1], group: "engineering" }],
      topology: CONFIG.topology,
    });
    const second = await withKim.router.route({
      id: "b2",
      from: "alex",
      to: "engineering",
      kind: "message",
      ts: 1,
      payload: "standup in 5",
    });
    if (!("fanout" in second)) throw new Error("expected a broadcast receipt");
    expect(second.fanout.map((entry) => entry.to)).toEqual(["dev", "kim"]);
    await withKim.users.get("kim")?.egress.pump();
    expect(readHistory("kim", "alex").map((r) => r.kind)).toEqual(["broadcast"]);
    await withKim.stop();
  });
});

describe("DND through the shared registry (§17.8, FR-134)", () => {
  test("pausing a user refuses others but not their own notes, and survives a restart", async () => {
    const server = await boot();
    const paused = await server.adminFetch(
      new Request("http://localhost/admin/agents/kim/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: true }),
      }),
    );
    expect(paused.status).toBe(200);
    expect(await server.router.route(mkMessage("dev", "kim", "d1"))).toEqual({
      ok: false,
      code: "AGENT_PAUSED",
    });
    expect((await server.router.route(mkMessage("kim", "kim", "d2"))).ok).toBe(true);
    // §16.4: the declaration is persisted under the SHARED registry
    expect(JSON.parse(readFileSync(join(dir, "state", "paused.json"), "utf8"))).toEqual({
      version: 1,
      paused: ["kim"],
    });
    await server.stop();

    const restarted = await boot();
    expect(await restarted.router.route(mkMessage("dev", "kim", "d3"))).toEqual({
      ok: false,
      code: "AGENT_PAUSED",
    });
    await restarted.stop();
  });
});

describe("legacy compatibility (§17.9, FR-132)", () => {
  test("a config with no users[] boots exactly as before", async () => {
    const server = await boot({
      server: { port: 0, mcp: false, queueDir: "./queue" },
      agents: [{ name: "dev", type: "claude", tmux: "dev-session" }],
      channels: [{ type: "telegram", bindOperator: "op", token: { $env: "TG_TOKEN" } }],
      topology: { op: ["dev"] },
    });
    expect(server.users.size).toBe(0);
    expect([...server.channels.keys()]).toEqual(["op"]);
    await server.stop();
  });
});

function mkMessage(from: string, to: string, id: string): Signal {
  return { id, from, to, kind: "message", ts: 1, payload: "hi" };
}
