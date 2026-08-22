// The schedule trio on the agent plane (§21.4, FR-190/FR-192) wired to the real
// plane and a real store: an agent plans work for ITSELF, sees it, and can call
// it off. The property worth pinning here is the one that cannot be tested in
// the pure package — that none of the three tools has any way to name a
// recipient, so a chain into someone else's terminal is unrepresentable rather
// than merely refused (§10.33).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Topology } from "@muxeon/core";
import { Router, ensureSessionQueue } from "@muxeon/orchestrator";
import { DEFAULT_LIMITS, createFsScheduleStore } from "@muxeon/schedules";
import { type AgentPlaneHandle, createAgentServer, startAgentPlane } from "../src/mcp";
import { SchedulePlane, chainView } from "../src/schedules";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

const TOPOLOGY = { alice: ["bob"], bob: ["alice"] };
const KEY: Record<string, string> = { alice: "alice-s", bob: "bob-s" };

const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join(" ");

describe.skipIf(!LOOPBACK_DIRECT)(
  "schedule_self / list_schedules / cancel_schedule (§21.4)",
  () => {
    let root: string;
    let plane: AgentPlaneHandle;
    let alice: Client;
    let schedules: SchedulePlane;
    let enabled: boolean;

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "muxeon-mcp-schedules-"));
      enabled = true;
      for (const key of Object.values(KEY)) await ensureSessionQueue(root, key);
      const topology = new Topology(TOPOLOGY);
      const router = new Router({ topology, root, queueKeyOf: (n) => KEY[n] ?? null });
      schedules = new SchedulePlane({
        store: createFsScheduleStore(root),
        limits: { ...DEFAULT_LIMITS, maxItems: 3 },
        enabled: true,
        isKnownAgent: (name) => name in KEY,
      });
      plane = startAgentPlane({
        port: 0,
        isKnownIdentity: (n) => n in KEY,
        makeServer: (caller) =>
          createAgentServer(caller, {
            topology,
            router,
            peerStatus: () => "idle",
            schedules: {
              create: async (agent, input) => {
                if (!enabled) return { ok: false, code: "SCHEDULES_DISABLED", message: "off" };
                const outcome = await schedules.create(agent, input as never);
                return outcome.ok && outcome.value !== undefined
                  ? { ok: true, value: chainView(outcome.value) }
                  : outcome;
              },
              list: async (agent) => {
                const outcome = await schedules.list(agent);
                return outcome.ok && outcome.value !== undefined
                  ? { ok: true, value: outcome.value.map(chainView) }
                  : outcome;
              },
              cancel: (agent, id, index) => schedules.cancel(agent, id, index),
            },
          }),
      });
      alice = await connectClient(plane.url, "alice");
    });

    afterEach(async () => {
      await alice?.close();
      await plane?.stop();
      rmSync(root, { recursive: true, force: true });
    });

    test("all three are on the surface", async () => {
      const names = (await alice.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("schedule_self");
      expect(names).toContain("list_schedules");
      expect(names).toContain("cancel_schedule");
    });

    // The property the whole design rests on: there is no `to`. Not "refused for a
    // peer" — absent from the schema, so the model is never even offered the idea.
    test("no tool of the trio takes a recipient — a chain has no address", async () => {
      const tools = (await alice.listTools()).tools.filter((tool) =>
        ["schedule_self", "list_schedules", "cancel_schedule"].includes(tool.name),
      );
      for (const tool of tools) {
        const properties = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        );
        expect(properties).not.toContain("to");
        expect(properties).not.toContain("peer");
        expect(properties).not.toContain("agent");
      }
    });

    test("the self-healing chain is accepted and comes back with its hours", async () => {
      const result = sc(
        await alice.callTool({
          name: "schedule_self",
          arguments: {
            id: "self-heal",
            items: [
              { delay: "0s", text: "save state" },
              { delay: "3m", command: "clear" },
              { delay: "1m", text: "restore state" },
            ],
          },
        }),
      );
      expect(result.id).toBe("self-heal");
      expect(result.agent).toBe("alice");
      const items = result.items as { kind: string; at: string; state: string }[];
      expect(items.map((item) => item.kind)).toEqual(["message", "command", "message"]);
      expect(items.every((item) => item.state === "pending")).toBe(true);
      // cumulative: the third fires four minutes in, not one (§21.9-Q1)
      const gap = Date.parse(items[2]?.at ?? "") - Date.parse(items[0]?.at ?? "");
      expect(gap).toBe(240_000);
    });

    test("a plan an agent no longer remembers is still there to be listed and cancelled", async () => {
      await alice.callTool({
        name: "schedule_self",
        arguments: { id: "later", items: [{ delay: "10m", text: "remember" }] },
      });
      const listed = sc(await alice.callTool({ name: "list_schedules", arguments: {} }));
      expect((listed.chains as { id: string }[]).map((chain) => chain.id)).toEqual(["later"]);

      const cancelled = sc(
        await alice.callTool({ name: "cancel_schedule", arguments: { id: "later" } }),
      );
      expect(cancelled).toEqual({ id: "later", cancelled: 1 });
      const after = sc(await alice.callTool({ name: "list_schedules", arguments: {} }));
      const states = (after.chains as { items: { state: string }[] }[])[0]?.items.map(
        (i) => i.state,
      );
      // cancelled, not vanished: coming back to nothing at all reads as "it never existed"
      expect(states).toEqual(["cancelled"]);
    });

    test("one agent's chains are invisible to another — the list is per caller", async () => {
      await alice.callTool({
        name: "schedule_self",
        arguments: { id: "mine", items: [{ delay: "10m", text: "x" }] },
      });
      const bob = await connectClient(plane.url, "bob");
      try {
        const listed = sc(await bob.callTool({ name: "list_schedules", arguments: {} }));
        expect(listed.chains).toEqual([]);
        // …and bob cannot reach alice's chain by naming it either
        const refused = await bob.callTool({ name: "cancel_schedule", arguments: { id: "mine" } });
        expect(textOf(refused)).toContain("UNKNOWN_SCHEDULE");
      } finally {
        await bob.close();
      }
    });

    test("every refusal names itself — never a silent success", async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ items: [] }, "INVALID_ARGS"],
        [{ items: [{ delay: "1m" }] }, "INVALID_ARGS"],
        [{ items: [{ delay: "later", text: "x" }] }, "INVALID_ARGS"],
        [{ items: [{ delay: "1m", text: "a", command: "clear" }] }, "INVALID_ARGS"],
        [{ items: [{ delay: "1m", command: "/clear" }] }, "INVALID_ARGS"],
        [{ id: "../escape", items: [{ delay: "1m", text: "x" }] }, "INVALID_ARGS"],
        [
          {
            items: [
              { delay: "1m", text: "1" },
              { delay: "1m", text: "2" },
              { delay: "1m", text: "3" },
              { delay: "1m", text: "4" },
            ],
          },
          "SCHEDULE_LIMIT",
        ],
      ];
      for (const [args, code] of cases) {
        const result = await alice.callTool({ name: "schedule_self", arguments: args });
        expect(textOf(result)).toContain(code);
      }
      expect(
        textOf(await alice.callTool({ name: "cancel_schedule", arguments: { id: "ghost" } })),
      ).toContain("UNKNOWN_SCHEDULE");
    });

    test("a server with schedules switched off says so, it does not pretend to plan", async () => {
      enabled = false;
      const result = await alice.callTool({
        name: "schedule_self",
        arguments: { items: [{ delay: "1m", text: "x" }] },
      });
      expect(textOf(result)).toContain("SCHEDULES_DISABLED");
    });
  },
);
