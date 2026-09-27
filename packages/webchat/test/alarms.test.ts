// Agent alarms (§22, FR-202…FR-205, invariant §10.35): the slot, its life, and
// the ONE signal a human resolution sends to the agent.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { type Alarm, AlarmsHub, type AlarmsHubOptions, parseAlarmInput } from "../src/alarms";

const LIMITS = { maxText: 64, maxOptions: 3, maxOptionLength: 10 };

interface Rig {
  hub: AlarmsHub;
  dir: string;
  routed: Signal[];
  pushes: { user: string; agent: string; alarm: Alarm | null }[];
  routeCode: { value: string | undefined };
  online: Set<string>;
  paused: Set<string>;
}

let ids = 0;

async function rig(overrides: Partial<AlarmsHubOptions> = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "alarms-"));
  const routed: Signal[] = [];
  const pushes: Rig["pushes"] = [];
  const routeCode: Rig["routeCode"] = { value: undefined };
  const online = new Set<string>();
  const paused = new Set<string>();
  const hub = new AlarmsHub({
    enabled: true,
    limits: LIMITS,
    dir,
    isAgent: (name) => name === "dev" || name === "qa",
    // dev has two human neighbours; qa has none
    audienceOf: (agent) => (agent === "dev" ? ["alex", "maria"] : []),
    isPaused: (user) => paused.has(user),
    route: async (signal) => {
      if (routeCode.value !== undefined) return { ok: false, code: routeCode.value };
      routed.push(signal);
      return { ok: true };
    },
    now: () => 1000,
    newId: () => `a${++ids}`,
    ...overrides,
  });
  hub.attachSurface({
    push: (user, agent, alarm) => pushes.push({ user, agent, alarm }),
    watching: (user) => online.has(user),
  });
  return { hub, dir, routed, pushes, routeCode, online, paused };
}

const raise = (r: Rig, input: Record<string, unknown> = {}) =>
  r.hub.call("dev", { text: "migration failed", level: 0.85, ...input });

describe("the agent's door (§22.3)", () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  test("raise: the slot, the audience, and who hears it loudly right now", async () => {
    r.online.add("alex");
    r.online.add("maria");
    r.paused.add("maria"); // DND: sees the quiet part only (§22.11-Q3)
    const out = await raise(r, { options: ["Roll back", "Fix fwd"] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.state).toBe("raised");
    expect(out.audience).toEqual(["alex", "maria"]);
    expect(out.watching).toBe(1);
    expect(r.hub.slot("dev")).toMatchObject({
      state: "raised",
      level: 0.85,
      options: ["Roll back", "Fix fwd"],
    });
    // pushed to BOTH audience members — DND is the panel's business (quiet part)
    expect(r.pushes.map((push) => push.user)).toEqual(["alex", "maria"]);
    expect(r.routed).toEqual([]); // a cry routes nothing (§22.1)
  });

  test("a new alarm REPLACES the active one — one slot, the latest is the actual one", async () => {
    const first = await raise(r);
    const second = await raise(r, { text: "worse now", level: 1 });
    expect(second.ok && second.replaced).toEqual({
      id: first.ok ? first.id : "",
      state: "superseded",
    });
    expect(r.hub.slot("dev")?.text).toBe("worse now");
    expect(r.hub.active("alex")).toHaveLength(1);
  });

  test("replacing a RESOLVED alarm reports how it ended and who ended it", async () => {
    const first = await raise(r);
    if (!first.ok) throw new Error("raise");
    await r.hub.seen("alex", "dev", first.id); // no options ⇒ acknowledged
    const second = await raise(r);
    expect(second.ok && second.replaced).toEqual({
      id: first.id,
      state: "acknowledged",
      resolvedBy: "alex",
    });
  });

  test("clear withdraws the active alarm and pushes null; nothing to clear is NO_ALARM", async () => {
    await raise(r);
    const out = await r.hub.call("dev", { clear: true });
    expect(out.ok && out.state).toBe("withdrawn");
    expect(r.hub.active("alex")).toEqual([]);
    expect(r.pushes.at(-1)?.alarm).toBeNull();
    expect(r.routed).toEqual([]); // the agent's own act sends it nothing
    const again = await r.hub.call("dev", { clear: true });
    expect(!again.ok && again.code).toBe("NO_ALARM");
  });

  test("no human neighbour ⇒ NO_AUDIENCE, not a quiet success", async () => {
    const out = await r.hub.call("qa", { text: "help", level: 1 });
    expect(!out.ok && out.code).toBe("NO_AUDIENCE");
    expect(r.hub.slot("qa")).toBeUndefined();
  });

  test("a non-agent cannot raise one", async () => {
    const out = await r.hub.call("alex", { text: "help", level: 1 });
    expect(!out.ok && out.code).toBe("UNKNOWN_PEER");
  });

  test("switched off ⇒ ALARMS_DISABLED everywhere, and nothing is shown", async () => {
    const off = await rig({ enabled: false });
    const out = await raise(off);
    expect(!out.ok && out.code).toBe("ALARMS_DISABLED");
    expect(off.hub.active("alex")).toEqual([]);
    const seen = await off.hub.seen("alex", "dev", "x");
    expect(!seen.ok && seen.code).toBe("ALARMS_DISABLED");
  });
});

describe("input validation (§22.3) — refused, never clamped", () => {
  const parse = (input: unknown) => parseAlarmInput(input, LIMITS);

  test("level is required, finite and within [0, 1]", () => {
    expect(parse({ text: "x" })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: 1.2 })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: -0.1 })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: Number.NaN })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: "0.5" })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: 0 })).toEqual({ clear: false, text: "x", level: 0 });
    expect(parse({ text: "x", level: 1 })).toEqual({ clear: false, text: "x", level: 1 });
  });

  test("text is required and capped in BYTES", () => {
    expect(parse({ level: 0.5 })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "  ", level: 0.5 })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "я".repeat(33), level: 0.5 })).toStartWith("ALARM_LIMIT"); // 66 bytes
  });

  test("options: non-empty, one-line, unique, capped in count and length", () => {
    const at = (options: unknown) => parse({ text: "x", level: 0.5, options });
    expect(at([])).toStartWith("INVALID_ARGS");
    expect(at(["a", ""])).toStartWith("INVALID_ARGS");
    expect(at(["a\nb"])).toStartWith("INVALID_ARGS");
    expect(at(["a", "a"])).toStartWith("INVALID_ARGS");
    expect(at(["a", "b", "c", "d"])).toStartWith("ALARM_LIMIT");
    expect(at(["x".repeat(11)])).toStartWith("ALARM_LIMIT");
    expect(at(["Откатить"])).toMatchObject({ options: ["Откатить"] }); // chars, not bytes
  });

  test("clear takes no other field; unknown fields are refused", () => {
    expect(parse({ clear: true })).toEqual({ clear: true });
    expect(parse({ clear: true, text: "x" })).toStartWith("INVALID_ARGS");
    expect(parse({ clear: false })).toStartWith("INVALID_ARGS");
    expect(parse({ text: "x", level: 0.5, to: "alex" })).toStartWith("INVALID_ARGS");
  });
});

describe("a human resolves it (§22.2/§22.5)", () => {
  let r: Rig;
  let id: string;
  beforeEach(async () => {
    r = await rig();
    const out = await raise(r, { options: ["Roll back", "Fix fwd"] });
    if (!out.ok) throw new Error("raise");
    id = out.id;
  });

  test("seen on an alarm WITH options goes quiet and keeps the question open", async () => {
    const out = await r.hub.seen("alex", "dev", id);
    expect(out.ok && out.alarm).toMatchObject({ state: "seen", resolvedBy: "alex" });
    expect(r.routed).toEqual([]); // seeing is not answering (§22.11-Q2)
    expect(r.hub.active("maria")).toHaveLength(1); // still showing — quietly — for everyone
    const again = await r.hub.seen("maria", "dev", id);
    expect(again.ok && again.alarm.resolvedBy).toBe("alex"); // idempotent: first one stays
  });

  test("an answer is ONE notice to the agent, with the option and the quote", async () => {
    const out = await r.hub.answer("maria", "dev", id, 0);
    expect(out.ok && out.alarm).toMatchObject({
      state: "answered",
      answer: 0,
      resolvedBy: "maria",
    });
    expect(r.routed).toHaveLength(1);
    const signal = r.routed[0] as Signal;
    expect(signal).toMatchObject({
      id: `${id}:resolution`,
      from: "maria",
      to: "dev",
      kind: "message",
      expectsReply: false, // §22.11-Q5: a notice, never a turn with a contract
      origin: `alarm:${id}:answer`,
    });
    expect(signal.payload).toContain("option 1 of 2: «Roll back»");
    expect(signal.payload).toContain("(level 0.85)"); // the agent's own scale, not percent
    expect(signal.payload).toContain("Your alarm was: «migration failed»");
    expect(out.ok && out.signal?.id).toBe(signal.id); // for the panel's history record
    expect(r.hub.active("alex")).toEqual([]);
    expect(r.pushes.at(-1)?.alarm).toBeNull();
  });

  test("a refused answer leaves the question OPEN — nothing lost in silence", async () => {
    r.routeCode.value = "AGENT_PAUSED";
    const out = await r.hub.answer("alex", "dev", id, 1);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("AGENT_PAUSED");
    expect(out.notify).toEqual({ delivered: false, code: "AGENT_PAUSED" });
    expect(r.hub.slot("dev")?.state).toBe("raised");
    r.routeCode.value = undefined;
    const retry = await r.hub.answer("alex", "dev", id, 1);
    expect(retry.ok && retry.alarm.state).toBe("answered");
  });

  test("two people, two options, at once ⇒ ONE answer (compare-and-set, §10.35)", async () => {
    const [a, b] = await Promise.all([
      r.hub.answer("alex", "dev", id, 0),
      r.hub.answer("maria", "dev", id, 1),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(!b.ok && b.code).toBe("ALARM_RESOLVED");
    expect(!b.ok && b.alarm?.resolvedBy).toBe("alex");
    expect(r.routed).toHaveLength(1);
  });

  test("an answer to a REPLACED question is refused — it would answer the wrong thing", async () => {
    await raise(r, { text: "a different problem" });
    const out = await r.hub.answer("alex", "dev", id, 0);
    expect(!out.ok && out.code).toBe("ALARM_SUPERSEDED");
    expect(r.routed).toEqual([]);
  });

  test("an option out of range is UNKNOWN_OPTION", async () => {
    for (const option of [2, -1, 0.5, "0"]) {
      const out = await r.hub.answer("alex", "dev", id, option);
      expect(!out.ok && out.code).toBe("UNKNOWN_OPTION");
    }
  });

  test("dismiss closes a SEEN alarm without an answer — one notice, no option", async () => {
    const early = await r.hub.dismiss("alex", "dev", id);
    expect(!early.ok && early.code).toBe("ALARM_STATE"); // not seen yet
    await r.hub.seen("alex", "dev", id);
    const out = await r.hub.dismiss("maria", "dev", id);
    expect(out.ok && out.alarm).toMatchObject({ state: "acknowledged", resolvedBy: "maria" });
    expect(r.routed).toHaveLength(1);
    expect(r.routed[0]?.payload).toContain("without choosing an option");
    expect(r.routed[0]?.expectsReply).toBe(false);
  });

  test("a stranger is told nothing exists (§10.22)", async () => {
    const out = await r.hub.seen("mallory", "dev", id);
    expect(!out.ok && out.code).toBe("UNKNOWN_ALARM");
    expect(r.hub.active("mallory")).toEqual([]);
  });
});

describe("a cry that asks for nothing (§22.2)", () => {
  test("the first interaction acknowledges it, and the agent learns it was heard", async () => {
    const r = await rig();
    const out = await raise(r);
    if (!out.ok) throw new Error("raise");
    const seen = await r.hub.seen("alex", "dev", out.id);
    expect(seen.ok && seen.alarm.state).toBe("acknowledged");
    expect(r.routed).toHaveLength(1);
    expect(r.routed[0]).toMatchObject({
      id: `${out.id}:resolution`,
      expectsReply: false,
      origin: `alarm:${out.id}:ack`,
    });
    expect(r.routed[0]?.payload).toContain("you were heard");
  });

  test("the loud part stops even when the receipt cannot be delivered", async () => {
    const r = await rig();
    const out = await raise(r);
    if (!out.ok) throw new Error("raise");
    r.routeCode.value = "WIP_LIMIT";
    const seen = await r.hub.seen("alex", "dev", out.id);
    expect(seen.ok && seen.alarm.state).toBe("acknowledged");
    expect(seen.ok && seen.notify).toEqual({ delivered: false, code: "WIP_LIMIT" });
    expect(seen.ok && seen.signal).toBeUndefined(); // nothing to record in the history
  });
});

describe("the slot survives a restart (§22.9)", () => {
  test("load reads the slots back and prunes an agent that left the topology", async () => {
    const r = await rig();
    await raise(r, { options: ["A"] });
    await writeFile(
      join(r.dir, "gone.json"),
      JSON.stringify({ id: "x", agent: "gone", state: "raised" }),
    );
    const again = new AlarmsHub({
      enabled: true,
      limits: LIMITS,
      dir: r.dir,
      isAgent: (name) => name === "dev",
      audienceOf: () => ["alex"],
    });
    await again.load();
    expect(again.active("alex").map((alarm) => alarm.agent)).toEqual(["dev"]);
    expect((await readdir(r.dir)).sort()).toEqual(["dev.json"]);
    const onDisk = JSON.parse(await readFile(join(r.dir, "dev.json"), "utf8"));
    expect(onDisk).toMatchObject({ agent: "dev", state: "raised", options: ["A"] });
  });

  test("a missing directory is simply an empty hub", async () => {
    const hub = new AlarmsHub({
      enabled: true,
      limits: LIMITS,
      dir: join(tmpdir(), "alarms-never-created-x"),
      isAgent: () => true,
      audienceOf: () => [],
    });
    await hub.load();
    expect(hub.active("alex")).toEqual([]);
  });
});
