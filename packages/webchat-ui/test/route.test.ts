// Hash routing (T80, §12.7, FR-60): codec round-trips, junk degrades to home.
// Plus the per-message deep link (T107, FR-75): #/chat/<peer>/m/<id>.

import { describe, expect, test } from "bun:test";
import { HOME, type Route, parseRoute, routeHash } from "../src/route";

describe("route codec (FR-60)", () => {
  test.each<[Route, string]>([
    [{ view: "home" }, "#/"],
    [{ view: "transport" }, "#/transport"],
    [{ view: "settings" }, "#/settings"],
    [{ view: "chat", peer: "sherlock" }, "#/chat/sherlock"],
    [{ view: "chat", peer: "sherlock", message: "m-1" }, "#/chat/sherlock/m/m-1"],
  ])("routeHash(%j) → %p and parses back", (route, hash) => {
    expect(routeHash(route)).toBe(hash);
    expect(parseRoute(hash)).toEqual(route);
  });

  test("peer names with unicode, spaces and slashes round-trip encoded", () => {
    for (const peer of ["агент-аналитик", "a b", "a/b", "100%"]) {
      const hash = routeHash({ view: "chat", peer });
      expect(parseRoute(hash)).toEqual({ view: "chat", peer });
    }
  });

  test("message ids with colons and slashes round-trip encoded (FR-75)", () => {
    for (const message of ["outbox-abc:reply", "a/b:scrape", "идентификатор", "m m"]) {
      const hash = routeHash({ view: "chat", peer: "dev", message });
      expect(parseRoute(hash)).toEqual({ view: "chat", peer: "dev", message });
    }
  });

  test("an empty message segment degrades to the plain chat route (FR-75)", () => {
    expect(parseRoute("#/chat/dev/m/")).toEqual({ view: "chat", peer: "dev" });
  });

  test.each([
    [""],
    ["#"],
    ["#/"],
    ["#/unknown"],
    ["#/chat/"], // empty peer
    ["#/chat/%zz"], // malformed percent-encoding must not crash
    ["#transport/extra"],
  ])("junk hash %p degrades to home", (hash) => {
    expect(parseRoute(hash)).toEqual(HOME);
  });

  test("a hash without the leading slash still parses", () => {
    expect(parseRoute("#transport")).toEqual({ view: "transport" });
    expect(parseRoute("#chat/dev")).toEqual({ view: "chat", peer: "dev" });
  });
});

// --- transport filter projection (T124, FR-85) ---------------------------------

describe("transport filters in the URL (FR-85)", () => {
  test("repeated from/to params parse into canonical (sorted, deduped) lists", () => {
    expect(parseRoute("#/transport?from=dev&from=ceo&from=dev&to=operator-web")).toEqual({
      view: "transport",
      from: ["ceo", "dev"],
      to: ["operator-web"],
    });
  });

  test("a selection round-trips: routeHash(parseRoute(x)) is stable", () => {
    const route = { view: "transport", from: ["ceo", "dev"], to: ["operator-web"] } as const;
    const hash = routeHash(route);
    expect(hash).toBe("#/transport?from=ceo&from=dev&to=operator-web");
    expect(parseRoute(hash)).toEqual(route);
    expect(routeHash(parseRoute(hash))).toBe(hash);
  });

  test("names with URL-hostile characters survive the round-trip", () => {
    for (const name of ["оператор", "a&b", "x=y", "with space", "a,b"]) {
      const hash = routeHash({ view: "transport", from: [name] });
      expect(parseRoute(hash)).toEqual({ view: "transport", from: [name] });
    }
  });

  test("an unordered selection canonicalizes to ONE url", () => {
    expect(routeHash({ view: "transport", from: ["dev", "ceo", "dev"] })).toBe(
      routeHash({ view: "transport", from: ["ceo", "dev"] }),
    );
  });

  test.each([
    ["#/transport?"],
    ["#/transport?from="],
    ["#/transport?junk=1"],
    ["#/transport?from=&to="],
  ])("empty/foreign params %p degrade to the unfiltered view", (hash) => {
    expect(parseRoute(hash)).toEqual({ view: "transport" });
  });

  test("a query on a non-transport view is dropped, not a crash", () => {
    expect(parseRoute("#/settings?from=x")).toEqual({ view: "settings" });
    expect(parseRoute("#/chat/dev?x=1")).toEqual({ view: "chat", peer: "dev" });
  });
});
