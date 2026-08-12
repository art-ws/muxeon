import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type AgentStatus,
  type SessionAction,
  SessionGrants,
  type SessionGrantsMap,
  Topology,
} from "@muxeon/core";
import { Router } from "@muxeon/orchestrator";
import { type AgentPlaneHandle, createAgentServer, startAgentPlane } from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// alice ─ bob, alice ─ op. dave is a NODE but NOT alice's neighbor (no edge), so an
// action on dave is UNKNOWN_PEER regardless of any grant — control needs BOTH a
// topology edge and an ACL grant (FR-96, §10.2).
const TOPOLOGY = { alice: ["bob", "op"], bob: ["alice", "dave"], dave: ["bob"], op: ["alice"] };
// bob's applicable action catalog (FR-7/FR-96): bob has a provision command, so all
// five actions apply — what list_controls intersects the grant against.
const BOB_CATALOG: SessionAction[] = ["start", "stop", "shutdown", "restart", "reload"];

const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

interface Harness {
  plane: AgentPlaneHandle;
  calls: Array<{ name: string; action: SessionAction }>;
}

// Build an agent-plane wired with `grants`, a fixed bob catalog, and a recording
// runner. `busy` names an action the runner rejects (simulating the missing-provision
// / busy refusal that lifecycleAdmin throws, FR-7/FR-64).
function makePlane(grants: SessionGrantsMap, busy?: SessionAction): Harness {
  const topology = new Topology(TOPOLOGY);
  const router = new Router({ topology, root: "/tmp/muxeon-unused", queueKeyOf: () => null });
  const calls: Array<{ name: string; action: SessionAction }> = [];
  const plane = startAgentPlane({
    port: 0,
    isKnownIdentity: (n) => n === "alice" || n === "bob" || n === "dave" || n === "op",
    makeServer: (caller) =>
      createAgentServer(caller, {
        topology,
        router,
        peerStatus: () => "idle",
        sessionGrants: new SessionGrants(grants),
        listControls: (name) => (name === "bob" ? BOB_CATALOG : []),
        controlSession: async (name, action): Promise<AgentStatus> => {
          calls.push({ name, action });
          if (action === busy)
            throw new Error(`agent "${name}" has no provision command to start it`);
          return action === "stop" || action === "shutdown" ? "down" : "idle";
        },
      }),
  });
  return { plane, calls };
}

describe.skipIf(!LOOPBACK_DIRECT)("agent-plane session-control tools (FR-96/FR-97, §8.6)", () => {
  let harness: Harness;
  let alice: Client;

  const connect = async (grants: SessionGrantsMap, busy?: SessionAction) => {
    harness = makePlane(grants, busy);
    alice = await connectClient(harness.plane.url, "alice");
  };

  afterEach(async () => {
    await alice?.close();
    await harness?.plane.stop();
  });

  test("list_controls returns the grant ∩ the recipient's catalog", async () => {
    await connect({ alice: { bob: ["restart", "stop"] } });
    expect(sc(await alice.callTool({ name: "list_controls", arguments: { to: "bob" } }))).toEqual({
      to: "bob",
      actions: ["stop", "restart"], // catalog order preserved (filter over BOB_CATALOG)
    });
  });

  test('list_controls resolves "*" to the recipient\'s full catalog', async () => {
    await connect({ alice: { bob: ["*"] } });
    expect(sc(await alice.callTool({ name: "list_controls", arguments: { to: "bob" } }))).toEqual({
      to: "bob",
      actions: BOB_CATALOG,
    });
  });

  test("list_controls is empty when nothing is granted", async () => {
    await connect({ alice: { bob: ["restart"] } });
    // op is a neighbor but has no grant → empty, not an error
    expect(sc(await alice.callTool({ name: "list_controls", arguments: { to: "op" } }))).toEqual({
      to: "op",
      actions: [],
    });
  });

  test("list_controls to a non-neighbor is UNKNOWN_PEER (§10.11)", async () => {
    await connect({ alice: { dave: ["restart"] } }); // grant cannot widen the graph
    const result = await alice.callTool({ name: "list_controls", arguments: { to: "dave" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
  });

  test("control_session runs a granted action and returns the resulting status", async () => {
    await connect({ alice: { bob: ["restart"] } });
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "bob", action: "restart" },
    });
    expect(sc(result)).toEqual({ to: "bob", action: "restart", status: "idle" });
    expect(harness.calls).toEqual([{ name: "bob", action: "restart" }]);
  });

  test('"*" action grant lets any applicable action run', async () => {
    await connect({ alice: { bob: ["*"] } });
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "bob", action: "stop" },
    });
    expect(sc(result)).toEqual({ to: "bob", action: "stop", status: "down" });
  });

  test("an action outside the grant is CONTROL_DENIED and never runs", async () => {
    await connect({ alice: { bob: ["restart"] } });
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "bob", action: "stop" }, // applicable, NOT in the grant
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "CONTROL_DENIED" });
    expect(harness.calls).toEqual([]); // the runner was never reached
  });

  test("control_session to a non-neighbor is UNKNOWN_PEER even with a grant (§10.2)", async () => {
    await connect({ alice: { dave: ["restart"] } });
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "dave", action: "restart" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
    expect(harness.calls).toEqual([]);
  });

  test("an unknown action is INVALID_ARGS and never runs", async () => {
    await connect({ alice: { bob: ["*"] } });
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "bob", action: "nuke" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "INVALID_ARGS" });
    expect(harness.calls).toEqual([]);
  });

  test("a failed lifecycle op surfaces CONTROL_FAILED (not a false success)", async () => {
    await connect({ alice: { bob: ["start"] } }, "start");
    const result = await alice.callTool({
      name: "control_session",
      arguments: { to: "bob", action: "start" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "CONTROL_FAILED" });
  });
});
