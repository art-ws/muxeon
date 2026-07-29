import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CommandGrants, type CommandGrantsMap, Topology } from "@teamai/core";
import { Router } from "@teamai/orchestrator";
import { type AgentPlaneHandle, createAgentServer, startAgentPlane } from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// alice ─ bob, alice ─ op. dave is a NODE but NOT alice's neighbor (no edge), so a
// command to dave is UNKNOWN_PEER regardless of any grant — a command needs BOTH a
// topology edge and an ACL grant (FR-94, §10.2).
const TOPOLOGY = { alice: ["bob", "op"], bob: ["alice", "dave"], dave: ["bob"], op: ["alice"] };
// bob's command catalog (mergeCommands ∪ internal, FR-66/FR-67) — what list_commands
// intersects the grant against and what runCommand accepts.
const BOB_CATALOG = ["clear", "compact", "usage", "screenshot"];

const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

interface Harness {
  plane: AgentPlaneHandle;
  calls: Array<{ name: string; slash: string }>;
}

// Build an agent-plane wired with `grants`, a fixed bob catalog, and a recording
// runner. `busy` names a slash that the runner rejects (simulating the idle-guard /
// unknown-command refusal that lifecycleAdmin.command throws, FR-66).
function makePlane(grants: CommandGrantsMap, busy?: string): Harness {
  const topology = new Topology(TOPOLOGY);
  const router = new Router({ topology, root: "/tmp/teamai-unused", queueKeyOf: () => null });
  const calls: Array<{ name: string; slash: string }> = [];
  const plane = startAgentPlane({
    port: 0,
    isKnownIdentity: (n) => n === "alice" || n === "bob" || n === "dave" || n === "op",
    makeServer: (caller) =>
      createAgentServer(caller, {
        topology,
        router,
        peerStatus: () => "idle",
        commandGrants: new CommandGrants(grants),
        listCommands: (name) => (name === "bob" ? BOB_CATALOG : []),
        runCommand: async (name, slash) => {
          calls.push({ name, slash });
          if (slash === busy)
            throw new Error(`agent "${name}" is busy — commands need an idle session`);
          return `output of /${slash} on ${name}`;
        },
      }),
  });
  return { plane, calls };
}

describe.skipIf(!LOOPBACK_DIRECT)("agent-plane command tools (FR-94/FR-95, §8.6)", () => {
  let harness: Harness;
  let alice: Client;

  const connect = async (grants: CommandGrantsMap, busy?: string) => {
    harness = makePlane(grants, busy);
    alice = await connectClient(harness.plane.url, "alice");
  };

  afterEach(async () => {
    await alice?.close();
    await harness?.plane.stop();
  });

  test("list_commands returns the grant ∩ the recipient's catalog", async () => {
    await connect({ alice: { bob: ["clear", "compact"] } });
    expect(sc(await alice.callTool({ name: "list_commands", arguments: { to: "bob" } }))).toEqual({
      to: "bob",
      commands: ["clear", "compact"],
    });
  });

  test('list_commands resolves "*" to the recipient\'s full catalog', async () => {
    await connect({ alice: { bob: ["*"] } });
    expect(sc(await alice.callTool({ name: "list_commands", arguments: { to: "bob" } }))).toEqual({
      to: "bob",
      commands: BOB_CATALOG,
    });
  });

  test("list_commands is empty when nothing is granted", async () => {
    await connect({ alice: { bob: ["clear"] } });
    // op is a neighbor but has no grant → empty, not an error
    expect(sc(await alice.callTool({ name: "list_commands", arguments: { to: "op" } }))).toEqual({
      to: "op",
      commands: [],
    });
  });

  test("list_commands to a non-neighbor is UNKNOWN_PEER (§10.11)", async () => {
    await connect({ alice: { dave: ["clear"] } }); // grant cannot widen the graph
    const result = await alice.callTool({ name: "list_commands", arguments: { to: "dave" } });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
  });

  test("send_command runs a granted command and returns the captured output", async () => {
    await connect({ alice: { bob: ["clear", "compact"] } });
    const result = await alice.callTool({
      name: "send_command",
      arguments: { to: "bob", slash: "clear" },
    });
    expect(sc(result)).toEqual({ to: "bob", slash: "clear", output: "output of /clear on bob" });
    expect(harness.calls).toEqual([{ name: "bob", slash: "clear" }]);
  });

  test('"*" command grant lets any catalog command run', async () => {
    await connect({ alice: { bob: ["*"] } });
    const result = await alice.callTool({
      name: "send_command",
      arguments: { to: "bob", slash: "usage" },
    });
    expect(sc(result)).toEqual({ to: "bob", slash: "usage", output: "output of /usage on bob" });
  });

  test("a command outside the grant is COMMAND_DENIED and never runs", async () => {
    await connect({ alice: { bob: ["clear"] } });
    const result = await alice.callTool({
      name: "send_command",
      arguments: { to: "bob", slash: "usage" }, // in the catalog, NOT in the grant
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "COMMAND_DENIED" });
    expect(harness.calls).toEqual([]); // the runner was never reached
  });

  test("send_command to a non-neighbor is UNKNOWN_PEER even with a grant (§10.2)", async () => {
    await connect({ alice: { dave: ["clear"] } });
    const result = await alice.callTool({
      name: "send_command",
      arguments: { to: "dave", slash: "clear" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "UNKNOWN_PEER" });
    expect(harness.calls).toEqual([]);
  });

  test("a busy/refused recipient surfaces COMMAND_FAILED (not a false success)", async () => {
    await connect({ alice: { bob: ["clear"] } }, "clear");
    const result = await alice.callTool({
      name: "send_command",
      arguments: { to: "bob", slash: "clear" },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ error: "COMMAND_FAILED" });
  });
});
