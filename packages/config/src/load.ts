// The canonical config load pipeline (§7.2): parse → $ref → $env → validate. The
// monolith is the base case; $ref decomposition (optional, §10.6) assembles it
// first so $env markers inside referenced files also expand. Validation is
// structural (§7.1) then the §7.5 semantic rules.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type EnvSource, joinPointer, processEnv, resolveEnv } from "./env";
import { ConfigError } from "./error";
import { resolveRefs } from "./ref";
import {
  type TeamaiConfig,
  assertChannelSecretsAreEnvRefs,
  inlineUserPasswords,
  validateStructure,
} from "./schema";
import { validateRules } from "./validate";

export interface LoadOptions {
  /** Environment source for `$env` resolution; defaults to the process environment. */
  readonly env?: EnvSource;
  /** Registered adapter types (§8.3); when given, enforces §7.5 "type known". */
  readonly knownAdapterTypes?: Iterable<string>;
  /** Entry file path; relative `$ref`s resolve against its directory (§7.2). */
  readonly baseFile?: string;
  /** Reads a referenced file's text for `$ref` (default fs); injectable for tests. */
  readonly readFile?: (path: string) => string;
}

export interface LoadResult {
  readonly config: TeamaiConfig;
  /** JSON Pointer paths resolved from `$env` (secrets); pass to `redact` for logs. */
  readonly secretPaths: readonly string[];
  /** Non-fatal §7.5 advisories (e.g. an operator with no topology edges). */
  readonly warnings: readonly string[];
}

export function parseConfig(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`config is not valid JSON: ${detail}`);
  }
}

export function loadConfig(text: string, options: LoadOptions = {}): LoadResult {
  const env = options.env ?? processEnv;
  const refOptions: { baseFile?: string; readFile?: (path: string) => string } = {};
  if (options.baseFile !== undefined) refOptions.baseFile = options.baseFile;
  if (options.readFile !== undefined) refOptions.readFile = options.readFile;
  const assembled = resolveRefs(parseConfig(text), refOptions); // §7.2: assemble monolith
  assertChannelSecretsAreEnvRefs(assembled); // §7.3: secrets must be $env (pre-resolution)
  // A literal `users[].auth.password` is legal (§17.2 point relaxation of §10.7,
  // decision §17.10-1) — but it is read PRE-resolution, so the warning can only be
  // collected here, before the reference and the literal become indistinguishable.
  const inlinePasswords = inlineUserPasswords(assembled);
  const { value, secretPaths } = resolveEnv(assembled, env); // §7.3 / §10.7
  const config = validateStructure(value); // base schema (§7.1)
  const context: { knownAdapterTypes?: Iterable<string> } = {};
  if (options.knownAdapterTypes !== undefined)
    context.knownAdapterTypes = options.knownAdapterTypes;
  const warnings = [
    ...inlinePasswords.map(
      (name) =>
        `user "${name}" has an inline auth.password — prefer { "$env": ... } or passwordHash (§17.2)`,
    ),
    ...validateRules(config, context), // §7.5 semantic rules
  ];
  // §7.1 path normalization (T121, FR-82): with a known config location, every
  // agent path leaves the loader ABSOLUTE — a relative cwd otherwise splinters
  // into three readings (server process cwd, the agent's own cwd resolving the
  // injected exchange hint, tmux's `-c`) and the file exchange silently breaks.
  const normalized =
    options.baseFile !== undefined
      ? normalizeConfigPaths(config, dirname(options.baseFile))
      : config;
  return { config: normalized, secretPaths, warnings };
}

/**
 * Resolves the config's relative agent paths against `configDir` (§7.1, FR-82):
 * `agents[].cwd` and `agents[].provision.cwd` — the same base `exchangeDir`
 * already resolves from at wiring. Absolute paths pass through unchanged;
 * loadConfig applies this automatically when the config's location is known.
 */
export function normalizeConfigPaths(config: TeamaiConfig, configDir: string): TeamaiConfig {
  return {
    ...config,
    agents: config.agents.map((agent) => ({
      ...agent,
      ...(agent.cwd !== undefined ? { cwd: resolve(configDir, agent.cwd) } : {}),
      ...(agent.provision?.cwd !== undefined
        ? { provision: { ...agent.provision, cwd: resolve(configDir, agent.provision.cwd) } }
        : {}),
    })),
  };
}

/**
 * Reads `configFile` and loads it, with relative `$ref`s resolved against its
 * directory (§7.2). The composition root pairs this with discoverConfig (§7.4).
 */
export function loadConfigFile(
  configFile: string,
  options: Omit<LoadOptions, "baseFile"> = {},
): LoadResult {
  return loadConfig(readFileSync(configFile, "utf8"), { ...options, baseFile: configFile });
}

const REDACTED = "[redacted]";

/**
 * Returns a deep copy of `value` with every `secretPaths` location replaced by
 * "[redacted]" — for logging/serializing config without leaking resolved secrets
 * (§7.3, §10.7, NFR-6). Paths are the JSON Pointers reported by `resolveEnv`.
 */
export function redact(value: unknown, secretPaths: Iterable<string>): unknown {
  return redactWalk(value, "", new Set(secretPaths));
}

function redactWalk(value: unknown, path: string, secret: ReadonlySet<string>): unknown {
  if (secret.has(path)) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item, i) => redactWalk(item, joinPointer(path, String(i)), secret));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactWalk(child, joinPointer(path, key), secret);
    }
    return out;
  }
  return value;
}
