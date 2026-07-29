import { describe, expect, test } from "bun:test";
import type { AgentStatus, Signal } from "@teamai/core";
import { RendezvousStore } from "../src/rendezvous";
import type { RendezvousFile } from "../src/rendezvous";
import { RendezvousCoordinator, rendezvousPayload } from "../src/rendezvous-coordinator";
import type { RendezvousStateStore } from "../src/rendezvous-state";

const T0 = 1_000_000;
const WINDOW = 15_000;

/** Let all fire-and-forget async chains (onRefused/onRouted ticks + flushes) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakePersist() {
  const files = new Map<string, RendezvousFile>();
  const calls = { write: [] as string[], remove: [] as string[] };
  const store: RendezvousStateStore = {
    async read(s) {
      return files.get(s) ?? null;
    },
    async write(s, f) {
      files.set(s, f);
      calls.write.push(s);
    },
    async remove(s) {
      files.delete(s);
      calls.remove.push(s);
    },
    async list() {
      return [...files.keys()];
    },
  };
  return { store, files, calls };
}

function makeCoord(
  opts: {
    status?: Map<string, AgentStatus>;
    maxAttempts?: number;
    routeOk?: boolean;
    enabled?: boolean;
  } = {},
) {
  const store = new RendezvousStore();
  const persist = fakePersist();
  const notices: { msg: Signal; bypassWip?: boolean | undefined }[] = [];
  const status =
    opts.status ??
    new Map<string, AgentStatus>([
      ["a", "idle"],
      ["b", "idle"],
    ]);
  const logs: string[] = [];
  let clock = T0;
  const coord = new RendezvousCoordinator({
    store,
    persist: persist.store,
    route: async (msg, o) => {
      notices.push({ msg, bypassWip: o?.bypassWip });
      return { ok: opts.routeOk ?? true };
    },
    statusOf: (n) => status.get(n),
    windowMs: WINDOW,
    maxAttempts: opts.maxAttempts ?? 3,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    now: () => clock,
    log: (m) => logs.push(m),
  });
  const setClock = (t: number): void => {
    clock = t;
  };
  return { coord, store, persist, notices, status, logs, setClock };
}

function msg(from: string, to: string, kind: Signal["kind"] = "message"): Signal {
  return { id: "x", from, to, kind, ts: 0, payload: "p" };
}

const wip = { code: "WIP_LIMIT", limit: 1, depth: 1 };

describe("RendezvousCoordinator (§8.2, FR-105)", () => {
  test("WIP strike → intent; idle sender → one rendezvous notice to the target (bypassWip)", async () => {
    const h = makeCoord();
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.msg).toMatchObject({
      from: "a",
      to: "b",
      kind: "rendezvous",
      id: "rv:a:b:0",
    });
    expect(h.notices[0]?.bypassWip).toBe(true);
    expect(h.notices[0]?.msg.payload).toBe(rendezvousPayload("a", "b"));
    expect(h.persist.calls.write).toContain("a"); // persisted
  });

  test("an accepted counter-send B→A resolves and removes the intent", async () => {
    const h = makeCoord();
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    h.coord.onRouted(msg("b", "a")); // B reached A
    await settle();
    expect(h.store.has("a", "b")).toBe(false);
    expect(h.persist.calls.remove).toContain("a"); // file removed when queue empties
    // a later sweep sends nothing more
    await h.coord.sweep();
    expect(h.notices).toHaveLength(1);
  });

  test("does not notify while the sender is busy; notifies once it goes idle", async () => {
    const h = makeCoord({
      status: new Map([
        ["a", "busy"],
        ["b", "idle"],
      ]),
    });
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    await h.coord.sweep();
    expect(h.notices).toHaveLength(0); // a is busy
    h.status.set("a", "idle");
    await h.coord.sweep();
    expect(h.notices).toHaveLength(1);
  });

  test("no counter-send in the window → rotate & re-notify next round; drop at maxAttempts (warn)", async () => {
    const h = makeCoord({ maxAttempts: 2 });
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    expect(h.notices.map((n) => n.msg.id)).toEqual(["rv:a:b:0"]); // round 1
    // window elapses with no B→A → next sweep expires+rotates, then re-notifies
    h.setClock(T0 + WINDOW + 1);
    await h.coord.sweep();
    expect(h.notices.map((n) => n.msg.id)).toEqual(["rv:a:b:0", "rv:a:b:1"]); // round 2
    // that window elapses too → attempts hit maxAttempts=2 → dropped, no round 3
    h.setClock(T0 + 3 * WINDOW);
    await h.coord.sweep();
    expect(h.notices).toHaveLength(2);
    expect(h.store.has("a", "b")).toBe(false);
    expect(h.logs.some((l) => l.includes("gave up") && l.includes("a→b"))).toBe(true);
  });

  test("an undeliverable notice (topology/unknown) drops the intent with a warn", async () => {
    const h = makeCoord({ routeOk: false });
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    expect(h.store.has("a", "b")).toBe(false); // dropped, not left spinning
    expect(h.logs.some((l) => l.includes("undeliverable"))).toBe(true);
  });

  test("onRouted ignores system kinds and non-intents", async () => {
    const h = makeCoord();
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    h.coord.onRouted(msg("b", "a", "rendezvous")); // a rendezvous notice, not a counter-send
    h.coord.onRouted(msg("b", "a", "nudge"));
    await settle();
    expect(h.store.has("a", "b")).toBe(true); // still pending
  });

  test("ignores non-WIP refusals, self-pairs, and non-agent (operator) participants", async () => {
    const h = makeCoord({
      status: new Map([
        ["a", "idle"],
        ["b", "idle"],
      ]),
    });
    h.coord.onRefused(msg("a", "b"), { code: "TOPOLOGY_DENIED" }); // not a WIP strike
    h.coord.onRefused(msg("a", "a"), wip); // self
    h.coord.onRefused(msg("op", "b"), wip); // op has no status ⇒ not an agent
    h.coord.onRefused(msg("a", "op"), wip); // target not an agent
    await settle();
    expect(h.store.senders()).toEqual([]);
  });

  test("disabled coordinator is inert", async () => {
    const h = makeCoord({ enabled: false });
    h.coord.onRefused(msg("a", "b"), wip);
    await settle();
    await h.coord.sweep();
    expect(h.notices).toHaveLength(0);
    expect(h.store.senders()).toEqual([]);
  });

  test("rehydrate seeds persisted intents on startup", async () => {
    const h = makeCoord();
    await h.persist.store.write("a", { version: 1, intents: [["b", 2]] });
    await h.coord.rehydrate();
    expect(h.store.intents("a")).toEqual([
      { to: "b", attempts: 2, phase: "waiting", windowUntil: 0 },
    ]);
  });

  test("rendezvousState reports waiting (я жду) and awaited (меня ждут) sets", async () => {
    const h = makeCoord({
      status: new Map([
        ["a", "busy"], // busy senders register but don't notify → no side effects
        ["b", "idle"],
        ["c", "busy"],
        ["d", "idle"],
      ]),
    });
    h.coord.onRefused(msg("a", "b"), wip);
    h.coord.onRefused(msg("c", "b"), wip);
    h.coord.onRefused(msg("a", "d"), wip);
    await settle();
    const s = h.coord.rendezvousState();
    expect([...s.waiting].sort()).toEqual(["a", "c"]);
    expect([...s.awaited].sort()).toEqual(["b", "d"]);
    // resolving one pair leaves a still-waiting (a→d) and b still-awaited (c→b)
    h.coord.onRouted(msg("b", "a"));
    await settle();
    const s2 = h.coord.rendezvousState();
    expect([...s2.waiting].sort()).toEqual(["a", "c"]);
    expect([...s2.awaited].sort()).toEqual(["b", "d"]);
    // drain the rest → empty
    h.coord.onRouted(msg("d", "a"));
    h.coord.onRouted(msg("b", "c"));
    await settle();
    expect(h.coord.rendezvousState()).toEqual({ waiting: [], awaited: [] });
  });

  // §15.4 / §10.16: a broadcast is one-directional and must be fully decoupled from
  // rendezvous — a broadcast copy neither registers (onRefused) nor resolves (onRouted)
  // an intent, even though the fan-out fires onRouted per member for transport visibility.
  describe("broadcast copies are decoupled from rendezvous (§10.16)", () => {
    test("a per-member WIP strike on a broadcast copy registers NO intent", async () => {
      const h = makeCoord();
      h.coord.onRefused(msg("a", "b", "broadcast"), wip);
      await settle();
      expect(h.store.has("a", "b")).toBe(false);
      expect(h.notices).toHaveLength(0);
      expect(h.coord.rendezvousState()).toEqual({ waiting: [], awaited: [] });
    });

    test("a broadcast copy from=S→to=M does NOT resolve a real intent (M,S)", async () => {
      const h = makeCoord();
      // A genuine intent (b→a): b was refused reaching a.
      h.coord.onRefused(msg("b", "a"), wip);
      await settle();
      expect(h.store.has("b", "a")).toBe(true);
      // A broadcast copy a→b (from a to member b) must NOT be mistaken for the
      // counter-send that fulfils intent (b,a).
      h.coord.onRouted(msg("a", "b", "broadcast"));
      await settle();
      expect(h.store.has("b", "a")).toBe(true); // intent survives
      // The real counter-send (an ordinary message) still resolves it.
      h.coord.onRouted(msg("a", "b"));
      await settle();
      expect(h.store.has("b", "a")).toBe(false);
    });
  });
});
