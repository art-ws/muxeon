// §8 architecture guard (T02, NFR-3, R1).
//
// Encodes SPEC.md §8's acyclic package layering and verifies the workspace
// conforms — both at the declared-dependency level (package.json) and at the
// real-import level (source `from "@teamai/x"`). This is the structural guard
// that makes "обход графа невозможен импортом" (§8) a tested invariant: a
// dependency edge against the layering, a cycle, or any consumer of @teamai/queue
// other than @teamai/orchestrator fails the suite.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG_DIR = join(ROOT, "packages");
const SCOPE = "@teamai/";

// SPEC.md §8 layering (lower index = lower layer). The 13-package set is fixed:
// core < {config, tmux, queue} < adapters < orchestrator
//      < {lifecycle, signals, routines, channels, webchat, federation} < server
// webchat-ui (§12.7) is BUILD-TIME ONLY: bundled browser assets served as
// statics by webchat — never a runtime import, so it sits outside the layering
// (it must not depend on any @teamai package and nothing may depend on it).
const LAYER: Record<string, number> = {
  core: 0,
  config: 1,
  tmux: 1,
  queue: 1,
  adapters: 2,
  orchestrator: 3,
  lifecycle: 4,
  signals: 4,
  routines: 4,
  channels: 4,
  webchat: 4,
  federation: 4,
  server: 5,
};
const ASSET_PACKAGES = new Set(["webchat-ui"]);
const EXPECTED_PACKAGES = [...Object.keys(LAYER), ...ASSET_PACKAGES].sort();

function layerOf(name: string): number {
  const layer = LAYER[name];
  if (layer === undefined) throw new Error(`unknown package: ${name}`);
  return layer;
}

// Same-layer edges are forbidden by default (acyclicity within a layer), except
// this explicit allowlist (SPEC.md §8.2: routines drives delivery via signals;
// §12.1: webchat implements channels' ChannelConnector contract §8.4).
const SAME_LAYER_ALLOWED: Record<string, readonly string[]> = {
  routines: ["signals"],
  webchat: ["channels"],
};

// SPEC.md §8 / §10.2: queue's mutating ops are not exported above orchestrator —
// only orchestrator may depend on @teamai/queue.
const QUEUE = "queue";
const QUEUE_CONSUMER = "orchestrator";

interface PkgJson {
  name?: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
}

function readPkg(dir: string): PkgJson {
  return JSON.parse(readFileSync(join(PKG_DIR, dir, "package.json"), "utf8")) as PkgJson;
}

function packageDirs(): string[] {
  return readdirSync(PKG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Bare (unscoped) names of the @teamai/* workspace dependencies declared by a package.
function declaredDeps(pkg: PkgJson): string[] {
  return Object.keys(pkg.dependencies ?? {})
    .filter((n) => n.startsWith(SCOPE))
    .map((n) => n.slice(SCOPE.length));
}

// Bare names of @teamai/* packages imported by any source file under packages/<pkg>/src.
function importedDeps(pkg: string): Set<string> {
  const found = new Set<string>();
  const re = /(?:from|import)\s*\(?\s*["']@teamai\/([\w-]+)["']/g;
  for (const rel of new Bun.Glob("src/**/*.{ts,tsx}").scanSync(join(PKG_DIR, pkg))) {
    const src = readFileSync(join(PKG_DIR, pkg, rel), "utf8");
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (name) found.add(name);
    }
  }
  return found;
}

// Returns a cycle as a node list (e.g. ["a","b","a"]) or null if the graph is acyclic.
function findCycle(graph: Record<string, string[]>): string[] | null {
  const onStack = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (u: string): string[] | null => {
    onStack.add(u);
    stack.push(u);
    for (const v of graph[u] ?? []) {
      if (onStack.has(v)) {
        return [...stack.slice(stack.indexOf(v)), v];
      }
      if (!done.has(v)) {
        const cyc = visit(v);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    onStack.delete(u);
    done.add(u);
    return null;
  };

  for (const u of Object.keys(graph)) {
    if (!done.has(u)) {
      const cyc = visit(u);
      if (cyc) return cyc;
    }
  }
  return null;
}

const dirs = packageDirs();
const graph: Record<string, string[]> = {};
for (const d of dirs) graph[d] = declaredDeps(readPkg(d));

describe("§8 package layering", () => {
  test("exactly the 13 spec packages exist, named @teamai/<dir>", () => {
    expect(dirs).toEqual(EXPECTED_PACKAGES);
    for (const d of dirs) {
      const pkg = readPkg(d);
      expect(pkg.name).toBe(`${SCOPE}${d}`);
      expect(pkg.private).toBe(true);
      expect(pkg.type).toBe("module");
      if (ASSET_PACKAGES.has(d)) continue; // assets ship dist/, not a src entry
      expect(existsSync(join(PKG_DIR, d, "src", "index.ts"))).toBe(true);
    }
  });

  test("every runtime package resolves to its src entry", () => {
    for (const d of dirs) {
      if (ASSET_PACKAGES.has(d)) continue;
      const pkg = readPkg(d);
      expect(pkg.types).toBe("src/index.ts");
      expect(pkg.main).toBe("src/index.ts");
    }
  });

  test("asset packages are graph-isolated: no @teamai edges either way (§12.7)", () => {
    for (const d of ASSET_PACKAGES) {
      expect(declaredDeps(readPkg(d))).toEqual([]);
      expect([...importedDeps(d)]).toEqual([]);
    }
    for (const [pkg, deps] of Object.entries(graph)) {
      for (const dep of deps) expect(ASSET_PACKAGES.has(dep)).toBe(false);
      void pkg;
    }
  });

  test("declared dependencies are real @teamai packages, no self-edges", () => {
    for (const [pkg, deps] of Object.entries(graph)) {
      for (const dep of deps) {
        expect(EXPECTED_PACKAGES).toContain(dep);
        expect(dep).not.toBe(pkg);
      }
    }
  });

  test("no dependency edge points up a layer", () => {
    for (const [pkg, deps] of Object.entries(graph)) {
      for (const dep of deps) {
        const up = layerOf(dep) > layerOf(pkg);
        const sameLayer = layerOf(dep) === layerOf(pkg);
        const allowedSame = (SAME_LAYER_ALLOWED[pkg] ?? []).includes(dep);
        if (up || (sameLayer && !allowedSame)) {
          throw new Error(
            `Illegal §8 edge ${pkg}(L${layerOf(pkg)}) → ${dep}(L${layerOf(dep)}). Dependencies must point to a strictly lower layer (see SPEC.md §8).`,
          );
        }
      }
    }
  });

  test("@teamai/queue is consumed only by @teamai/orchestrator (§8, §10.2)", () => {
    for (const [pkg, deps] of Object.entries(graph)) {
      if (deps.includes(QUEUE)) expect(pkg).toBe(QUEUE_CONSUMER);
    }
  });

  test("the package dependency graph is acyclic", () => {
    expect(findCycle(graph)).toBeNull();
  });

  test("every declared workspace dependency resolves (workspace protocol)", () => {
    for (const [pkg, deps] of Object.entries(graph)) {
      for (const dep of deps) {
        expect(() => Bun.resolveSync(`${SCOPE}${dep}`, join(PKG_DIR, pkg))).not.toThrow();
      }
    }
  });

  test("source imports stay within declared deps and the §8 layering", () => {
    for (const pkg of dirs) {
      const declared = new Set(graph[pkg]);
      for (const dep of importedDeps(pkg)) {
        if (dep === pkg) continue; // intra-package import by scoped name
        expect(declared.has(dep)).toBe(true);
        expect(layerOf(dep) <= layerOf(pkg)).toBe(true);
        if (dep === QUEUE) expect(pkg).toBe(QUEUE_CONSUMER);
      }
    }
  });
});
