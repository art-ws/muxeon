// FR-136 — reliable shutdown: graceful stop under a hard watchdog. Guards the
// live finding that a hung stop() wedged deploys forever (operator had to
// `kill -KILL`): whatever stop() does, the handler must reach exit().

import { describe, expect, test } from "bun:test";
import { type ShutdownSignal, createShutdownHandler } from "../src/shutdown";

function harness(overrides: { stop?: () => Promise<void>; watchdogMs?: number } = {}) {
  const exits: number[] = [];
  const warnings: string[] = [];
  const handler = createShutdownHandler({
    stop: overrides.stop ?? (() => Promise.resolve()),
    exit: (code) => exits.push(code),
    warn: (message) => warnings.push(message),
    ...(overrides.watchdogMs !== undefined ? { watchdogMs: overrides.watchdogMs } : {}),
  });
  return { handler, exits, warnings };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createShutdownHandler (FR-136)", () => {
  test("clean stop exits 0 and never fires the watchdog", async () => {
    const { handler, exits, warnings } = harness({ watchdogMs: 5 });
    handler("SIGINT");
    await settle(20);
    expect(exits).toEqual([0]);
    expect(warnings).toEqual([]);
  });

  test.each<[ShutdownSignal, number]>([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])("hung stop → watchdog forces exit 128+signo (%s)", async (signal, code) => {
    const { handler, exits, warnings } = harness({
      stop: () => new Promise<void>(() => {}), // never settles — the live hang
      watchdogMs: 5,
    });
    handler(signal);
    await settle(20);
    expect(exits).toEqual([code]);
    expect(warnings.some((w) => w.includes("watchdog"))).toBe(true);
  });

  test("stop() rejection exits 128+signo with a warning, watchdog cleared", async () => {
    const { handler, exits, warnings } = harness({
      stop: () => Promise.reject(new Error("phase died")),
      watchdogMs: 1000,
    });
    handler("SIGTERM");
    await settle(20);
    expect(exits).toEqual([143]);
    expect(warnings.some((w) => w.includes("phase died"))).toBe(true);
  });

  test("second signal during a stuck stop forces exit immediately", async () => {
    const { handler, exits, warnings } = harness({
      stop: () => new Promise<void>(() => {}),
      watchdogMs: 1000,
    });
    handler("SIGINT");
    handler("SIGINT"); // double Ctrl-C
    expect(exits).toEqual([130]);
    expect(warnings.some((w) => w.includes("second signal"))).toBe(true);
  });
});
