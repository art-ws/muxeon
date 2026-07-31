// §18.4 (FR-140/FR-149, §10.27): the importer-side registry — the surface with
// the cycle guard, honest `unknown` (link down / not published / hop down) and
// the FQN naming rule (suffix per import).

import { describe, expect, test } from "bun:test";
import { RemoteRegistry } from "../src";

const MY_ID = "my-instance";

function seeded(): RemoteRegistry {
  const registry = new RemoteRegistry(MY_ID);
  registry.linkUp("b", true);
  registry.surface("b", [
    {
      name: "dev",
      type: "agent",
      path: ["b-id"],
      status: { actor: "dev", type: "agent", status: "idle", paused: false },
    },
    {
      name: "kim",
      type: "user",
      path: ["b-id"],
      status: { actor: "kim", type: "user", presence: "online", paused: false },
    },
    {
      name: "bob@c",
      type: "agent",
      path: ["c-id", "b-id"],
      status: { actor: "bob@c", type: "agent", status: "busy", paused: false },
    },
  ]);
  return registry;
}

describe("RemoteRegistry (§18.4)", () => {
  test("peers carry the import suffix and the projection", () => {
    const registry = seeded();
    expect(registry.peersOf("b").map((peer) => peer.name)).toEqual(["bob@c@b", "dev@b", "kim@b"]);
    expect(registry.get("dev@b")).toMatchObject({ status: "idle", link: "up", server: "b" });
    expect(registry.get("kim@b")).toMatchObject({ presence: "online" });
    expect(registry.get("bob@c@b")).toMatchObject({ status: "busy" });
  });

  test("the cycle guard drops any branch containing MY instance id (§18.4)", () => {
    const registry = new RemoteRegistry(MY_ID);
    registry.linkUp("b", true);
    registry.surface("b", [
      { name: "dev", type: "agent", path: ["b-id"] },
      // my own actor re-exported back through a mutual import — must vanish
      { name: "alex@me", type: "user", path: [MY_ID, "b-id"] },
    ]);
    expect(registry.peersOf("b").map((peer) => peer.name)).toEqual(["dev@b"]);
  });

  test("a dead link kills the cache: unknown + cause, never the last value (§10.27)", () => {
    const registry = seeded();
    registry.linkDown("b");
    expect(registry.get("dev@b")).toMatchObject({
      link: "down",
      status: "unknown",
      reason: "link-down",
    });
    expect(registry.get("kim@b")).toMatchObject({ presence: "unknown", reason: "link-down" });
    // reconnect + snapshot restores the truth
    registry.linkUp("b", true);
    registry.applyStatuses("b", [{ actor: "dev", type: "agent", status: "down", paused: true }]);
    expect(registry.get("dev@b")).toMatchObject({ status: "down", paused: true, link: "up" });
  });

  test("a neighbour that does not publish reads unknown/not-published (§18.2)", () => {
    const registry = new RemoteRegistry(MY_ID);
    registry.linkUp("b", false);
    registry.surface("b", [{ name: "dev", type: "agent", path: ["b-id"] }]);
    expect(registry.get("dev@b")).toMatchObject({
      link: "up",
      status: "unknown",
      reason: "not-published",
    });
  });

  test("an upstream unknown arrives as hop-down — honesty propagates (§18.4)", () => {
    const registry = seeded();
    registry.applyStatuses("b", [
      { actor: "bob@c", type: "agent", status: "unknown", paused: false },
    ]);
    expect(registry.get("bob@c@b")).toMatchObject({ status: "unknown", reason: "hop-down" });
    // ...while the neighbour's own actor keeps its live value.
    expect(registry.get("dev@b")).toMatchObject({ status: "idle" });
  });

  test("a status for an actor the surface does not know is ignored", () => {
    const registry = seeded();
    registry.applyStatuses("b", [{ actor: "ghost", type: "agent", status: "idle", paused: false }]);
    expect(registry.get("ghost@b")).toBeNull();
  });
});
