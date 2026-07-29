import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MINUTE_SPAN_MS,
  TOKEN_RETENTION_MS,
  TokenUsageStore,
  parseTokenCount,
} from "../src/token-usage";

const M = 60_000;
const H = 3_600_000;
const T0 = 100 * H; // a clean hour boundary

describe("parseTokenCount (§12.8, FR-103)", () => {
  test("reads the standalone console gauge", () => {
    expect(parseTokenCount("                         47909 tokens")).toBe(47909);
  });

  test("ignores the streaming '↓ 7.1k tokens' form (not the context gauge)", () => {
    const pane =
      "· Calculating… (1m 54s · ↓ 7.1k tokens)\n\n  ❯ prompt\n            12345 tokens\n";
    expect(parseTokenCount(pane)).toBe(12345);
  });

  test("accepts thousands separators (space / comma / nbsp / narrow-nbsp)", () => {
    expect(parseTokenCount("12 366 tokens")).toBe(12366);
    expect(parseTokenCount("1,234,567 tokens")).toBe(1234567);
    expect(parseTokenCount("47 909 tokens")).toBe(47909);
    expect(parseTokenCount("47 909 tokens")).toBe(47909);
  });

  test("takes the bottom-most gauge when several are present", () => {
    expect(parseTokenCount("100 tokens\n...\n200 tokens\n")).toBe(200);
  });

  test("returns undefined when no gauge is present", () => {
    expect(parseTokenCount("just some console text\nno counter here")).toBeUndefined();
    expect(parseTokenCount("")).toBeUndefined();
  });

  test("reads the Codex '<n>K used' gauge, scaling the suffix (FR-103)", () => {
    expect(parseTokenCount("23.4K used")).toBe(23_400);
    expect(parseTokenCount("166K used")).toBe(166_000);
    expect(parseTokenCount("138K used")).toBe(138_000);
    expect(parseTokenCount("2.5M used")).toBe(2_500_000);
    expect(parseTokenCount("512 used")).toBe(512); // no suffix → plain count
  });

  test("reads the Codex status line as captured (model · cwd · <n>K used)", () => {
    expect(parseTokenCount("gpt-5.6-sol xhigh · /srv/agents/tl · 166K used")).toBe(166_000);
  });

  test("Codex: bottom-most 'used' gauge wins over earlier output", () => {
    const pane =
      "Explored\n  Read a.ts, b.ts\n\n> Write tests for @file\n\n" +
      "gpt-5.6-sol xhigh · /srv/agents/test · 23.4K used\n";
    expect(parseTokenCount(pane)).toBe(23_400);
  });
});

describe("TokenUsageStore (§12.8, FR-103)", () => {
  test("splits into hourly (old) and per-minute (recent) zones on one timeline", () => {
    const store = new TokenUsageStore();
    store.record("a", 100, T0 - 3 * H + 5 * M);
    store.record("a", 200, T0 - 2 * H + 5 * M);
    store.record("a", 300, T0 - 30 * M);
    store.record("a", 350, T0 - 10 * M);

    const series = store.series("a", T0);
    expect(series.minutes).toEqual([
      { t: T0 - 30 * M, tokens: 300 },
      { t: T0 - 10 * M, tokens: 350 },
    ]);
    expect(series.hours).toEqual([
      { t: T0 - 3 * H, tokens: 100 },
      { t: T0 - 2 * H, tokens: 200 },
    ]);
    expect(series.current).toBe(350);
    expect(series.updatedAt).toBe(T0 - 10 * M);
  });

  test("a bucket keeps the MAX gauge; current tracks the latest sample", () => {
    const store = new TokenUsageStore();
    store.record("b", 500, T0);
    store.record("b", 300, T0 + 1_000); // same minute, lower gauge
    const series = store.series("b", T0 + 2_000);
    expect(series.minutes.at(-1)).toEqual({ t: T0, tokens: 500 }); // max in the slot
    expect(series.current).toBe(300); // live latest
  });

  test("prunes minute buckets older than minuteSpan and hours older than 24h", () => {
    const store = new TokenUsageStore();
    store.record("c", 10, T0 - 25 * H); // beyond the 24h window
    store.record("c", 20, T0 - 2 * H); // inside 24h, older than minuteSpan
    store.record("c", 30, T0 - 5 * M); // recent minute
    const series = store.series("c", T0);
    // the >24h sample is gone from both resolutions
    expect(series.hours.some((b) => b.tokens === 10)).toBe(false);
    expect(series.hours).toEqual([{ t: T0 - 2 * H, tokens: 20 }]);
    expect(series.minutes).toEqual([{ t: T0 - 5 * M, tokens: 30 }]);
  });

  test("a wider minuteSpan pulls more samples into the per-minute zone", () => {
    const store = new TokenUsageStore();
    const span = 2 * H;
    store.record("d", 40, T0 - 90 * M, span);
    store.record("d", 50, T0 - 5 * M, span);
    const series = store.series("d", T0);
    // with a 2h span both samples are within per-minute resolution
    expect(series.minutes).toEqual([
      { t: T0 - 90 * M, tokens: 40 },
      { t: T0 - 5 * M, tokens: 50 },
    ]);
  });

  test("empty series for an unknown agent", () => {
    const store = new TokenUsageStore();
    expect(store.series("nobody", T0)).toEqual({
      minutes: [],
      hours: [],
      current: 0,
      updatedAt: 0,
    });
  });

  test("dirty flag tracks unpersisted samples", () => {
    const store = new TokenUsageStore();
    expect(store.isDirty("a")).toBe(false);
    store.record("a", 1, T0);
    expect(store.isDirty("a")).toBe(true);
    store.clearDirty("a");
    expect(store.isDirty("a")).toBe(false);
    expect(store.agents()).toEqual(["a"]);
  });

  test("snapshot → seed round-trips both resolutions", () => {
    const store = new TokenUsageStore();
    store.record("a", 100, T0 - 3 * H + 5 * M);
    store.record("a", 200, T0 - 2 * H + 5 * M);
    store.record("a", 350, T0 - 10 * M);

    const restored = new TokenUsageStore();
    restored.seed("a", "hour", store.snapshot("a", "hour"), T0);
    restored.seed("a", "minute", store.snapshot("a", "minute"), T0);
    expect(restored.series("a", T0)).toEqual(store.series("a", T0));
  });

  test("seed drops buckets already beyond retention", () => {
    const store = new TokenUsageStore();
    const stale = {
      version: 1 as const,
      buckets: [
        [T0 - (TOKEN_RETENTION_MS + H), 10] as const, // too old
        [T0 - 2 * H, 20] as const, // fresh
      ],
    };
    store.seed("a", "hour", stale, T0);
    expect(store.series("a", T0).hours).toEqual([{ t: T0 - 2 * H, tokens: 20 }]);
  });

  test("default minute span is 60m", () => {
    expect(DEFAULT_MINUTE_SPAN_MS).toBe(60 * M);
  });
});
