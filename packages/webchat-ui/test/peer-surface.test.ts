// The peer→surface mapping (§12.7, §15, §17.7): ONE table decides whether a
// peer is drawn as an agent, a person or a broadcast target — the sidebar row
// and the chat header both read it, so they cannot drift apart. They did: a
// user chat opened as a "broadcast tag (no members)" while its row already
// rendered as a person (found on a live stand).

import { describe, expect, test } from "bun:test";
import { chatSurface, dotClass, hasConsole, liveLabel, statusLabel } from "../src/peer-surface";
import type { PeerInfo } from "../src/types";

const peer = (overrides: Partial<PeerInfo> = {}): PeerInfo => ({
  name: "dev",
  status: "idle",
  queueDepth: 0,
  unread: 0,
  ...overrides,
});

const person = (overrides: Partial<PeerInfo> = {}): PeerInfo =>
  peer({ name: "alex", type: "user", status: null, presence: "offline", ...overrides });

describe("chatSurface (§12.7, §15, §17.7)", () => {
  test("an agent — explicitly typed or from a pre-§15 server", () => {
    expect(chatSurface(peer())).toBe("agent");
    expect(chatSurface(peer({ type: "agent" }))).toBe("agent");
  });

  test("a user is a PERSON, not a broadcast target — the §17.7 regression", () => {
    expect(chatSurface(person())).toBe("person");
  });

  test("groups and tags are the only broadcast surfaces (§15)", () => {
    expect(chatSurface(peer({ type: "group", status: null }))).toBe("broadcast");
    expect(chatSurface(peer({ type: "tag", status: null }))).toBe("broadcast");
  });

  test("a not-yet-loaded peer falls back to the full agent chrome", () => {
    expect(chatSurface(undefined)).toBe("agent");
  });
});

describe("hasConsole — raw mode / slash commands / the terminal (§12.9)", () => {
  test("only an agent has a terminal behind it", () => {
    expect(hasConsole(peer())).toBe(true);
    expect(hasConsole(person())).toBe(false);
    expect(hasConsole(peer({ type: "group", status: null }))).toBe(false);
  });
});

describe("statusLabel / liveLabel (§16.6, FR-120/FR-133)", () => {
  test.each([
    ["idle", "idle"],
    ["busy", "busy…"],
    ["down", "down"],
  ] as const)("an agent shows its session status: %p", (status, label) => {
    expect(statusLabel(peer({ status }))).toBe(label);
  });

  test("a person shows presence, never a session status (FR-133)", () => {
    expect(statusLabel(person({ presence: "online" }))).toBe("online");
    expect(statusLabel(person({ presence: "offline" }))).toBe("offline");
    // a pre-§17 server sends no presence at all — offline, not "—"
    expect(statusLabel(person({ presence: undefined }))).toBe("offline");
  });

  test("paused wins the label; the real state stays available for the tooltip", () => {
    const busy = peer({ status: "busy", paused: true });
    expect(statusLabel(busy)).toBe("paused");
    expect(liveLabel(busy)).toBe("busy…");
    // for a person the same flag is DND — the tooltip still says where they are
    const away = person({ presence: "online", paused: true });
    expect(statusLabel(away)).toBe("paused");
    expect(liveLabel(away)).toBe("online");
  });
});

describe("dotClass (§12.7, §17.7)", () => {
  test("the same dot in the same place: status for an agent, presence for a person", () => {
    expect(dotClass(peer({ status: "busy" }))).toBe("status-dot busy");
    expect(dotClass(person({ presence: "online" }))).toBe("status-dot online");
    // a person is never painted with an agent status, even a stale one
    expect(dotClass(person({ status: "idle" as never }))).toBe("status-dot offline");
  });

  test("pause mutes either of them", () => {
    expect(dotClass(peer({ status: "idle", paused: true }))).toBe("status-dot idle paused");
    expect(dotClass(person({ presence: "online", paused: true }))).toBe("status-dot online paused");
  });

  test("an unknown peer has an unknown dot", () => {
    expect(dotClass(undefined)).toBe("status-dot unknown");
  });
});
