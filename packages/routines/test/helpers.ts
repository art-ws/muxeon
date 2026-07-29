// Shared fakes for the routines scheduler tests.

import type { Signal } from "@teamai/core";
import type { SignalRouter } from "@teamai/signals";
import type { Routine } from "../src/discover";
import type { StateStore } from "../src/state";

export function memStore(): StateStore {
  const map = new Map<string, unknown>();
  const k = (o: string, i: string) => `${o}\x00${i}`;
  return {
    read: async (o, i) => (map.get(k(o, i)) ?? null) as never,
    write: async (o, i, s) => void map.set(k(o, i), s),
    remove: async (o, i) => void map.delete(k(o, i)),
    list: async () =>
      [...map.keys()].map((key) => {
        const [owner = "", id = ""] = key.split("\x00");
        return { owner, id };
      }),
  };
}

export function recRouter(ok = true): SignalRouter & { sent: Signal[] } {
  const sent: Signal[] = [];
  return {
    sent,
    route: async (m) => {
      sent.push(m);
      return ok ? { ok: true, key: "k", filename: "f" } : { ok: false, code: "TOPOLOGY_DENIED" };
    },
  };
}

export function routine(over: Partial<Routine>): Routine {
  return {
    id: "r",
    owner: "researcher",
    target: "researcher",
    schedule: "0 9 * * *",
    once: false,
    enabled: true,
    body: "tick",
    source: "/x.md",
    ...over,
  };
}

export const ms = (iso: string): number => Date.parse(iso);
