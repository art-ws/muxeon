// Launcher + config discovery (§7.4, FR-32). Resolves which config file to load
// and computes <config_dir> — the base for central routines (§6.2), relative
// $ref (§7.2), the gitignored .env (§7.3), the queue root <config_dir>/queue
// (§5.3), and routine state <config_dir>/state (§6). Fail-fast: an explicit path
// that is missing, or no config by convention, is a fatal ConfigError listing the
// paths checked.

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "./error";

// Convention names, in priority order (§7.4).
const CONFIG_NAMES = ["muxeon.config.json", join(".muxeon", "config.json")];

export interface ConfigLocation {
  /** Absolute path to the config file. */
  readonly configFile: string;
  /** <config_dir> — the directory of the config file; base for all derived paths. */
  readonly configDir: string;
  /** Default queue root <config_dir>/queue (overridable by server.queueDir, §5.3). */
  readonly queueDir: string;
  /** Routine state directory <config_dir>/state (§6). */
  readonly stateDir: string;
  /** Central routines directory <config_dir>/routines (§6.2). */
  readonly routinesDir: string;
  /** Gitignored .env path <config_dir>/.env (§7.3). */
  readonly envFile: string;
}

export interface DiscoverOptions {
  /** Explicit path from `--config`/positional; used as-is (must exist). */
  readonly explicitPath?: string;
  /** Where convention search begins (and explicit relative paths resolve); default cwd. */
  readonly startDir?: string;
}

export function discoverConfig(options: DiscoverOptions = {}): ConfigLocation {
  const startDir = resolve(options.startDir ?? process.cwd());
  return options.explicitPath !== undefined
    ? locateExplicit(options.explicitPath, startDir)
    : locateByConvention(startDir);
}

function locateExplicit(explicitPath: string, startDir: string): ConfigLocation {
  const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(startDir, explicitPath);
  if (!isFile(absolute)) {
    throw new ConfigError(`config file not found at "${absolute}"`);
  }
  return locationFrom(absolute);
}

function locateByConvention(startDir: string): ConfigLocation {
  const checked: string[] = [];
  let dir = startDir;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      checked.push(candidate);
      if (isFile(candidate)) return locationFrom(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError(
        `no config found by convention (looked for ${CONFIG_NAMES.join(", ")} from "${startDir}" upward); checked:\n  ${checked.join("\n  ")}`,
      );
    }
    dir = parent;
  }
}

function locationFrom(configFile: string): ConfigLocation {
  const configDir = dirname(configFile);
  return {
    configFile,
    configDir,
    queueDir: join(configDir, "queue"),
    stateDir: join(configDir, "state"),
    routinesDir: join(configDir, "routines"),
    envFile: join(configDir, ".env"),
  };
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Extracts the optional config path from launcher args (§7.4):
 * `muxeon <path>`, `muxeon --config <path>`, or `muxeon --config=<path>`.
 * Operator subcommands (kill/restart/…) are layered on in T33.
 */
export function parseConfigArg(argv: readonly string[]): string | undefined {
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--config") {
      const next = args[i + 1];
      if (next === undefined) throw new ConfigError("--config requires a path argument");
      return next;
    }
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return args.find((arg) => !arg.startsWith("-"));
}
