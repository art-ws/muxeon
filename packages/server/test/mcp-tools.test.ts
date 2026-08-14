import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentStatus } from "@muxeon/core";
import { Topology } from "@muxeon/core";
import {
  type BlobStore,
  Router,
  TransportLog,
  createBlobStore,
  ensureSessionQueue,
} from "@muxeon/orchestrator";
import { ingestAttachments } from "../src/attach";
import {
  type AgentPlaneHandle,
  SCREEN_MAX_HISTORY_LINES,
  createAgentServer,
  startAgentPlane,
} from "../src/mcp";
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
  let seedTransport: (record: import("@muxeon/core").Signal) => Promise<boolean>;
  // FR-157 (T261): the turn-closing hook `send` calls after a delivered reply.
  let closeTurnCalls: { caller: string; replyTo: string }[];
  let openTurns: Set<string>;
  // FR-159 (T269): the dir attachments must stay inside, and a real blob store.
  let attachRoot: string;
  let blobs: BlobStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "muxeon-tools-"));
    closeTurnCalls = [];
    openTurns = new Set(["turn-1"]);
    attachRoot = mkdtempSync(join(tmpdir(), "muxeon-attach-"));
    blobs = await createBlobStore(join(root, "blobs"));
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
          closeTurn: async (caller, replyTo) => {
            closeTurnCalls.push({ caller, replyTo });
            return openTurns.delete(replyTo);
          },
          // FR-159 (T269): real ingest over a real blob store, contained to a temp
          // dir — the point of the tests below is the CONTAINMENT, so faking it out
          // would test nothing.
          attach: async (_caller, files) => {
            const refs = await ingestAttachments(files, {
              containRoots: [attachRoot],
              filesBase: attachRoot,
              blobs,
            });
            return typeof refs === "string" ? refs : [...refs];
          },
        }),
    });
    seedTransport = (record) => transportLog.append(record);
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(attachRoot, { recursive: true, force: true });
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

  // --- T261 (FR-157, §13.6): a delivered reply also ends the caller's turn ------

  test("a reply closes the caller's own turn and says so in the receipt", async () => {
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "op", payload: "the answer", id: "r1", replyTo: "turn-1" },
    });
    expect(sc(result)).toEqual({ id: "r1", queued: true, turnClosed: true });
    // scoped to the CALLER — an agent can only ever close its own turn (§10.10)
    expect(closeTurnCalls).toEqual([{ caller: "alice", replyTo: "turn-1" }]);
  });

  test("a replyTo that names no live turn is reported, not an error", async () => {
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "op", payload: "late", id: "r2", replyTo: "already-closed" },
    });
    expect(result.isError).toBeFalsy(); // the message WAS delivered
    expect(sc(result)).toEqual({ id: "r2", queued: true, turnClosed: false });
  });

  test("a send without replyTo never closes a turn and keeps its receipt shape", async () => {
    expect(
      sc(await alice.callTool({ name: "send", arguments: { to: "bob", payload: "hi", id: "m2" } })),
    ).toEqual({ id: "m2", queued: true });
    expect(closeTurnCalls).toEqual([]);
  });

  test("a REFUSED send leaves the turn open — the agent still holds the floor", async () => {
    // dave is not alice's neighbour → TOPOLOGY_DENIED before any delivery. The
    // turn must survive: closing it on a failed send would strand the answer.
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "dave", payload: "nope", id: "r3", replyTo: "turn-1" },
    });
    expect(result.isError).toBe(true);
    expect(closeTurnCalls).toEqual([]);
    expect(openTurns.has("turn-1")).toBe(true);
  });

  // --- T269 (FR-159, §12.5): files ride along with `send` -----------------------

  test("files become §12.5 blob refs beside the text, and the bytes are stored", async () => {
    writeFileSync(join(attachRoot, "report.txt"), "report-bytes");
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "готово", id: "a1", files: ["report.txt"] },
    });
    expect(sc(result)).toMatchObject({ id: "a1", queued: true });
    const enqueued = readOnly(root, "bob-s");
    const payload = enqueued.payload as {
      text: string;
      blobs: { blob: string; name: string; mime: string; size: number }[];
    };
    // the text survives as `text` — the recipient reads the same envelope the
    // exchange reply and the outbox produce
    expect(payload.text).toBe("готово");
    expect(payload.blobs).toHaveLength(1);
    expect(payload.blobs[0]).toMatchObject({ name: "report.txt", mime: "text/plain", size: 12 });
    // and the ref points at real bytes in the store, not just a name
    const stored = await blobs.read(payload.blobs[0]?.blob ?? "");
    expect(new TextDecoder().decode(stored)).toBe("report-bytes");
  });

  test("a path outside the containment roots is refused — and nothing is delivered", async () => {
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "not yours");
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "стащу", id: "a2", files: [outside] },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ error: "ATTACH_FAILED" });
    // Ingest runs BEFORE routing on purpose: a refusal must not leave a delivered
    // message whose promised attachment is missing.
    expect(pendingFiles(root, "bob-s")).toHaveLength(0);
  });

  test("all-or-nothing: one bad path in a list fails the whole send", async () => {
    writeFileSync(join(attachRoot, "good.txt"), "ok");
    const result = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "два файла", id: "a3", files: ["good.txt", "missing.txt"] },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ error: "ATTACH_FAILED" });
    expect(pendingFiles(root, "bob-s")).toHaveLength(0); // not even the good one
  });

  test("files validates its shape, and a send without files is byte-identical to before", async () => {
    const junk = await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "x", id: "a4", files: "report.txt" },
    });
    expect(sc(junk)).toMatchObject({ error: "INVALID_ARGS" });
    // no `files` key ⇒ the payload passes through untouched (a plain string)
    await alice.callTool({
      name: "send",
      arguments: { to: "bob", payload: "просто текст", id: "a5" },
    });
    expect(readOnly(root, "bob-s").payload).toBe("просто текст");
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
    root = mkdtempSync(join(tmpdir(), "muxeon-gt-"));
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
    root = mkdtempSync(join(tmpdir(), "muxeon-pause-plane-"));
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

// get_screen (T214, FR-147): a neighbour's console AS TEXT — the point is that an
// agent can SEE what a peer is actually doing instead of inferring it from a
// status. Observation only: the tool has no way to type, send or mutate anything
// (§10.8), the topology edge is the whole gate (§10.2), and only an agent has a
// console at all.
describe.skipIf(!LOOPBACK_DIRECT)("get_screen (§8.6, FR-147)", () => {
  let plane: AgentPlaneHandle;
  let alice: Client;
  let root: string;
  /** What the wired port was asked for — the caps/arguments are asserted through it. */
  let asked: { name: string; historyLines?: number }[];
  let panes: Record<string, string | Error>;
  let statuses: Record<string, AgentStatus>;
  let kinds: Record<string, "agent" | "group" | "tag" | "user">;

  const start = (withPort = true): void => {
    const topology = new Topology(TOPOLOGY);
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in KEY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router: new Router({ topology, root, queueKeyOf: (n) => KEY[n] ?? null }),
          peerStatus: (n) => statuses[n],
          peerType: (n) => kinds[n] ?? "agent",
          ...(withPort
            ? {
                screen: async (name: string, historyLines?: number) => {
                  asked.push(historyLines === undefined ? { name } : { name, historyLines });
                  const pane = panes[name];
                  if (pane instanceof Error) throw pane;
                  return pane ?? "";
                },
              }
            : {}),
        }),
    });
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "muxeon-screen-"));
    for (const key of Object.values(KEY)) await ensureSessionQueue(root, key);
    asked = [];
    panes = { bob: "> waiting for input\n$ ", op: "" };
    statuses = { alice: "idle", bob: "busy", dave: "idle", op: "idle" };
    kinds = {};
    start();
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("a neighbour's visible pane comes back as text", async () => {
    const result = sc(await alice.callTool({ name: "get_screen", arguments: { name: "bob" } }));
    expect(result).toEqual({ name: "bob", screen: "> waiting for input\n$ " });
    // default = the VISIBLE screen: no scrollback is pulled unless asked for
    expect(asked).toEqual([{ name: "bob", historyLines: 0 }]);
  });

  test("scrollback is opt-in and capped (one call cannot drag a whole session over)", async () => {
    await alice.callTool({ name: "get_screen", arguments: { name: "bob", historyLines: 120 } });
    await alice.callTool({ name: "get_screen", arguments: { name: "bob", historyLines: 99_999 } });
    expect(asked.map((call) => call.historyLines)).toEqual([120, SCREEN_MAX_HISTORY_LINES]);
  });

  test("neighbour-scope (§10.11): a non-neighbour, self or an unknown name is UNKNOWN_PEER", async () => {
    for (const name of ["dave", "alice", "ghost"]) {
      const result = await alice.callTool({ name: "get_screen", arguments: { name } });
      expect(result.isError).toBe(true);
      expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
    }
    expect(asked).toEqual([]); // nothing was captured — the gate is BEFORE the port
  });

  test("only an agent has a console: a person/group/tag is NOT_CAPTURABLE (§17.7/§15.5)", async () => {
    kinds = { bob: "user" };
    const result = await alice.callTool({ name: "get_screen", arguments: { name: "bob" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "NOT_CAPTURABLE" });
    expect(asked).toEqual([]);
  });

  test("a down neighbour answers AGENT_DOWN, not an empty screen", async () => {
    statuses = { ...statuses, bob: "down" };
    const result = await alice.callTool({ name: "get_screen", arguments: { name: "bob" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "AGENT_DOWN" });
    expect(asked).toEqual([]);
  });

  test("a PAUSED neighbour is still observable — pause gates delivery, not watching (§16)", async () => {
    // the pause flag never reaches this tool: capture is read-only either way
    const result = sc(await alice.callTool({ name: "get_screen", arguments: { name: "bob" } }));
    expect(result.screen).toBe("> waiting for input\n$ ");
  });

  test("a failing capture surfaces as SCREEN_FAILED, never as a fake empty pane", async () => {
    panes = { ...panes, bob: new Error("can't find pane: bob-s") };
    const result = await alice.callTool({ name: "get_screen", arguments: { name: "bob" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "SCREEN_FAILED" });
  });

  test("junk arguments are refused before anything is captured", async () => {
    for (const args of [
      { name: 7 },
      { name: "bob", historyLines: -1 },
      { name: "bob", historyLines: 1.5 },
    ]) {
      const result = await alice.callTool({ name: "get_screen", arguments: args });
      expect(sc(result)).toEqual({ error: "INVALID_ARGS" });
    }
    expect(asked).toEqual([]);
  });

  test("without a wired port the tool is UNAVAILABLE, not an empty success", async () => {
    await alice.close();
    await plane.stop();
    start(false);
    alice = await connectClient(plane.url, "alice");
    const result = await alice.callTool({ name: "get_screen", arguments: { name: "bob" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNAVAILABLE" });
  });
});
