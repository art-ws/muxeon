// The reaction pair on the agent plane (§19.7, FR-167): `list_reactions` reads the
// declared palette, `react` marks ONE message in a chat the caller is already part
// of. The gate is the topology edge and nothing else (the get_screen stance,
// FR-147) — and every refusal is a NAMED code, never a silent success.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Topology } from "@muxeon/core";
import { Router, ensureSessionQueue } from "@muxeon/orchestrator";
import {
  type AgentPlaneHandle,
  type ReactionPlane,
  createAgentServer,
  startAgentPlane,
} from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// alice (an agent) talks to shagin (a human) and to bob (an agent); dave is a node
// but not a neighbour. `team` is a group: input-only, no chat of its own (§15.5).
const TOPOLOGY = {
  alice: ["bob", "shagin", "team"],
  bob: ["alice"],
  dave: ["bob"],
  shagin: ["alice"],
};
const KEY: Record<string, string> = { alice: "alice-s", bob: "bob-s", shagin: "shagin" };

const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

const errorOf = (result: unknown): string =>
  String((sc(result) as { error?: unknown }).error ?? "");

describe.skipIf(!LOOPBACK_DIRECT)("list_reactions / react (§19.7, FR-167)", () => {
  let root: string;
  let plane: AgentPlaneHandle;
  let alice: Client;
  let calls: Parameters<ReactionPlane["react"]>[0][];
  let outcome: Awaited<ReturnType<ReactionPlane["react"]>>;
  let wired: boolean;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "muxeon-mcp-reactions-"));
    calls = [];
    wired = true;
    outcome = { ok: true, reactions: [{ key: "ok", count: 1 }] };
    for (const key of Object.values(KEY)) await ensureSessionQueue(root, key);
    const topology = new Topology(TOPOLOGY);
    const router = new Router({ topology, root, queueKeyOf: (n) => KEY[n] ?? null });
    const reactions: ReactionPlane = {
      catalog: () => ({
        categories: [{ name: "feedback", title: "Feedback" }],
        items: [
          { key: "ok", emoji: "👍", label: "Accepted", category: "feedback" },
          { key: "fire", emoji: "🔥" },
        ],
      }),
      react: async (input) => {
        calls.push(input);
        return outcome;
      },
    };
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n in KEY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router,
          peerStatus: (n) => (n === "shagin" ? undefined : "idle"),
          peerType: (n) => (n === "shagin" ? "user" : n === "team" ? "group" : "agent"),
          ...(wired ? { reactions } : {}),
        }),
    });
    alice = await connectClient(plane.url, "alice");
  });

  afterEach(async () => {
    await alice?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("both tools are on the surface, with the palette but no Recent order", async () => {
    const names = (await alice.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_reactions");
    expect(names).toContain("react");
    const catalog = sc(await alice.callTool({ name: "list_reactions", arguments: {} }));
    expect(catalog).toEqual({
      categories: [{ name: "feedback", title: "Feedback" }],
      items: [
        { key: "ok", emoji: "👍", label: "Accepted", category: "feedback" },
        { key: "fire", emoji: "🔥" },
      ],
    });
    expect(catalog).not.toHaveProperty("recent"); // a picker affordance, not an agent's
  });

  test("react maps the pair as (owner = the human, peer = the caller)", async () => {
    const result = await alice.callTool({
      name: "react",
      arguments: { peer: "shagin", messageId: "m1", key: "ok" },
    });
    expect(result.isError).toBeFalsy();
    expect(sc(result)).toEqual({
      peer: "shagin",
      messageId: "m1",
      key: "ok",
      reactions: [{ key: "ok", count: 1 }],
    });
    expect(calls).toEqual([
      { owner: "shagin", peer: "alice", actor: "alice", messageId: "m1", key: "ok" },
    ]);
  });

  test("remove:true is passed through — an agent takes back its OWN reaction", async () => {
    await alice.callTool({
      name: "react",
      arguments: { peer: "shagin", messageId: "m1", key: "ok", remove: true },
    });
    expect(calls[0]).toMatchObject({ remove: true });
  });

  test("a non-neighbour is UNKNOWN_PEER and never reaches the hub (§10.2)", async () => {
    const result = await alice.callTool({
      name: "react",
      arguments: { peer: "dave", messageId: "m1", key: "ok" },
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toBe("UNKNOWN_PEER");
    expect(calls).toEqual([]);
  });

  test("a group/tag peer is NOT_REACTABLE — one-directional, no chat (§19.10)", async () => {
    const result = await alice.callTool({
      name: "react",
      arguments: { peer: "team", messageId: "m1", key: "ok" },
    });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toBe("NOT_REACTABLE");
    expect(calls).toEqual([]);
  });

  test("an FQN peer is NOT_REACTABLE — reactions stay local (§10.24)", async () => {
    const result = await alice.callTool({
      name: "react",
      arguments: { peer: "bob@remote", messageId: "m1", key: "ok" },
    });
    expect(result.isError).toBe(true);
    expect(["NOT_REACTABLE", "UNKNOWN_PEER"]).toContain(errorOf(result));
    expect(calls).toEqual([]);
  });

  test("the hub's refusal codes surface verbatim (§19.7)", async () => {
    for (const code of [
      "UNKNOWN_MESSAGE",
      "UNKNOWN_REACTION",
      "NOT_REACTABLE",
      "REACTION_DENIED",
      "REACTIONS_DISABLED",
    ]) {
      outcome = { ok: false, code, message: `refused: ${code}` };
      const result = await alice.callTool({
        name: "react",
        arguments: { peer: "shagin", messageId: "m1", key: "ok" },
      });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toBe(code);
    }
  });

  test("bad arguments are refused BEFORE the hub (§19.7)", async () => {
    const cases = [
      { peer: 42, messageId: "m1", key: "ok" },
      { peer: "shagin", messageId: "", key: "ok" },
      { peer: "shagin", messageId: "m1", key: "" },
      { peer: "shagin", messageId: "m1", key: "ok", remove: "yes" },
    ];
    for (const args of cases) {
      const result = await alice.callTool({ name: "react", arguments: args as never });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toBe("INVALID_ARGS");
    }
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!LOOPBACK_DIRECT)("reactions not configured (§19.2)", () => {
  test("both tools stay LISTED but answer REACTIONS_DISABLED", async () => {
    const root = mkdtempSync(join(tmpdir(), "muxeon-mcp-noreact-"));
    await ensureSessionQueue(root, "alice-s");
    const topology = new Topology({ alice: ["shagin"], shagin: ["alice"] });
    const router = new Router({
      topology,
      root,
      queueKeyOf: (n) => (n === "alice" ? "alice-s" : null),
    });
    const plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (n) => n === "alice",
      makeServer: (caller) =>
        createAgentServer(caller, { topology, router, peerStatus: () => "idle" }),
    });
    const alice = await connectClient(plane.url, "alice");
    try {
      // The set must NOT depend on the config — otherwise tools/list_changed fires
      // on every config edit (§8.6/FR-89).
      const names = (await alice.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("list_reactions");
      expect(names).toContain("react");
      expect(errorOf(await alice.callTool({ name: "list_reactions", arguments: {} }))).toBe(
        "REACTIONS_DISABLED",
      );
      expect(
        errorOf(
          await alice.callTool({
            name: "react",
            arguments: { peer: "shagin", messageId: "m1", key: "ok" },
          }),
        ),
      ).toBe("REACTIONS_DISABLED");
    } finally {
      await alice.close();
      await plane.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
