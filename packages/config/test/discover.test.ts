import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverConfig, parseConfigArg } from "../src/discover";
import { ConfigError } from "../src/error";
import { loadConfig } from "../src/load";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-discover-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("config discovery (§7.4, FR-32)", () => {
  test("an explicit path is used as-is and derives <config_dir> + base paths", () => {
    const file = join(root, "custom.json");
    writeFileSync(file, "{}");
    const loc = discoverConfig({ explicitPath: file });
    expect(loc.configFile).toBe(file);
    expect(loc.configDir).toBe(root);
    expect(loc.queueDir).toBe(join(root, "queue"));
    expect(loc.stateDir).toBe(join(root, "state"));
    expect(loc.routinesDir).toBe(join(root, "routines"));
    expect(loc.envFile).toBe(join(root, ".env"));
  });

  test("an explicit path that does not exist is fatal", () => {
    expect(() => discoverConfig({ explicitPath: join(root, "nope.json") })).toThrow(ConfigError);
  });

  test("convention finds muxeon.config.json in the start dir", () => {
    writeFileSync(join(root, "muxeon.config.json"), "{}");
    expect(discoverConfig({ startDir: root }).configFile).toBe(join(root, "muxeon.config.json"));
  });

  test("convention prefers muxeon.config.json over .muxeon/config.json", () => {
    writeFileSync(join(root, "muxeon.config.json"), "{}");
    mkdirSync(join(root, ".muxeon"));
    writeFileSync(join(root, ".muxeon", "config.json"), "{}");
    expect(discoverConfig({ startDir: root }).configFile).toBe(join(root, "muxeon.config.json"));
  });

  test("convention falls back to .muxeon/config.json", () => {
    mkdirSync(join(root, ".muxeon"));
    writeFileSync(join(root, ".muxeon", "config.json"), "{}");
    const loc = discoverConfig({ startDir: root });
    expect(loc.configFile).toBe(join(root, ".muxeon", "config.json"));
    expect(loc.configDir).toBe(join(root, ".muxeon")); // <config_dir> is the found file's dir
  });

  test("convention walks up to a parent directory", () => {
    writeFileSync(join(root, "muxeon.config.json"), "{}");
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(discoverConfig({ startDir: deep }).configFile).toBe(join(root, "muxeon.config.json"));
  });

  test("the nearest config wins when a child and a parent both have one", () => {
    writeFileSync(join(root, "muxeon.config.json"), "{}");
    const child = join(root, "child");
    mkdirSync(child);
    writeFileSync(join(child, "muxeon.config.json"), "{}");
    expect(discoverConfig({ startDir: child }).configFile).toBe(join(child, "muxeon.config.json"));
  });

  test("not found is fatal and lists the checked paths", () => {
    const deep = join(root, "x", "y");
    mkdirSync(deep, { recursive: true });
    let error: unknown;
    try {
      discoverConfig({ startDir: deep });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("muxeon.config.json");
  });

  test("discovered config can be read and loaded end-to-end", () => {
    const file = join(root, "muxeon.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        server: { port: 8080 },
        agents: [{ name: "researcher", type: "claude", tmux: "r" }],
        topology: {},
      }),
    );
    const loc = discoverConfig({ startDir: root });
    const { config } = loadConfig(readFileSync(loc.configFile, "utf8"), {
      knownAdapterTypes: ["claude"],
    });
    expect(config.agents[0]?.name).toBe("researcher");
  });
});

describe("launcher argument parsing (§7.4)", () => {
  test("a positional path", () => {
    expect(parseConfigArg(["./c.json"])).toBe("./c.json");
  });
  test("--config <path>", () => {
    expect(parseConfigArg(["--config", "/a/c.json"])).toBe("/a/c.json");
  });
  test("--config=<path>", () => {
    expect(parseConfigArg(["--config=/a/c.json"])).toBe("/a/c.json");
  });
  test("no path returns undefined", () => {
    expect(parseConfigArg([])).toBeUndefined();
  });
  test("--config without a value is fatal", () => {
    expect(() => parseConfigArg(["--config"])).toThrow(ConfigError);
  });
});
