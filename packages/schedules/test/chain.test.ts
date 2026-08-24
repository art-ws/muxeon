// The rules that decide what a terminal gets typed into (§21.2, FR-190/FR-193).
// DOM-free and coordinator-free: planning a chain is arithmetic plus refusals,
// and both must hold before any of this is wired to a real pane.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMITS,
  ScheduleError,
  type ScheduleLimits,
  isLive,
  parseDelay,
  planChain,
  validateChainId,
} from "../src/chain";

const T0 = 1_700_000_000_000;
const plan = (items: unknown[], limits: Partial<ScheduleLimits> = {}, id?: string) =>
  planChain(
    { items: items as never, ...(id !== undefined ? { id } : {}) },
    {
      agent: "dev",
      now: T0,
      limits: { ...DEFAULT_LIMITS, ...limits },
      newId: () => "generated",
    },
  );

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ScheduleError ? error.code : `unexpected ${String(error)}`;
  }
  return "no error";
};

describe("delay grammar (§21.2)", () => {
  test("the config's duration tokens, and zero on top of them", () => {
    expect(parseDelay("500ms")).toBe(500);
    expect(parseDelay("45s")).toBe(45_000);
    expect(parseDelay("10m")).toBe(600_000);
    expect(parseDelay("2h")).toBe(7_200_000);
    expect(parseDelay("1d")).toBe(86_400_000);
    // "right after the one before it" is a thing an agent wants to say
    expect(parseDelay("0s")).toBe(0);
  });

  test("junk is refused, never defaulted to zero", () => {
    expect(code(() => parseDelay("soon"))).toBe("INVALID_ARGS");
    expect(code(() => parseDelay("5"))).toBe("INVALID_ARGS");
    expect(code(() => parseDelay("-5s"))).toBe("INVALID_ARGS");
    expect(code(() => parseDelay(5000))).toBe("INVALID_ARGS");
  });
});

describe("cumulative delays (§21.9-Q1)", () => {
  // The operator's decision, against the recommendation: each delay is a GAP
  // from the previous item, not an offset from T0.
  test("each delay is a gap from the previous item, the first from T0", () => {
    const chain = plan([
      { delay: "0s", text: "сохрани состояние" },
      { delay: "3m", command: "clear" },
      { delay: "1m", text: "восстановись" },
    ]);
    expect(chain.items.map((item) => item.at - T0)).toEqual([0, 180_000, 240_000]);
    expect(chain.items.map((item) => item.kind)).toEqual(["message", "command", "message"]);
  });

  test("the first delay decides when the whole chain starts", () => {
    const chain = plan([
      { delay: "1h", text: "первый" },
      { delay: "0s", text: "сразу за ним" },
    ]);
    expect(chain.items[0]?.at).toBe(T0 + 3_600_000);
    expect(chain.items[1]?.at).toBe(T0 + 3_600_000);
  });

  // The point of the operator's model: order cannot be broken by arithmetic.
  test("due times are monotone BY CONSTRUCTION — no delay reorders the chain", () => {
    const chain = plan([
      { delay: "10m", text: "a" },
      { delay: "0s", text: "b" },
      { delay: "5s", text: "c" },
    ]);
    const times = chain.items.map((item) => item.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("what is refused (FR-190)", () => {
  test("an item must carry exactly one form", () => {
    expect(code(() => plan([{ delay: "1m" }]))).toBe("INVALID_ARGS");
    expect(code(() => plan([{ delay: "1m", text: "a", command: "clear" }]))).toBe("INVALID_ARGS");
  });

  test("an empty chain is not a chain", () => {
    expect(code(() => plan([]))).toBe("INVALID_ARGS");
  });

  test("a command carries no leading slash — the catalog stores it without one", () => {
    expect(code(() => plan([{ delay: "1m", command: "/clear" }]))).toBe("INVALID_ARGS");
    expect(plan([{ delay: "1m", command: "clear" }]).items[0]?.command).toBe("clear");
  });

  test("only the closed set of session actions", () => {
    expect(plan([{ delay: "1m", control: "restart" }]).items[0]?.control).toBe("restart");
    expect(code(() => plan([{ delay: "1m", control: "explode" }]))).toBe("INVALID_ARGS");
  });

  test("empty text is refused — an empty reminder reminds of nothing", () => {
    expect(code(() => plan([{ delay: "1m", text: "   " }]))).toBe("INVALID_ARGS");
  });

  // A chain id becomes a FILE NAME (§21.5). It is validated, never sanitized: a
  // silently rewritten id is one the agent cannot cancel with.
  test("a chain id that could escape its directory is refused, not cleaned up", () => {
    expect(code(() => validateChainId("../escape"))).toBe("INVALID_ARGS");
    expect(code(() => validateChainId("a/b"))).toBe("INVALID_ARGS");
    expect(code(() => validateChainId(""))).toBe("INVALID_ARGS");
    expect(validateChainId("self-heal.2026-08-22_1")).toBe("self-heal.2026-08-22_1");
  });
});

describe("caps refuse, they do not trim (FR-193)", () => {
  test("too many items", () => {
    const many = Array.from({ length: 5 }, () => ({ delay: "1m", text: "x" }));
    expect(code(() => plan(many, { maxItems: 4 }))).toBe("SCHEDULE_LIMIT");
  });

  test("the horizon bounds the SUM of the delays, not one of them", () => {
    // three legal hops that together walk past the horizon
    expect(
      code(() =>
        plan(
          [
            { delay: "10m", text: "a" },
            { delay: "10m", text: "b" },
            { delay: "10m", text: "c" },
          ],
          { maxDelayMs: 25 * 60_000 },
        ),
      ),
    ).toBe("SCHEDULE_LIMIT");
  });

  test("a non-zero delay under the floor is refused; zero is excepted", () => {
    expect(code(() => plan([{ delay: "1ms", text: "a" }], { minDelayMs: 5000 }))).toBe(
      "INVALID_ARGS",
    );
    expect(plan([{ delay: "0s", text: "a" }], { minDelayMs: 5000 }).items[0]?.at).toBe(T0);
  });

  test("oversized text is refused by BYTES — Cyrillic is not free", () => {
    expect(code(() => plan([{ delay: "1m", text: "яя" }], { maxText: 3 }))).toBe("SCHEDULE_LIMIT");
    expect(code(() => plan([{ delay: "1m", text: "яя" }], { maxText: 4 }))).toBe("no error");
  });

  test("the per-agent chain cap counts LIVE chains", () => {
    const call = () =>
      planChain(
        { items: [{ delay: "1m", text: "a" }] },
        {
          agent: "dev",
          now: T0,
          limits: { ...DEFAULT_LIMITS, maxChainsPerAgent: 2 },
          liveIds: ["one", "two"],
          newId: () => "three",
        },
      );
    expect(code(call)).toBe("SCHEDULE_LIMIT");
  });

  test("a submitted id may not collide with a live one", () => {
    const call = () =>
      planChain(
        { id: "one", items: [{ delay: "1m", text: "a" }] },
        {
          agent: "dev",
          now: T0,
          limits: DEFAULT_LIMITS,
          liveIds: ["one"],
          newId: () => "x",
        },
      );
    expect(code(call)).toBe("INVALID_ARGS");
  });
});

describe("liveness", () => {
  test("a chain is live while anything is still pending", () => {
    const chain = plan([
      { delay: "0s", text: "a" },
      { delay: "1m", text: "b" },
    ]);
    expect(isLive(chain)).toBe(true);
    const settled = {
      ...chain,
      items: chain.items.map((item) => ({ ...item, state: "fired" as const })),
    };
    expect(isLive(settled)).toBe(false);
  });
});

// Conditional waits (§21.10, FR-200): "fire when the agent is observably done"
// instead of "fire in five minutes". The grammar is closed on purpose — an agent
// must not be able to describe a wait the coordinator cannot honour.
describe("after: quiet (§21.10, FR-200)", () => {
  const one = (item: Record<string, unknown>) => plan([{ text: "go", ...item }]).items[0];

  test('"quiet" takes the server default window; "quiet:90s" names its own', () => {
    expect(one({ after: "quiet" })?.quietMs).toBe(DEFAULT_LIMITS.quietWindowMs);
    expect(one({ after: "quiet:90s" })?.quietMs).toBe(90_000);
    expect(one({ after: "quiet:500ms" })?.quietMs).toBe(500);
  });

  test("the delay becomes optional — a conditional item may have no clock at all", () => {
    const item = one({ after: "quiet" });
    expect(item?.at).toBe(T0); // due immediately; the CONDITION is the wait
    // …and the two compose: wait 10m, and only then start watching for stillness
    expect(one({ delay: "10m", after: "quiet" })?.at).toBe(T0 + 600_000);
  });

  test("the timeout defaults, and a named one is honoured", () => {
    expect(one({ after: "quiet" })?.timeoutMs).toBe(DEFAULT_LIMITS.quietTimeoutMs);
    expect(one({ after: "quiet", timeout: "5m" })?.timeoutMs).toBe(300_000);
  });

  test("a timeout shorter than the window is refused — it could never be met", () => {
    expect(() => one({ after: "quiet:90s", timeout: "30s" })).toThrow(/never be met/);
  });

  test("a timeout without a condition is refused, not silently ignored", () => {
    expect(() => one({ timeout: "5m", delay: "0s" })).toThrow(/only meaningful with/);
  });

  test("an unknown condition is refused — the grammar is closed", () => {
    for (const after of ["idle", "quiet:", "quiet:0s", "when-done", "quiet:5x"]) {
      expect(() => one({ after })).toThrow();
    }
  });

  test("a purely timed item keeps no condition fields at all", () => {
    const item = one({ delay: "30s" });
    expect(item?.quietMs).toBeUndefined();
    expect(item?.timeoutMs).toBeUndefined();
  });
});
