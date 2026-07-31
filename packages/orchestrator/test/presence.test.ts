// User presence (§17.5, FR-133): a derived online/offline flag with SLIDING
// expiration — every outgoing send pushes the window forward; appearing is
// instant, fading out happens on the sweep.

import { describe, expect, test } from "bun:test";
import { PresenceTracker } from "../src/presence";

function tracker(ttlMs = 1000): {
  presence: PresenceTracker;
  changes: [string, string][];
  tick: (ms: number) => void;
} {
  let now = 1_000_000;
  const changes: [string, string][] = [];
  const presence = new PresenceTracker({
    ttlMs,
    now: () => now,
    onChange: (user, state) => changes.push([user, state]),
  });
  const tick = (ms: number): void => {
    now += ms;
  };
  return { presence, changes, tick };
}

describe("PresenceTracker (§17.5, FR-133)", () => {
  test("a user who never sent is offline", () => {
    const { presence } = tracker();
    expect(presence.presence("alex")).toBe("offline");
    expect(presence.onlineUsers()).toEqual([]);
  });

  test("a send makes them online IMMEDIATELY and reports the change once", () => {
    const { presence, changes } = tracker();
    presence.note("alex");
    presence.note("alex"); // still online — no second report
    expect(presence.presence("alex")).toBe("online");
    expect(changes).toEqual([["alex", "online"]]);
  });

  test("the window SLIDES: a send inside the TTL keeps them online", () => {
    const { presence, tick } = tracker(1000);
    presence.note("alex");
    tick(900);
    presence.note("alex"); // slides the window
    tick(900);
    expect(presence.presence("alex")).toBe("online");
  });

  test("past the TTL they fade out — reported once, by the sweep", () => {
    const { presence, changes, tick } = tracker(1000);
    presence.note("alex");
    tick(1001);
    expect(presence.presence("alex")).toBe("offline"); // the read is already accurate
    expect(presence.sweep()).toEqual(["alex"]); // the sweep reports it
    expect(presence.sweep()).toEqual([]); // and only once
    expect(changes).toEqual([
      ["alex", "online"],
      ["alex", "offline"],
    ]);
  });

  test("coming back after a fade-out reports online again", () => {
    const { presence, changes, tick } = tracker(1000);
    presence.note("alex");
    tick(2000);
    presence.sweep();
    presence.note("alex");
    expect(changes.map(([, state]) => state)).toEqual(["online", "offline", "online"]);
  });

  test("onlineUsers lists the live ones, sorted", () => {
    const { presence, tick } = tracker(1000);
    presence.note("kim");
    presence.note("alex");
    tick(500);
    presence.note("alex");
    expect(presence.onlineUsers()).toEqual(["alex", "kim"]);
    tick(600); // kim's window expired, alex's did not
    expect(presence.onlineUsers()).toEqual(["alex"]);
  });

  test("a throwing listener never breaks the router hot path", () => {
    const presence = new PresenceTracker({
      ttlMs: 10,
      onChange: () => {
        throw new Error("boom");
      },
    });
    expect(() => presence.note("alex")).not.toThrow();
  });
});
