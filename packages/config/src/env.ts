// $env resolution (§7.3, §10.7). Channel secrets are never inline — the config
// holds an `{ "$env": "VAR" }` reference, resolved here over the assembled tree
// (after $ref, before schema validation — §7.2). A missing variable is a fatal
// start-up error. Resolved locations are reported as `secretPaths` so callers can
// redact them in logs/errors.

import { ConfigError } from "./error";

/** Resolves an environment variable name to its value, or undefined if unset. */
export type EnvSource = (name: string) => string | undefined;

/** Default source: the process environment. */
export const processEnv: EnvSource = (name) => process.env[name];

/** Builds a child JSON Pointer, escaping `~` and `/` per RFC 6901. */
export function joinPointer(base: string, key: string): string {
  return `${base}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** Whether `value` is an object carrying a `$env` key (a resolution candidate). */
export function hasEnvKey(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "$env")
  );
}

export interface EnvResult {
  readonly value: unknown;
  /** JSON Pointer paths whose values were resolved from `$env` (treat as secret). */
  readonly secretPaths: readonly string[];
}

export function resolveEnv(value: unknown, env: EnvSource): EnvResult {
  const secretPaths: string[] = [];
  const resolved = walk(value, "", env, secretPaths);
  return { value: resolved, secretPaths };
}

function walk(value: unknown, path: string, env: EnvSource, secretPaths: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => walk(item, joinPointer(path, String(i)), env, secretPaths));
  }
  if (hasEnvKey(value)) {
    const name = readEnvName(value, path);
    const resolved = env(name);
    if (resolved === undefined) {
      throw new ConfigError(`environment variable "${name}" is not set`, { path });
    }
    secretPaths.push(path);
    return resolved;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = walk(child, joinPointer(path, key), env, secretPaths);
    }
    return out;
  }
  return value;
}

/**
 * The resolved string values at `secretPaths` (the pointers reported by
 * resolveEnv) — the input for boundary TEXT redaction (§8.7, NFR-6): any log or
 * operator-facing error is scrubbed of these exact values before it leaves.
 */
export function secretValues(value: unknown, secretPaths: Iterable<string>): string[] {
  const values: string[] = [];
  for (const pointer of secretPaths) {
    const found = atPointer(value, pointer);
    if (typeof found === "string" && found.length > 0) values.push(found);
  }
  return values;
}

function atPointer(value: unknown, pointer: string): unknown {
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      current = current[Number(key)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

// Strict marker shape: exactly `{ "$env": "<non-empty NAME>" }`. Sibling keys or a
// non-string name are fatal (mirrors $ref strictness, §7.2).
function readEnvName(marker: Record<string, unknown>, path: string): string {
  const name = marker.$env;
  if (Object.keys(marker).length !== 1 || typeof name !== "string" || name.length === 0) {
    throw new ConfigError('malformed $env reference (expected { "$env": "<NAME>" })', { path });
  }
  return name;
}
