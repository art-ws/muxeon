import { describe, expect, test } from "bun:test";
import { SessionRegistry, parseInitialize } from "../src/mcp/identity";

describe("SessionRegistry (§8.6)", () => {
  const known = (n: string) => ["alice", "bob"].includes(n);

  test("reserves a known name, rejects an unknown one", () => {
    const r = new SessionRegistry(known);
    expect(r.reserve("alice")).toEqual({});
    expect(r.reserve("mallory")).toBe("UNKNOWN_IDENTITY");
  });

  test("release frees a reservation that never bound", () => {
    const r = new SessionRegistry(known);
    r.reserve("alice");
    r.release("alice");
    expect(r.reserve("alice")).toEqual({}); // reusable
  });

  test("bind maps a session id to its name; drop frees it for reconnection", () => {
    const r = new SessionRegistry(known);
    r.reserve("bob");
    r.bind("sid-1", "bob");
    expect(r.nameOf("sid-1")).toBe("bob");
    r.drop("sid-1");
    expect(r.nameOf("sid-1")).toBeUndefined();
    expect(r.reserve("bob")).toEqual({}); // freed, no eviction
  });

  // FR-44b (T55): a crashed client never sends the closing DELETE — the newcomer
  // takes the name over instead of being locked out until a server restart.
  test("re-reserving a live name evicts the old session (takeover)", () => {
    const r = new SessionRegistry(known);
    r.reserve("alice");
    r.bind("sid-old", "alice");
    expect(r.reserve("alice")).toEqual({ evictedSession: "sid-old" });
    expect(r.nameOf("sid-old")).toBeUndefined(); // the loser lost its identity
    r.bind("sid-new", "alice");
    expect(r.nameOf("sid-new")).toBe("alice");
  });

  test("the evicted session's late drop does not free the newcomer's name", () => {
    const r = new SessionRegistry(known);
    r.reserve("alice");
    r.bind("sid-old", "alice");
    r.reserve("alice"); // takeover
    r.bind("sid-new", "alice");
    r.drop("sid-old"); // late close of the evicted session
    expect(r.nameOf("sid-new")).toBe("alice"); // newcomer unaffected
    expect(r.reserve("alice")).toEqual({ evictedSession: "sid-new" }); // still live → next takeover
  });

  test("a pending (unbound) reservation is taken over without an eviction id", () => {
    const r = new SessionRegistry(known);
    r.reserve("alice"); // reserved, never bound (e.g. handshake in flight)
    expect(r.reserve("alice")).toEqual({}); // no session to evict yet
  });

  // FR-156 (T261): the signal that picks the compact reply contract (§13.6).
  test("hasLiveSession follows bind/drop and is false for a bare reservation", () => {
    const r = new SessionRegistry(known);
    expect(r.hasLiveSession("alice")).toBe(false);
    r.reserve("alice");
    // Reserved but not bound — the handshake is in flight. It reads as NOT live
    // on purpose: guessing wrong here must fall back to the file contract, which
    // any agent can follow, never to an MCP instruction nobody can act on.
    expect(r.hasLiveSession("alice")).toBe(false);
    r.bind("sid-1", "alice");
    expect(r.hasLiveSession("alice")).toBe(true);
    expect(r.hasLiveSession("bob")).toBe(false);
    r.drop("sid-1");
    expect(r.hasLiveSession("alice")).toBe(false);
  });

  test("hasLiveSession survives a takeover — the name stays live on the newcomer", () => {
    const r = new SessionRegistry(known);
    r.reserve("bob");
    r.bind("sid-old", "bob");
    r.reserve("bob"); // takeover (FR-44b): reserved again, briefly unbound
    r.bind("sid-new", "bob");
    expect(r.hasLiveSession("bob")).toBe(true);
    r.drop("sid-old"); // the loser's late close must not free the winner's name
    expect(r.hasLiveSession("bob")).toBe(true);
  });
});

describe("parseInitialize (§8.6)", () => {
  function init(name?: unknown): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "x",
        capabilities: {},
        ...(name !== undefined ? { clientInfo: { name } } : {}),
      },
    });
  }

  test("extracts id and clientInfo.name from an initialize", () => {
    expect(parseInitialize(init("alice"))).toEqual({ id: 7, name: "alice" });
  });

  test("name is undefined when clientInfo.name is missing or not a non-empty string", () => {
    expect(parseInitialize(init())?.name).toBeUndefined();
    expect(parseInitialize(init(""))?.name).toBeUndefined();
    expect(parseInitialize(init(42))?.name).toBeUndefined();
  });

  test("returns null for non-initialize or malformed bodies", () => {
    expect(
      parseInitialize(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    ).toBeNull();
    expect(parseInitialize("not json")).toBeNull();
    expect(parseInitialize("[]")).toBeNull();
  });
});
