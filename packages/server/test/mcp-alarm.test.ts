// The `alarm` tool on the agent plane (§22.3, FR-202) wired to the real hub: the
// caller raises, replaces and withdraws its OWN slot. The property worth pinning
// over the wire is that the tool has no way to name a recipient — the audience is
// the caller's human neighbours, whatever the arguments say.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Topology } from "@muxeon/core";
import { Router } from "@muxeon/orchestrator";
import { AlarmsHub } from "@muxeon/webchat";
import { type AgentPlaneHandle, createAgentServer, startAgentPlane } from "../src/mcp";
import { LOOPBACK_DIRECT, connectClient } from "./mcp-helpers";

// dev talks to one human (alex) and one agent (qa); qa talks to no human
const TOPOLOGY = { dev: ["alex", "qa"], qa: ["dev"], alex: ["dev"] };

const sc = (result: unknown): Record<string, unknown> =>
  ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;

const textOf = (result: unknown): string =>
  ((result as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join(" ");

describe.skipIf(!LOOPBACK_DIRECT)("alarm (§22.3)", () => {
  let root: string;
  let plane: AgentPlaneHandle;
  let dev: Client;
  let hub: AlarmsHub;

  const start = async (wired: boolean): Promise<void> => {
    root = mkdtempSync(join(tmpdir(), "muxeon-mcp-alarm-"));
    const topology = new Topology(TOPOLOGY);
    const router = new Router({ topology, root, queueKeyOf: () => null });
    hub = new AlarmsHub({
      enabled: true,
      limits: { maxText: 4096, maxOptions: 6, maxOptionLength: 80 },
      dir: join(root, "alarms"),
      isAgent: (name) => name === "dev" || name === "qa",
      audienceOf: (agent) => topology.neighbors(agent).filter((name) => name === "alex"),
    });
    plane = startAgentPlane({
      port: 0,
      isKnownIdentity: (name) => name in TOPOLOGY,
      makeServer: (caller) =>
        createAgentServer(caller, {
          topology,
          router,
          peerStatus: () => "idle",
          ...(wired ? { alarms: { call: (agent, input) => hub.call(agent, input) } } : {}),
        }),
    });
    dev = await connectClient(plane.url, "dev");
  };

  afterEach(async () => {
    await dev?.close();
    await plane?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  describe("wired", () => {
    beforeEach(() => start(true));

    test("raise → the caller's slot, shown to its human neighbours", async () => {
      const result = await dev.callTool({
        name: "alarm",
        arguments: { text: "migration failed", level: 0.85, options: ["Roll back", "Fix"] },
      });
      expect(result.isError).toBeFalsy();
      expect(sc(result)).toMatchObject({ state: "raised", audience: ["alex"], watching: 0 });
      expect(hub.slot("dev")).toMatchObject({ level: 0.85, options: ["Roll back", "Fix"] });
    });

    test("a second call replaces the first; clear withdraws it", async () => {
      const first = sc(await dev.callTool({ name: "alarm", arguments: { text: "a", level: 0.2 } }));
      const second = sc(await dev.callTool({ name: "alarm", arguments: { text: "b", level: 1 } }));
      expect(second.replaced).toEqual({ id: first.id, state: "superseded" });
      const cleared = sc(await dev.callTool({ name: "alarm", arguments: { clear: true } }));
      expect(cleared).toMatchObject({ id: second.id, state: "withdrawn" });
    });

    test("a recipient is not an argument — `to` is refused, not obeyed", async () => {
      const result = await dev.callTool({
        name: "alarm",
        arguments: { text: "x", level: 1, to: "qa" },
      });
      expect(result.isError).toBe(true);
    });

    test("level out of range is INVALID_ARGS, never clamped", async () => {
      const result = await dev.callTool({ name: "alarm", arguments: { text: "x", level: 1.5 } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INVALID_ARGS");
      expect(hub.slot("dev")).toBeUndefined();
    });
  });

  test("an agent with no human neighbour is told NO_AUDIENCE", async () => {
    await start(true);
    const qa = await connectClient(plane.url, "qa");
    try {
      const result = await qa.callTool({ name: "alarm", arguments: { text: "x", level: 1 } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("NO_AUDIENCE");
    } finally {
      await qa.close();
    }
  });

  test("no hub wired ⇒ the tool is still listed and answers ALARMS_DISABLED", async () => {
    await start(false);
    const tools = (await dev.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("alarm");
    const result = await dev.callTool({ name: "alarm", arguments: { text: "x", level: 1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ALARMS_DISABLED");
  });
});
