// The sidebar broadcast tree (§15, FR-106/FR-107) — the PURE builder behind the
// sidebar: hierarchy nesting, groupless-at-root, collapse hides descendants,
// deterministic render order. DOM-free.

import { describe, expect, test } from "bun:test";
import { buildTree, tagPeers } from "../src/tree";
import type { PeerInfo } from "../src/types";

const agent = (name: string, overrides: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  status: "idle",
  queueDepth: 0,
  unread: 0,
  ...overrides,
});

const group = (name: string, overrides: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  type: "group",
  status: null,
  queueDepth: 0,
  unread: 0,
  members: [],
  ...overrides,
});

const tag = (name: string, overrides: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  type: "tag",
  status: null,
  queueDepth: 0,
  unread: 0,
  members: [],
  ...overrides,
});

/** A compact view of a row list — "<kind>@<depth>:<name>" — for order asserts. */
const shape = (rows: readonly { kind: string; depth: number; name: string }[]): string[] =>
  rows.map((row) => `${row.kind}@${row.depth}:${row.name}`);

describe("buildTree (§15) — hierarchy nesting", () => {
  test("child groups nest under parents; agent leaves under their group", () => {
    const rows = buildTree([
      group("eng"),
      group("backend", { parent: "eng" }),
      agent("dev", { group: "backend" }),
      agent("lead", { group: "eng" }),
    ]);
    expect(shape(rows)).toEqual(["group@0:eng", "group@1:backend", "agent@2:dev", "agent@1:lead"]);
  });

  test("groupless agents and top-level groups sit at the root", () => {
    const rows = buildTree([
      group("eng"),
      agent("dev", { group: "eng" }),
      agent("solo"), // no group → root
    ]);
    expect(shape(rows)).toEqual(["group@0:eng", "agent@1:dev", "agent@0:solo"]);
  });

  test("an agent naming a non-existent group falls back to the root", () => {
    const rows = buildTree([agent("dev", { group: "ghost" })]);
    expect(shape(rows)).toEqual(["agent@0:dev"]);
  });

  test("a group whose parent is not a real group surfaces at the root", () => {
    const rows = buildTree([group("orphan", { parent: "ghost" }), agent("a", { group: "orphan" })]);
    expect(shape(rows)).toEqual(["group@0:orphan", "agent@1:a"]);
  });
});

describe("buildTree (§15) — collapse", () => {
  const forest: readonly PeerInfo[] = [
    group("eng"),
    group("backend", { parent: "eng" }),
    agent("dev", { group: "backend" }),
    agent("lead", { group: "eng" }),
    agent("solo"),
  ];

  test("undefined expanded ⇒ every group expanded (fresh-tree default)", () => {
    const rows = buildTree(forest, undefined);
    expect(shape(rows)).toEqual([
      "group@0:eng",
      "group@1:backend",
      "agent@2:dev",
      "agent@1:lead",
      "agent@0:solo",
    ]);
  });

  test("a collapsed group hides its WHOLE subtree — child groups and leaves", () => {
    const rows = buildTree(forest, new Set(["backend"])); // eng collapsed, backend open
    expect(shape(rows)).toEqual(["group@0:eng", "agent@0:solo"]);
  });

  test("collapsing an inner group hides only its leaves", () => {
    const rows = buildTree(forest, new Set(["eng"])); // eng open, backend collapsed
    expect(shape(rows)).toEqual(["group@0:eng", "group@1:backend", "agent@1:lead", "agent@0:solo"]);
  });
});

describe("buildTree (§15) — determinism & robustness", () => {
  test("siblings keep input order; groups precede leaves at each level", () => {
    const rows = buildTree([
      agent("z-solo"),
      group("b-group"),
      agent("in-b", { group: "b-group" }),
      group("a-group"),
    ]);
    // both root groups first (input order), then the groupless agent
    expect(shape(rows)).toEqual([
      "group@0:b-group",
      "agent@1:in-b",
      "group@0:a-group",
      "agent@0:z-solo",
    ]);
  });

  test("a parent cycle does not loop forever (defensive)", () => {
    const rows = buildTree([group("a", { parent: "b" }), group("b", { parent: "a" })]);
    // neither is a clean root; the guard breaks the loop — both still appear once
    expect(rows.filter((r) => r.name === "a")).toHaveLength(1);
    expect(rows.filter((r) => r.name === "b")).toHaveLength(1);
  });

  test("tags are excluded from the tree", () => {
    const rows = buildTree([agent("dev"), tag("urgent")]);
    expect(shape(rows)).toEqual(["agent@0:dev"]);
  });
});

describe("tagPeers (§15, FR-107)", () => {
  test("returns only tag peers, in input order", () => {
    const peers = [tag("beta"), agent("dev"), group("eng"), tag("alpha")];
    expect(tagPeers(peers).map((p) => p.name)).toEqual(["beta", "alpha"]);
  });
});
