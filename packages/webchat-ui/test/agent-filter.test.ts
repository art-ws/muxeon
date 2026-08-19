// What the sidebar's agent filter keeps and what it drops (§12.7, FR-176, T290).
// The rules are pure, so they are tested without a browser: what "online" means
// for each kind of peer, what a name matches, and — the part that is easy to get
// wrong — what happens to the group tree around a match.

import { describe, expect, test } from "bun:test";
import {
  NO_FILTER,
  filterActive,
  filterPeers,
  isOnline,
  matchesFilter,
  matchesName,
  participantCount,
} from "../src/agent-filter";
import type { PeerInfo } from "../src/types";

const agent = (name: string, extra: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  type: "agent",
  status: "idle",
  queueDepth: 0,
  unread: 0,
  ...extra,
});
const person = (name: string, extra: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
  ...extra,
});
const group = (name: string, extra: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  type: "group",
  status: null,
  queueDepth: 0,
  unread: 0,
  ...extra,
});
const tag = (name: string): PeerInfo => ({
  name,
  type: "tag",
  status: null,
  queueDepth: 0,
  unread: 0,
});

const names = (peers: readonly PeerInfo[]): readonly string[] => peers.map((peer) => peer.name);

describe("when the filter bites at all", () => {
  test("the resting state filters nothing", () => {
    expect(filterActive(NO_FILTER)).toBe(false);
    expect(filterActive({ query: "   ", onlineOnly: false })).toBe(false);
  });

  test("either half is enough to be active", () => {
    expect(filterActive({ query: "dev", onlineOnly: false })).toBe(true);
    expect(filterActive({ query: "", onlineOnly: true })).toBe(true);
  });

  test("an inactive filter hands the list back UNCHANGED — same array", () => {
    const peers = [agent("dev"), group("backend"), tag("ops")];
    expect(filterPeers(peers, NO_FILTER)).toBe(peers);
  });
});

describe("the name half", () => {
  test("case-insensitive substring, blank matches everything", () => {
    expect(matchesName(agent("researcher"), "SEAR")).toBe(true);
    expect(matchesName(agent("researcher"), "  ")).toBe(true);
    expect(matchesName(agent("researcher"), "writer")).toBe(false);
  });

  test("the printed label counts too — one types what one sees (FR-156)", () => {
    const dev = agent("dev1", { title: "Разработчик" });
    expect(matchesName(dev, "разраб")).toBe(true);
    expect(matchesName(dev, "dev")).toBe(true); // …and the name stays searchable
  });
});

describe("the online half", () => {
  test("an agent's session answers it", () => {
    expect(isOnline(agent("a", { status: "idle" }))).toBe(true);
    expect(isOnline(agent("a", { status: "busy" }))).toBe(true);
    expect(isOnline(agent("a", { status: "down" }))).toBe(false);
  });

  test("a paused agent is still up — pause is orthogonal to the session (§16)", () => {
    expect(isOnline(agent("a", { status: "idle", paused: true }))).toBe(true);
  });

  test("a person's presence answers it (FR-133)", () => {
    expect(isOnline(person("alex"))).toBe(true);
    expect(isOnline(person("alex", { presence: "offline" }))).toBe(false);
  });

  test("`unknown` is not online — the panel does not upgrade a guess (§18.4)", () => {
    expect(isOnline(agent("ceo@hub", { status: "unknown", server: "hub" }))).toBe(false);
    expect(isOnline(person("kim@hub", { presence: "unknown", server: "hub" }))).toBe(false);
  });

  test("both halves are ANDed", () => {
    const filter = { query: "dev", onlineOnly: true };
    expect(matchesFilter(agent("dev1"), filter)).toBe(true);
    expect(matchesFilter(agent("dev1", { status: "down" }), filter)).toBe(false);
    expect(matchesFilter(agent("ops"), filter)).toBe(false);
  });
});

describe("what a match does to the rest of the sidebar", () => {
  const park: readonly PeerInfo[] = [
    group("company"),
    group("backend", { parent: "company" }),
    agent("dev1", { group: "backend" }),
    agent("dev2", { group: "backend", status: "down" }),
    agent("loner"),
    person("alex"),
    tag("urgent"),
  ];

  test("a match keeps its whole group chain — a nested hit stays reachable", () => {
    expect(names(filterPeers(park, { query: "dev1", onlineOnly: false }))).toEqual([
      "company",
      "backend",
      "dev1",
    ]);
  });

  test("a group with no surviving member is dropped — no empty folders", () => {
    expect(names(filterPeers(park, { query: "loner", onlineOnly: false }))).toEqual(["loner"]);
  });

  test("broadcast targets are not participants — tags go while the filter is on", () => {
    expect(names(filterPeers(park, { query: "urgent", onlineOnly: false }))).toEqual([]);
  });

  test("online-only drops the down agent and keeps the rest of its group", () => {
    expect(names(filterPeers(park, { query: "", onlineOnly: true }))).toEqual([
      "company",
      "backend",
      "dev1",
      "loner",
      "alex",
    ]);
  });

  test("the input order survives — the sidebar must not reshuffle itself", () => {
    expect(names(filterPeers(park, { query: "e", onlineOnly: false }))).toEqual([
      "company",
      "backend",
      "dev1",
      "dev2",
      "loner",
      "alex",
    ]);
  });

  test("a federated actor is a participant like any other (§18.4)", () => {
    const remote = [agent("ceo@hub", { server: "hub", status: "idle" }), agent("dev")];
    expect(names(filterPeers(remote, { query: "hub", onlineOnly: false }))).toEqual(["ceo@hub"]);
  });

  test("a parent cycle does not hang the ancestor walk (tree.ts is defensive too)", () => {
    const looped = [
      group("a", { parent: "b" }),
      group("b", { parent: "a" }),
      agent("dev", { group: "a" }),
    ];
    expect(names(filterPeers(looped, { query: "dev", onlineOnly: false }))).toEqual([
      "a",
      "b",
      "dev",
    ]);
  });

  test("a dangling group reference never hides the agent", () => {
    const orphan = [agent("dev", { group: "gone" })];
    expect(names(filterPeers(orphan, { query: "dev", onlineOnly: false }))).toEqual(["dev"]);
  });
});

describe("the counter", () => {
  test("counts participants only — a group/tag row is not one", () => {
    expect(participantCount([agent("dev"), person("alex"), group("g"), tag("t")])).toBe(2);
  });
});
