// A user's pause is DND (§17.8, FR-134): the ONE deliberate asymmetry with the
// agent pause of §10.19 — everything from OTHERS is refused before enqueue, while
// the user's own notes to self still land (DND protects from others, not from
// yourself). Broadcast copies to a paused user are refused per member (§15.4).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, Topology } from "@teamai/core";
import { ensureQueueDirs, queuePaths } from "@teamai/queue";
import { Router } from "../src/router";

const KEYS = new Map([
  ["dev", "dev-session"],
  ["alex", "alex"],
  ["kim", "kim"],
]);

let root: string;
const paused = new Set<string>();

function makeRouter(): Router {
  return new Router({
    topology: new Topology({ alex: ["dev", "kim"], kim: ["dev"] }),
    root,
    queueKeyOf: (name) => KEYS.get(name) ?? null,
    isPaused: (name) => paused.has(name),
    isUser: (name) => name === "alex" || name === "kim",
    now: () => 1700000000000,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "teamai-dnd-"));
  for (const key of KEYS.values()) await ensureQueueDirs(queuePaths(root, key));
  paused.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const msg = (from: string, to: string, id = "m1"): Message => ({
  id,
  from,
  to,
  kind: "message",
  ts: 0,
  payload: "hi",
});

const pending = (key: string): string[] => readdirSync(queuePaths(root, key).pending);

describe("user DND (§17.8, FR-134)", () => {
  test("an agent's message to a paused user is refused before enqueue", async () => {
    paused.add("alex");
    const result = await makeRouter().route(msg("dev", "alex"));
    expect(result).toEqual({ ok: false, code: "AGENT_PAUSED" });
    expect(pending("alex")).toHaveLength(0);
  });

  test("another user's message to a paused user is refused too", async () => {
    paused.add("alex");
    const result = await makeRouter().route(msg("kim", "alex"));
    expect(result).toEqual({ ok: false, code: "AGENT_PAUSED" });
  });

  test("a note to SELF passes while paused — the §10.19 asymmetry", async () => {
    paused.add("alex");
    const result = await makeRouter().route(msg("alex", "alex"));
    expect(result.ok).toBe(true);
    expect(pending("alex")).toHaveLength(1);
  });

  test("an AGENT's pause still refuses even self-delivery (§10.19 unchanged)", async () => {
    paused.add("dev");
    const result = await makeRouter().route(msg("dev", "dev"));
    expect(result).toEqual({ ok: false, code: "AGENT_PAUSED" });
    expect(pending("dev-session")).toHaveLength(0);
  });

  test("resuming lets the held-back sender through again (nothing was queued)", async () => {
    paused.add("alex");
    const router = makeRouter();
    await router.route(msg("dev", "alex"));
    paused.delete("alex");
    expect((await router.route(msg("dev", "alex"))).ok).toBe(true);
    expect(pending("alex")).toHaveLength(1);
  });

  test("a broadcast copy to a paused user is refused per-member, not for everyone", async () => {
    paused.add("alex");
    const router = new Router({
      topology: new Topology({ dev: ["team"] }),
      root,
      queueKeyOf: (name) => KEYS.get(name) ?? null,
      isPaused: (name) => paused.has(name),
      isUser: (name) => name === "alex" || name === "kim",
      resolveBroadcast: (to) =>
        to === "team" ? { kind: "group", members: ["alex", "kim"] } : null,
      now: () => 1700000000000,
    });
    const result = await router.route(msg("dev", "team", "b1"));
    expect(result.ok).toBe(true);
    if (!("fanout" in result)) throw new Error("expected a broadcast receipt");
    expect(result.fanout).toEqual([
      { to: "alex", id: "b1:alex", ok: false, code: "AGENT_PAUSED" },
      { to: "kim", id: "b1:kim", ok: true },
    ]);
    expect(pending("kim")).toHaveLength(1);
  });
});
