// §18.11 relay mode (FR-152/FR-153): the reverse half of an established link.
// The manager applies a consented accept's ephemeral frames to the registry
// (a relay branch — an import's twin), re-exports the branch on its own
// surface, and the publisher targets import links whose hub granted relay.
// The client warns — and only warns — when the hub declines (§18.11.5).

import { describe, expect, test } from "bun:test";
import {
  FED_PROTOCOL_VERSION,
  FederationManager,
  type FederationManagerOptions,
  LinkClient,
  type LinkFrame,
} from "../src";

function makeManager(overrides: Partial<FederationManagerOptions> = {}): FederationManager {
  return new FederationManager({
    instanceId: "hub-id",
    onIngress: async () => ({ ok: true }),
    exportNameOf: () => null,
    ownActors: [],
    projectionOf: (actor) => ({
      actor: actor.exportName,
      type: "agent",
      status: "idle",
      paused: false,
    }),
    transitImports: [],
    publishStatus: true,
    statusDebounceMs: 50,
    ...overrides,
  });
}

const SURFACE_FRAME = JSON.stringify({
  type: "surface",
  actors: [{ name: "ann", type: "agent", path: ["sat-id"] }],
});

describe("relay at the hub (§18.11.2, FR-153)", () => {
  test("a consented accept's surface feeds the registry; an unconsented one is ignored", async () => {
    const manager = makeManager({ relayAccepts: ["a"] });
    const connection = { send: () => {} };
    manager.registry.linkUp("a", true);
    await manager.handleMessage("a", SURFACE_FRAME, connection, "accept");
    expect(manager.registry.peersOf("a").map((peer) => peer.name)).toEqual(["ann@a"]);
    // The same frame on an accept WITHOUT `relay: true` changes nothing (§18.11.5).
    await manager.handleMessage("x", SURFACE_FRAME, connection, "accept");
    expect(manager.registry.peersOf("x")).toEqual([]);
  });

  test("a relay branch re-exports on the hub's own surface, id appended (§18.11.2)", async () => {
    const manager = makeManager({ relayAccepts: ["a"] });
    manager.registry.linkUp("a", true);
    await manager.handleMessage("a", SURFACE_FRAME, { send: () => {} }, "accept");
    const entry = manager.surface().find((candidate) => candidate.name === "ann@a");
    expect(entry).toMatchObject({ type: "agent", path: ["sat-id", "hub-id"] });
  });

  test("statuses on a consented accept apply; link down turns the branch unknown (§10.27)", async () => {
    const manager = makeManager({ relayAccepts: ["a"] });
    manager.registry.linkUp("a", true);
    await manager.handleMessage("a", SURFACE_FRAME, { send: () => {} }, "accept");
    await manager.handleMessage(
      "a",
      JSON.stringify({
        type: "status",
        statuses: [{ actor: "ann", type: "agent", status: "busy", paused: false }],
      }),
      { send: () => {} },
      "accept",
    );
    expect(manager.registry.get("ann@a")).toMatchObject({ status: "busy" });
    manager.registry.linkDown("a");
    expect(manager.registry.get("ann@a")).toMatchObject({ status: "unknown", reason: "link-down" });
  });
});

describe("the satellite's publisher (§18.11.2, FR-153)", () => {
  test("a granted import link receives the snapshot at once and joins publish ticks", () => {
    const frames: LinkFrame[] = [];
    const manager = makeManager({
      instanceId: "sat-id",
      ownActors: [{ local: "ann", exportName: "ann", type: "agent" }],
    });
    const connection = { send: (frame: LinkFrame) => frames.push(frame) };
    manager.attach("c", connection);
    manager.publishGranted("c", connection);
    // The grant sends the current truth immediately (the acceptOpened mirror).
    expect(frames.map((frame) => frame.type)).toEqual(["surface", "status-snapshot"]);
    frames.length = 0;
    manager.publishTick([]); // no accepts — the granted link is the only target
    expect(frames.some((frame) => frame.type === "surface")).toBe(true);
    // After revocation nothing goes up the link.
    manager.publishRevoked("c");
    frames.length = 0;
    manager.publishTick([]);
    expect(frames).toEqual([]);
  });
});

describe("the client's mode negotiation (§18.11.5, FR-153)", () => {
  test("publish without relay: warn and base mode, never link-down", async () => {
    const warns: string[] = [];
    let sawPublish: boolean | undefined;
    const hub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/fed/handshake") {
          sawPublish = ((await req.json()) as { publish?: boolean }).publish;
          return Response.json({
            instanceId: "hub-id",
            version: FED_PROTOCOL_VERSION,
            statusPublished: true,
            relay: false,
          });
        }
        if (url.pathname === "/fed/actors") return Response.json({ actors: [] });
        return new Response("", { status: 400 }); // no WS — the attempt ends after the warn
      },
    });
    const abort = new AbortController();
    try {
      const client = new LinkClient({
        name: "c",
        url: `http://127.0.0.1:${hub.port}`,
        token: "tok",
        publish: true,
        onUp: () => {},
        onDown: () => {},
        onMessage: () => {},
        warn: (message) => {
          warns.push(message);
          abort.abort(); // one attempt is enough
        },
        backoffInitialMs: 10,
      });
      await client.run(abort.signal);
    } finally {
      await hub.stop(true);
    }
    expect(sawPublish).toBe(true);
    expect(warns.some((message) => message.includes("did not grant relay"))).toBe(true);
  });
});
