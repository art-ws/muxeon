import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentStatus } from "@teamai/core";
import { Topology } from "@teamai/core";
import { Router, TransportLog, ensureSessionQueue } from "@teamai/orchestrator";
import { type AgentPlaneHandle, createAgentServer, startAgentPlane } from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// alice ─ bob ─ dave, and alice ─ op (operator). dave is a NODE but not alice's
// neighbor (→ TOPOLOGY_DENIED); op is an operator (peer status always idle, §5.3).
const TOPOLOGY = { alice: ["bob", "op"], bob: ["alice", "dave"], dave: ["bob"], op: ["alice"] };
const KEY: Record<string, string> = { alice: "alice-s", bob: "bob-s", dave: "dave-s", op: "op" };
const STATUS: Record<string, AgentStatus> = { alice: "idle", bob: "down", dave: "idle" };

function pendingFiles(root: string, key: string): string[] {
  return readdirSync(join(root, key, "pending")).filter((n) => n.endsWith(".json"));
}

function readOnly(root: string, key: string): Record<string, unknown> {
  const files = pendingFiles(root, key);
  return JSON.parse(readFileSync(join(root, key, "pending", files[0] ?? ""), "utf8"));
}

// callTool's result is a union (one legacy member has no structuredContent) — take
// unknown and narrow.
const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

describe.skipIf(!LOOPBACK_DIRECT)("agent-plane tools (§8.6, §3.1)", () => {
  let root: string;
  let plane: AgentPlaneHandle;
  let alice: Client;
  let seedTransport: (record: import("@teamai/core").Signal) => Promise<boolean>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "teamai-tools-"));
    for (const key of Object.values(KEY)) await ensureSessionQueue(root, key);
    const topology = new Topology(TOPOLOGY);
    const router = new Router({ topology, root, queueKeyOf: (n) => KEY[n] ?? null });
    const peerStatus = (n: string): AgentStatus | undefined =>
      STATUS[n] ?? (n === "op" ? "idle" : undefined);
    const transportLog = new TransportLog({ root });
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in KEY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router,
          peerStatus,
          pairHistory: (me, peer, limit) => transportLog.pair(me, peer, limit),
        }),
    });
    seedTransport = (record) => transportLog.append(record);
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("whoami echoes the declared identity", async () => {
    expect(sc(await alice.callTool({ name: "whoami", arguments: {} }))).toEqual({ name: "alice" });
  });

  test("list_peers returns neighbors (agents + operators) with type + status + paused", async () => {
    // `paused` (§16.5, FR-119) rides beside the status — read-only for the plane.
    expect(sc(await alice.callTool({ name: "list_peers", arguments: {} }))).toEqual({
      peers: [
        { name: "bob", type: "agent", status: "down", paused: false },
        // operator peer is an agent, always idle (§5.3) and never pausable (§16.1)
        { name: "op", type: "agent", status: "idle", paused: false },
      ],
    });
  });

  test("get_status reads a neighbor's status and its pause flag", async () => {
    expect(sc(await alice.callTool({ name: "get_status", arguments: { name: "bob" } }))).toEqual({
      status: "down",
      paused: false,
    });
  });

  test("get_status is neighbor-scoped: a non-neighbor / self / unknown is UNKNOWN_PEER (§10.11)", async () => {
    for (const name of ["dave", "alice", "ghost"]) {
      const result = await alice.callTool({ name: "get_status", arguments: { name } });
      expect(result.isError).toBe(true);
      expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
    }
  });

  test("get_history returns the pair's dialogue (both directions, depth-limited) — FR-87", async () => {
    const base = Date.now();
    const wire = (id: string, from: string, to: string, i: number) =>
      seedTransport({ id, from, to, kind: "message", ts: base + i, payload: `m-${id}` });
    await wire("h-1", "alice", "bob", 0);
    await wire("h-2", "bob", "alice", 1);
    await wire("h-3", "bob", "dave", 2); // another pair — invisible
    await wire("h-4", "alice", "bob", 3);
    const all = sc(await alice.callTool({ name: "get_history", arguments: { peer: "bob" } }));
    expect((all.records as { id: string }[]).map((r) => r.id)).toEqual(["h-1", "h-2", "h-4"]);
    const last = sc(
      await alice.callTool({ name: "get_history", arguments: { peer: "bob", limit: 2 } }),
    );
    expect((last.records as { id: string }[]).map((r) => r.id)).toEqual(["h-2", "h-4"]);
  });

  test("get_history is neighbor-scoped (§10.11) and validates its args", async () => {
    const denied = await alice.callTool({ name: "get_history", arguments: { peer: "dave" } });
    expect(sc(denied)).toEqual({ error: "UNKNOWN_PEER" });
    const junk = await alice.callTool({
      name: "get_history",
      arguments: { peer: "bob", limit: 0 },
    });
    expect(sc(junk)).toEqual({ error: "INVALID_ARGS" });
  });

  test("get_history without a wired history port is UNAVAILABLE, not an empty success", async () => {
    const bare = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in KEY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology: new Topology(TOPOLOGY),
          router: new Router({
            topology: new Topology(TOPOLOGY),
            root,
            queueKeyOf: (n) => KEY[n] ?? null,
          }),
          peerStatus: () => "idle",
        }),
    });
    try {
      const client = await connectClient(bare.url, "alice");
      const result = await client.callTool({ name: "get_history", arguments: { peer: "bob" } });
      expect(sc(result)).toEqual({ error: "UNAVAILABLE" });
      await client.close();
    } finally {
      await bare.stop();
    }
  });

  test("send to a neighbor enqueues with the session's identity as from (§8.6)", async () => {
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "hi", id: "m1" },
    });
    expect(sc(result)).toEqual({ id: "m1", queued: true });
    const enqueued = readOnly(root, "bob-s");
    expect(enqueued.from).toBe("alice"); // identity is the session's, not caller-supplied
    expect(enqueued.to).toBe("bob");
    expect(enqueued.payload).toBe("hi");
    expect(enqueued.kind).toBe("message");
  });

  test("send to an operator peer lands in its pseudo-session (ready for channels, §8.6)", async () => {
    await alice.callTool({ name: "send", arguments: { to: "op", payload: "report" } });
    expect(pendingFiles(root, "op")).toHaveLength(1);
  });

  test("send across a non-edge is TOPOLOGY_DENIED, not success (§10.2)", async () => {
    const result = await alice.callTool({ name: "send", arguments: { to: "dave", payload: "x" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "TOPOLOGY_DENIED" });
    expect(pendingFiles(root, "dave-s")).toHaveLength(0); // nothing enqueued
  });

  test("send to an unknown name is UNKNOWN_PEER", async () => {
    const result = await alice.callTool({ name: "send", arguments: { to: "ghost", payload: "x" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
  });

  test("send without a payload is rejected (INVALID_ARGS)", async () => {
    const result = await alice.callTool({ name: "send", arguments: { to: "bob" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "INVALID_ARGS" });
  });
});

// §15.5 (FR-111): a group/tag is an input-only peer — it carries a `type`, has no
// status/console/session, and `send` to it fans out. alice ─ eng (group {m1,m2}) and
// alice ─ it (tag {m1}). m1/m2 are agents with queues but not alice's direct neighbors.
describe.skipIf(!LOOPBACK_DIRECT)("agent-plane groups & tags (§15.5)", () => {
  const GT_KEY: Record<string, string> = { alice: "alice-s", m1: "m1-s", m2: "m2-s" };
  const GT_TOPOLOGY = { alice: ["eng", "it"] };
  let root: string;
  let plane: AgentPlaneHandle;
  let alice: Client;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "teamai-gt-"));
    for (const key of Object.values(GT_KEY)) await ensureSessionQueue(root, key);
    const topology = new Topology(GT_TOPOLOGY);
    const resolveBroadcast = (to: string): { kind: "group" | "tag"; members: string[] } | null => {
      if (to === "eng") return { kind: "group", members: ["m1", "m2"] };
      if (to === "it") return { kind: "tag", members: ["m1"] };
      return null;
    };
    const router = new Router({
      topology,
      root,
      queueKeyOf: (n) => GT_KEY[n] ?? null,
      resolveBroadcast,
    });
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in GT_KEY || n === "eng" || n === "it",
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router,
          peerStatus: (n) => (n in GT_KEY ? "idle" : undefined),
          peerType: (n) => resolveBroadcast(n)?.kind ?? "agent",
        }),
    });
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("list_peers reports the group/tag type and OMITS status", async () => {
    expect(sc(await alice.callTool({ name: "list_peers", arguments: {} }))).toEqual({
      peers: [
        { name: "eng", type: "group" },
        { name: "it", type: "tag" },
      ],
    });
  });

  test("send to a group fans out to members and returns the fanout aggregate", async () => {
    const result = sc(
      await alice.callTool({
        name: "send",
        arguments: { to: "eng", payload: "all hands", id: "b" },
      }),
    );
    expect(result).toMatchObject({
      id: "b",
      queued: true,
      fanout: [
        { to: "m1", id: "b:m1", ok: true },
        { to: "m2", id: "b:m2", ok: true },
      ],
    });
    expect(pendingFiles(root, "m1-s")).toHaveLength(1);
    expect(pendingFiles(root, "m2-s")).toHaveLength(1);
  });

  test("get_status on a group is NOT_STATUSABLE (no fake status)", async () => {
    const result = await alice.callTool({ name: "get_status", arguments: { name: "eng" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "NOT_STATUSABLE" });
  });

  test("send_command / control_session / list_commands / list_controls to a group are UNKNOWN_PEER", async () => {
    for (const [name, args] of [
      ["send_command", { to: "eng", slash: "help" }],
      ["control_session", { to: "eng", action: "restart" }],
      ["list_commands", { to: "eng" }],
      ["list_controls", { to: "it" }],
    ] as const) {
      const result = await alice.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
    }
  });
});

// Pause on the agent plane (§16.5, FR-119): READ-ONLY. A caller sees that a
// neighbour is paused (get_status / list_peers) and gets a clear AGENT_PAUSED
// refusal from send — but no tool sets or clears the flag (§10.10 intact).
describe.skipIf(!LOOPBACK_DIRECT)("agent-plane × pause (§16.5, FR-119)", () => {
  let root: string;
  let plane: AgentPlaneHandle;
  let alice: Client;
  const paused = new Set<string>();

  beforeEach(async () => {
    paused.clear();
    root = mkdtempSync(join(tmpdir(), "teamai-pause-plane-"));
    for (const key of Object.values(KEY)) await ensureSessionQueue(root, key);
    const topology = new Topology(TOPOLOGY);
    const router = new Router({
      topology,
      root,
      queueKeyOf: (n) => KEY[n] ?? null,
      isPaused: (n) => paused.has(n),
    });
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in KEY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router,
          peerStatus: (n) => STATUS[n] ?? (n === "op" ? "idle" : undefined),
          peerPaused: (n) => paused.has(n),
        }),
    });
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("get_status / list_peers surface a neighbour's pause beside its status", async () => {
    paused.add("bob");
    expect(sc(await alice.callTool({ name: "get_status", arguments: { name: "bob" } }))).toEqual({
      status: "down",
      paused: true,
    });
    expect(sc(await alice.callTool({ name: "list_peers", arguments: {} }))).toMatchObject({
      peers: [
        { name: "bob", paused: true },
        { name: "op", paused: false },
      ],
    });
  });

  test("send to a paused neighbour is an AGENT_PAUSED error and enqueues nothing", async () => {
    paused.add("bob");
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "you there?", id: "p1" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ error: "AGENT_PAUSED" });
    expect(JSON.stringify(result.content)).toContain("discarded");
    expect(pendingFiles(root, "bob-s")).toHaveLength(0);
  });

  test("the same id delivers after the resume — the refusal poisoned nothing", async () => {
    paused.add("bob");
    expect(
      (await alice.callTool({ name: "send", arguments: { to: "bob", payload: "x", id: "same" } }))
        .isError,
    ).toBe(true);
    paused.delete("bob");
    const retry = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "x", id: "same" },
    });
    expect(retry.isError).toBeFalsy();
    expect(pendingFiles(root, "bob-s")).toHaveLength(1);
  });

  test("no tool can SET the flag — the plane stays read-only (§10.10)", async () => {
    const tools = (await alice.listTools()).tools.map((tool) => tool.name);
    expect(tools).not.toContain("pause");
    expect(tools.some((name) => name.includes("pause"))).toBe(false);
  });
});
