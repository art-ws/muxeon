import { describe, expect, test } from "bun:test";
import type { Signal } from "@muxeon/core";
import type { SignalRouter } from "@muxeon/signals";
import type { Routine } from "../src/discover";
import { type StateStore, tickRoutine } from "../src/index";

// in-memory StateStore (owner/id never contain "/" in these tests)
function memStore(): StateStore {
  const map = new Map<string, unknown>();
  const k = (o: string, i: string) => `${o}/${i}`;
  return {
    read: async (o, i) => (map.get(k(o, i)) ?? null) as never,
    write: async (o, i, s) => void map.set(k(o, i), s),
    remove: async (o, i) => void map.delete(k(o, i)),
    list: async () =>
      [...map.keys()].map((key) => {
        const [owner = "", id = ""] = key.split("/");
        return { owner, id };
      }),
  };
}

function recRouter(ok = true): SignalRouter & { sent: Signal[] } {
  const sent: Signal[] = [];
  const router: SignalRouter & { sent: Signal[] } = {
    sent,
    route: async (m) => {
      sent.push(m);
      return ok ? { ok: true, key: "k", filename: "f" } : { ok: false, code: "TOPOLOGY_DENIED" };
    },
  };
  return router;
}

function routine(over: Partial<Routine>): Routine {
  return {
    id: "r",
    owner: "researcher",
    target: "researcher",
    schedule: "once",
    once: true,
    enabled: true,
    body: "do the thing",
    source: "/x.md",
    ...over,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("scheduler — once (§10.4)", () => {
  test("fires once with from=owner, to=target, deterministic id; then never again", async () => {
    const router = recRouter();
    const state = memStore();
    const once = routine({ target: "writer" });
    const deps = { router, state, now: () => at("2026-01-01T00:00:00Z") };

    const first = await tickRoutine(once, deps);
    expect(first.outcome).toBe("fired");
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]).toMatchObject({
      from: "researcher",
      to: "writer",
      payload: "do the thing",
      id: "routine:researcher:r:once",
    });

    const second = await tickRoutine(once, deps); // "restart": state persisted
    expect(second.outcome).toBe("done");
    expect(router.sent).toHaveLength(1); // not re-sent (§10.4)
  });

  test("an `at` in the future is not due; once past, it fires", async () => {
    const router = recRouter();
    const state = memStore();
    const future = routine({ at: "2026-07-01T09:00:00Z" });
    expect(
      (await tickRoutine(future, { router, state, now: () => at("2026-01-01T00:00:00Z") })).outcome,
    ).toBe("not-due");
    expect(
      (await tickRoutine(future, { router, state, now: () => at("2026-08-01T00:00:00Z") })).outcome,
    ).toBe("fired");
  });

  test("a bare `at` is interpreted in the routine's tz (§6.3)", async () => {
    const router = recRouter();
    const state = memStore();
    // 09:00 Moscow = 06:00Z; at 06:30Z it is due, at 05:30Z it is not.
    const r = routine({ at: "2026-07-01T09:00:00", tz: "Europe/Moscow" });
    expect(
      (await tickRoutine(r, { router, state, now: () => at("2026-07-01T05:30:00Z") })).outcome,
    ).toBe("not-due");
    expect(
      (await tickRoutine(r, { router, state, now: () => at("2026-07-01T06:30:00Z") })).outcome,
    ).toBe("fired");
  });
});

describe("scheduler — cron (§10.5)", () => {
  const cron = (over: Partial<Routine> = {}) =>
    routine({ id: "c", schedule: "0 9 * * *", once: false, ...over });

  test("a fresh cron anchors lastRun (no fire); a passed tick fires while enabled", async () => {
    const router = recRouter();
    const state = memStore();
    const c = cron();

    const primed = await tickRoutine(c, { router, state, now: () => at("2026-03-10T08:00:00Z") });
    expect(primed.outcome).toBe("primed");
    expect(router.sent).toHaveLength(0); // never backfilled (§6.3)

    const fired = await tickRoutine(c, { router, state, now: () => at("2026-03-10T09:30:00Z") });
    expect(fired.outcome).toBe("fired");
    expect(fired.signalId).toBe("routine:researcher:c:2026-03-10T09:00:00.000Z");
    expect(router.sent).toHaveLength(1);
  });

  test("a disabled cron does not fire (kill-switch, FR-23)", async () => {
    const router = recRouter();
    const state = memStore();
    const out = await tickRoutine(cron({ enabled: false }), {
      router,
      state,
      now: () => at("2026-03-10T09:30:00Z"),
    });
    expect(out.outcome).toBe("disabled");
    expect(router.sent).toHaveLength(0);
  });
});

describe("scheduler — crash safety + denial (§6, §10.9)", () => {
  test("a crash between enqueue and state-write replays the SAME id (dedup-safe)", async () => {
    const router = recRouter();
    const inner = memStore();
    let crashed = false;
    const crashing: StateStore = {
      ...inner,
      write: async (o, i, s) => {
        if (!crashed) {
          crashed = true;
          throw new Error("crash before persist");
        }
        await inner.write(o, i, s);
      },
    };
    const once = routine({});
    const deps = { router, state: crashing, now: () => at("2026-01-01T00:00:00Z") };

    await tickRoutine(once, deps).catch(() => undefined); // enqueued, then "crashed"
    await tickRoutine(once, deps); // restart: state never persisted → replays

    expect(router.sent.map((m) => m.id)).toEqual([
      "routine:researcher:r:once",
      "routine:researcher:r:once",
    ]); // identical → the dedup window drops the repeat (§10.9)
  });

  test("a denied delivery advances state and does not retry-spam", async () => {
    const router = recRouter(false); // router denies (non-edge target)
    const state = memStore();
    const r = routine({ target: "stranger" });
    const deps = { router, state, now: () => at("2026-01-01T00:00:00Z") };

    expect((await tickRoutine(r, deps)).outcome).toBe("denied");
    expect((await tickRoutine(r, deps)).outcome).toBe("done"); // advanced, not retried
    expect(router.sent).toHaveLength(1);
  });
});
