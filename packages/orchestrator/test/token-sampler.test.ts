import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus } from "@muxeon/core";
import { type SamplerAgentView, resolveTokenConfig, startTokenSampler } from "../src/token-sampler";
import { TokenUsageStore } from "../src/token-usage";

const M = 60_000;
const H = 3_600_000;
const T0 = 100 * H;

describe("resolveTokenConfig (§12.8, FR-103)", () => {
  test("fills defaults for an empty block", () => {
    expect(resolveTokenConfig({})).toEqual({
      sampleEveryMs: 60_000,
      minuteSpanMs: 60 * M,
      maxThreshold: 1_000_000,
    });
  });

  test("parses duration strings and keeps the threshold", () => {
    expect(resolveTokenConfig({ sampleEvery: "30s", minuteSpan: "2h", maxThreshold: 500 })).toEqual(
      {
        sampleEveryMs: 30_000,
        minuteSpanMs: 2 * H,
        maxThreshold: 500,
      },
    );
  });

  test("off when absent or disabled", () => {
    expect(resolveTokenConfig(undefined)).toBeUndefined();
    expect(resolveTokenConfig({ enabled: false, sampleEvery: "10s" })).toBeUndefined();
  });
});

describe("startTokenSampler (§12.8, FR-103)", () => {
  let dir: string;
  const view = (name: string, session: string): SamplerAgentView => ({
    name,
    session,
    config: { sampleEveryMs: 60_000, minuteSpanMs: 60 * M, maxThreshold: 1_000_000 },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muxeon-tokens-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("captures + parses + records a due sample, skipping down agents", async () => {
    const store = new TokenUsageStore();
    const statuses: Record<string, AgentStatus> = { a: "idle", b: "down" };
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a"), view("b", "sess-b")],
      status: (name) => statuses[name],
      capture: async (session) => (session === "sess-a" ? "  47909 tokens" : "  999 tokens"),
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(), // don't run the loop; drive manually
    });
    await sampler.sampleOnce(T0);
    expect(store.series("a", T0).current).toBe(47909);
    expect(store.series("b", T0).current).toBe(0); // down → never captured
  });

  test("respects sampleEvery — a second call within the window is a no-op", async () => {
    const store = new TokenUsageStore();
    let captures = 0;
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => {
        captures += 1;
        return `${1000 + captures} tokens`;
      },
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
    });
    await sampler.sampleOnce(T0);
    await sampler.sampleOnce(T0 + 10_000); // < 60s later
    expect(captures).toBe(1);
    await sampler.sampleOnce(T0 + 61_000); // past the window
    expect(captures).toBe(2);
  });

  test("a missing gauge does not record and does not throw", async () => {
    const store = new TokenUsageStore();
    const errors: unknown[] = [];
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => "no counter on this pane",
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
      onError: (e) => errors.push(e),
    });
    await sampler.sampleOnce(T0);
    expect(store.series("a", T0).current).toBe(0);
    expect(errors).toHaveLength(0);
  });

  // The gauge as an ACTIVITY signal (§5.5, FR-195): the only sign of life Muxeon
  // gets from an agent working on its own, with no message crossing the transport.
  test("onChange fires only when the gauge MOVED — never on the first reading", async () => {
    const store = new TokenUsageStore();
    const moves: { agent: string; tokens: number; previous: number; at: number }[] = [];
    let gauge = 1_000;
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => `${gauge} tokens`,
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
      onChange: (agent, tokens, previous, at) => moves.push({ agent, tokens, previous, at }),
    });
    // First reading: we have no previous value, so it says nothing about WHEN the
    // gauge last moved — inventing an activity stamp here would be a lie (§10.34).
    await sampler.sampleOnce(T0);
    expect(moves).toEqual([]);
    // Same value one window later: the agent sat there doing nothing — still silent.
    await sampler.sampleOnce(T0 + 61_000);
    expect(moves).toEqual([]);
    gauge = 1_400;
    await sampler.sampleOnce(T0 + 122_000);
    expect(moves).toEqual([{ agent: "a", tokens: 1_400, previous: 1_000, at: T0 + 122_000 }]);
    // A gauge that DROPS is a move too: /clear and a restart are both activity.
    gauge = 12;
    await sampler.sampleOnce(T0 + 183_000);
    expect(moves).toHaveLength(2);
    expect(moves[1]).toMatchObject({ tokens: 12, previous: 1_400 });
  });

  test("a rehydrated gauge makes the first sample after a restart a real comparison", async () => {
    const store = new TokenUsageStore();
    store.seed("a", "minute", { version: 1, buckets: [[T0 - M, 5_000]] }, T0);
    expect(store.current("a")).toBe(5_000); // survived the restart (§12.8 persistence)
    const moves: number[] = [];
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => "5200 tokens",
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
      onChange: (_a, tokens) => moves.push(tokens),
    });
    await sampler.sampleOnce(T0);
    expect(moves).toEqual([5_200]);
  });

  test("a capture error is reported, not thrown", async () => {
    const store = new TokenUsageStore();
    const errors: unknown[] = [];
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => {
        throw new Error("session gone");
      },
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
      onError: (e) => errors.push(e),
    });
    await sampler.sampleOnce(T0);
    expect(errors).toHaveLength(1);
  });

  test("flush writes minute + hour files; hydrate rebuilds the series", async () => {
    const store = new TokenUsageStore();
    store.record("a", 100, T0 - 2 * H + 5 * M);
    store.record("a", 350, T0 - 10 * M);
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => "",
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
    });
    await sampler.flush(T0);

    const minute = JSON.parse(await readFile(join(dir, "sess-a.minutes.json"), "utf8"));
    const hour = JSON.parse(await readFile(join(dir, "sess-a.hours.json"), "utf8"));
    expect(minute.version).toBe(1);
    expect(hour.version).toBe(1);
    expect(store.isDirty("a")).toBe(false); // clean after flush

    // a fresh store rehydrates the same two-zone series
    const restored = new TokenUsageStore();
    const reader = startTokenSampler({
      store: restored,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => "",
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
    });
    await reader.hydrate(T0);
    expect(restored.series("a", T0)).toEqual(store.series("a", T0));
  });

  test("hydrate on an empty dir is a no-op", async () => {
    const store = new TokenUsageStore();
    const sampler = startTokenSampler({
      store,
      agents: () => [view("a", "sess-a")],
      status: () => "idle",
      capture: async () => "",
      stateDir: dir,
      now: () => T0,
      signal: AbortSignal.abort(),
    });
    await sampler.hydrate(T0);
    expect(store.series("a", T0).current).toBe(0);
  });
});
