// Message filtering (T97, FR-71) — the pure predicates behind the global
// topbar search and the transport from/to multi-select. DOM-free.

import { describe, expect, test } from "bun:test";
import { matchesParties, matchesQuery, partyOptions, toggleParty } from "../src/filter";
import type { ChatRecord } from "../src/types";

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: "m1",
    from: "researcher",
    to: "operator-web",
    kind: "message",
    ts: 1000,
    payload: "Hello World",
    ...overrides,
  };
}

describe("matchesQuery (FR-71)", () => {
  test("a blank or whitespace query matches everything", () => {
    expect(matchesQuery(record(), "")).toBe(true);
    expect(matchesQuery(record(), "   ")).toBe(true);
  });

  test("case-insensitive substring over the payload text", () => {
    expect(matchesQuery(record(), "hello w")).toBe(true);
    expect(matchesQuery(record(), "WORLD")).toBe(true);
    expect(matchesQuery(record(), "absent")).toBe(false);
  });

  test("matches the object-payload text too", () => {
    const rec = record({ payload: { text: "deploy finished" } });
    expect(matchesQuery(rec, "Deploy")).toBe(true);
    expect(matchesQuery(rec, "hello")).toBe(false);
  });

  test("matches the parties (from/to)", () => {
    expect(matchesQuery(record(), "research")).toBe(true);
    expect(matchesQuery(record(), "operator-WEB")).toBe(true);
  });

  test("matches attachment names of a blob payload", () => {
    const rec = record({
      payload: { blobs: [{ blob: "b1", name: "screenshot.png" }] },
    });
    expect(matchesQuery(rec, "screenshot")).toBe(true);
    expect(matchesQuery(rec, "video")).toBe(false);
  });

  test("the query is trimmed before matching", () => {
    expect(matchesQuery(record(), "  world  ")).toBe(true);
  });
});

describe("matchesParties (FR-71)", () => {
  const none: ReadonlySet<string> = new Set();

  test("empty selections constrain nothing", () => {
    expect(matchesParties(record(), none, none)).toBe(true);
  });

  test("a from-selection keeps only the listed senders", () => {
    expect(matchesParties(record(), new Set(["researcher"]), none)).toBe(true);
    expect(matchesParties(record(), new Set(["devops"]), none)).toBe(false);
    expect(matchesParties(record(), new Set(["devops", "researcher"]), none)).toBe(true);
  });

  test("a to-selection keeps only the listed recipients", () => {
    expect(matchesParties(record(), none, new Set(["operator-web"]))).toBe(true);
    expect(matchesParties(record(), none, new Set(["devops"]))).toBe(false);
  });

  test("from AND to must both pass when both are set", () => {
    expect(matchesParties(record(), new Set(["researcher"]), new Set(["operator-web"]))).toBe(true);
    expect(matchesParties(record(), new Set(["researcher"]), new Set(["devops"]))).toBe(false);
  });
});

describe("partyOptions (FR-71)", () => {
  test("distinct sorted names of the requested field", () => {
    const records = [
      record({ id: "a", from: "zeta", to: "operator-web" }),
      record({ id: "b", from: "alpha", to: "zeta" }),
      record({ id: "c", from: "zeta", to: "alpha" }),
    ];
    expect(partyOptions(records, "from")).toEqual(["alpha", "zeta"]);
    expect(partyOptions(records, "to")).toEqual(["alpha", "operator-web", "zeta"]);
  });

  test("empty input yields no options", () => {
    expect(partyOptions([], "from")).toEqual([]);
  });
});

describe("toggleParty (FR-71)", () => {
  test("adds a missing name, removes a present one, immutably", () => {
    const start: ReadonlySet<string> = new Set(["a"]);
    const added = toggleParty(start, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    const removed = toggleParty(added, "a");
    expect([...removed]).toEqual(["b"]);
    expect([...start]).toEqual(["a"]); // the input set is untouched
  });
});
