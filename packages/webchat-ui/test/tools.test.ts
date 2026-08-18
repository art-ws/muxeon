// What the header toolbar may show and what it remembers (§12.10, FR-171/FR-174,
// T279). The rules that must not drift: a pinned tool appears EXACTLY when its
// menu item would (§12.10.7-Q1 — hidden, never printed dead), nothing is pinned
// by default (Q2), and a stored set that no longer matches the catalogue must
// degrade instead of leaving holes in the bar.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOOLS,
  TOOLS,
  type ToolId,
  loadToolbar,
  sameToolSurface,
  saveToolbar,
  toggleTool,
  visibleTools,
} from "../src/tools";
import type { PeerInfo } from "../src/types";

const agent = (extra: Partial<PeerInfo> = {}): PeerInfo => ({
  name: "researcher",
  status: "idle",
  queueDepth: 0,
  unread: 0,
  actions: { shutdown: true, reload: true, pause: true },
  ...extra,
});

const person: PeerInfo = {
  name: "operator-web",
  type: "user",
  status: null,
  presence: "online",
  queueDepth: 0,
  unread: 0,
  actions: { shutdown: false, reload: false, pause: true },
};

const group: PeerInfo = {
  name: "backend",
  type: "group",
  status: null,
  queueDepth: 0,
  unread: 0,
};

const ids = (enabled: readonly ToolId[], peer: PeerInfo | undefined): readonly string[] =>
  visibleTools(new Set(enabled), peer).map((tool) => tool.id);

const ALL: readonly ToolId[] = TOOLS.map((tool) => tool.id);

// a storage stub with the same surface prefs.ts/visibility.ts inject
const store = (
  initial?: string,
): { getItem: () => string | null; setItem: (k: string, v: string) => void; written?: string } => {
  const box: { value: string | null; written?: string } = { value: initial ?? null };
  return {
    getItem: () => box.value,
    setItem: (_key, value) => {
      box.value = value;
      box.written = value;
    },
    get written() {
      return box.written;
    },
  } as ReturnType<typeof store>;
};

describe("the catalogue (FR-171)", () => {
  test("ids are unique — they are persistence keys", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  test("every tool carries a label, a hint and an icon", () => {
    for (const tool of TOOLS) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.hint.length).toBeGreaterThan(0);
      expect(typeof tool.icon).toBe("function");
    }
  });

  test("every destructive tool asks for a second click", () => {
    for (const tool of TOOLS) {
      if (tool.danger === true) expect(tool.confirm).toBe(true);
    }
  });

  test("sign out arms too — a topbar button has no menu to open first", () => {
    const logout = TOOLS.find((tool) => tool.id === "logout");
    expect(logout?.confirm).toBe(true);
  });
});

describe("what the bar prints (FR-172)", () => {
  test("nothing is pinned by default", () => {
    expect([...DEFAULT_TOOLS]).toEqual([]);
    expect(ids([], agent())).toEqual([]);
  });

  test("with a full agent open, every pinned tool shows — in catalogue order", () => {
    // the enabled set is built in a scrambled order on purpose
    expect(ids(["logout", "console", "shutdown", "export"], agent())).toEqual([
      "console",
      "export",
      "shutdown",
      "logout",
    ]);
  });

  test("no chat open ⇒ chat tools vanish, panel tools stay", () => {
    expect(ids(ALL, undefined)).toEqual(["settings", "logout"]);
  });

  test("a broadcast target has no status and no lifecycle — no chat tools", () => {
    expect(ids(ALL, group)).toEqual(["settings", "logout"]);
  });

  test("a person has history and DND but no terminal and no lifecycle", () => {
    expect(ids(ALL, person)).toEqual(["export", "clear", "pause", "settings", "logout"]);
  });

  test("a federated agent keeps history, loses the console (§18.4)", () => {
    const remote = agent({
      name: "ceo@hub",
      server: "hub",
      actions: { shutdown: false, reload: false, pause: false },
    });
    expect(ids(ALL, remote)).toEqual(["export", "clear", "settings", "logout"]);
  });

  test("lifecycle tools follow the server's action flags, not a guess", () => {
    const limited = agent({ actions: { shutdown: false, reload: true, pause: false } });
    expect(ids(["pause", "reload", "shutdown"], limited)).toEqual(["reload"]);
  });

  test("an older server without a pause flag offers no pause button", () => {
    const old = agent({ actions: { shutdown: true, reload: true } });
    expect(ids(["pause"], old)).toEqual([]);
  });
});

// T280: the panel hands the open peer up on EVERY store change. If the header
// took each of those as news, it re-rendered the whole app — and the console,
// mounted under it, tore its terminal down and rebuilt it (the blink the
// operator saw). The bar only reads these fields, so only these count as news.
describe("what counts as a change for the bar (T280)", () => {
  test("a status push, a queue tick or a fresh object are NOT news", () => {
    expect(sameToolSurface(agent(), agent())).toBe(true);
    expect(sameToolSurface(agent(), agent({ status: "busy" }))).toBe(true);
    expect(sameToolSurface(agent(), agent({ queueDepth: 7, unread: 3 }))).toBe(true);
    expect(sameToolSurface(agent(), agent({ busySince: 12345, atWipLimit: true }))).toBe(true);
  });

  test("anything a button reads IS news", () => {
    expect(sameToolSurface(agent(), agent({ name: "writer" }))).toBe(false);
    expect(sameToolSurface(agent(), agent({ paused: true }))).toBe(false);
    expect(sameToolSurface(agent(), agent({ title: "Researcher" }))).toBe(false);
    expect(sameToolSurface(agent(), agent({ type: "user" }))).toBe(false);
    expect(sameToolSurface(agent(), agent({ server: "hub" }))).toBe(false);
    expect(
      sameToolSurface(agent(), agent({ actions: { shutdown: false, reload: true, pause: true } })),
    ).toBe(false);
  });

  test("opening and closing a chat is news in both directions", () => {
    expect(sameToolSurface(undefined, undefined)).toBe(true);
    expect(sameToolSurface(undefined, agent())).toBe(false);
    expect(sameToolSurface(agent(), undefined)).toBe(false);
  });
});

describe("the pinned set (FR-173/FR-174)", () => {
  test("toggling is immutable and reversible", () => {
    const one = toggleTool(DEFAULT_TOOLS, "console");
    expect([...one]).toEqual(["console"]);
    expect([...DEFAULT_TOOLS]).toEqual([]); // the original is untouched
    expect([...toggleTool(one, "console")]).toEqual([]);
  });

  test("round-trips through storage in catalogue order", () => {
    const storage = store();
    saveToolbar(new Set<ToolId>(["logout", "console"]), storage);
    expect(storage.written).toBe('["console","logout"]');
    expect([...loadToolbar(storage)]).toEqual(["console", "logout"]);
  });

  test("a missing key means the default, not a crash", () => {
    expect([...loadToolbar(store())]).toEqual([]);
  });

  test("junk, a non-array and a wrong shape all fall back to the default", () => {
    expect([...loadToolbar(store("{oops"))]).toEqual([]);
    expect([...loadToolbar(store('"console"'))]).toEqual([]);
    expect([...loadToolbar(store('{"console":true}'))]).toEqual([]);
  });

  test("an id the catalogue no longer knows is dropped, the rest survives", () => {
    expect([...loadToolbar(store('["console","screen-live",7]'))]).toEqual(["console"]);
  });

  test("a blocked storage degrades silently in both directions", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect([...loadToolbar(blocked)]).toEqual([]);
    expect(() => saveToolbar(new Set<ToolId>(["console"]), blocked)).not.toThrow();
  });
});
