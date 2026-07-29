// $ref decomposition (§7.2, §10.6, FR-29/FR-30). A config may be split across local
// files; `$ref` points to a local file (relative path) plus an optional JSON Pointer
// fragment (`#/path/to/node`). Remote URLs are unsupported (local-first, OOS-1).
//
// Resolution is a loading detail done BEFORE $env and schema validation: the tree is
// assembled into the equivalent monolith (§10.6). Substitution is STRICT — a `$ref`
// object may have no sibling keys (no merge/overlay, OOS-2). Relative paths resolve
// against the file the `$ref` appears in. A missing/cyclic `$ref` is fatal, naming
// the offending reference.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { joinPointer } from "./env";
import { ConfigError } from "./error";

export interface ResolveRefOptions {
  /** Absolute path of the entry file; relative `$ref`s resolve against its dir. */
  readonly baseFile?: string;
  /** Reads a referenced file's text; defaults to fs. Injectable for tests. */
  readonly readFile?: (path: string) => string;
}

/** Recursively replaces every `$ref` with the referenced value (the monolith, §10.6). */
export function resolveRefs(value: unknown, options: ResolveRefOptions = {}): unknown {
  const readFile = options.readFile ?? defaultReadFile;
  const { baseFile } = options;
  const stack = baseFile !== undefined ? [refKey(baseFile, "")] : [];
  return resolveNode(value, { file: baseFile, readFile, stack, jsonPath: "" });
}

interface Ctx {
  readonly file: string | undefined; // current file (relative-path base)
  readonly readFile: (path: string) => string;
  readonly stack: readonly string[]; // in-progress targets (cycle detection)
  readonly jsonPath: string; // location within the assembled config (for errors)
}

function resolveNode(node: unknown, ctx: Ctx): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      resolveNode(item, { ...ctx, jsonPath: joinPointer(ctx.jsonPath, String(i)) }),
    );
  }
  if (hasRefKey(node)) {
    return resolveRefMarker(node, ctx);
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = resolveNode(child, { ...ctx, jsonPath: joinPointer(ctx.jsonPath, key) });
    }
    return out;
  }
  return node;
}

function resolveRefMarker(node: Record<string, unknown>, ctx: Ctx): unknown {
  const ref = node.$ref;
  if (Object.keys(node).length !== 1) {
    throw new ConfigError("a $ref object must have no sibling keys (§7.2)", { path: ctx.jsonPath });
  }
  if (typeof ref !== "string" || ref.length === 0) {
    throw new ConfigError("$ref must be a non-empty string", { path: ctx.jsonPath });
  }
  if (ctx.file === undefined) {
    throw new ConfigError(`$ref "${ref}" cannot be resolved without a base file path`, {
      path: ctx.jsonPath,
    });
  }
  const { filePart, pointer } = parseRef(ref, ctx);
  const targetFile = resolve(dirname(ctx.file), filePart);
  const key = refKey(targetFile, pointer ?? "");
  if (ctx.stack.includes(key)) {
    throw new ConfigError(`circular $ref detected: ${[...ctx.stack, key].join(" -> ")}`, {
      path: ctx.jsonPath,
    });
  }
  const document = readDocument(targetFile, ref, ctx);
  const selected =
    pointer === undefined ? document : navigatePointer(document, pointer, ref, targetFile, ctx);
  // Recurse into the referenced value, now relative to the referenced file, with the
  // target pushed so a cycle through it is detected.
  return resolveNode(selected, { ...ctx, file: targetFile, stack: [...ctx.stack, key] });
}

function parseRef(ref: string, ctx: Ctx): { filePart: string; pointer: string | undefined } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex < 0) return { filePart: ref, pointer: undefined };
  const filePart = ref.slice(0, hashIndex);
  if (filePart.length === 0) {
    throw new ConfigError(`$ref "${ref}" must reference a local file (§7.2)`, {
      path: ctx.jsonPath,
    });
  }
  return { filePart, pointer: ref.slice(hashIndex + 1) }; // "" (whole doc) or "/path"
}

function readDocument(targetFile: string, ref: string, ctx: Ctx): unknown {
  let text: string;
  try {
    text = ctx.readFile(targetFile);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`cannot read $ref "${ref}" (${targetFile}): ${detail}`, {
      path: ctx.jsonPath,
    });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`$ref "${ref}" (${targetFile}) is not valid JSON: ${detail}`, {
      path: ctx.jsonPath,
    });
  }
}

function navigatePointer(
  document: unknown,
  pointer: string,
  ref: string,
  targetFile: string,
  ctx: Ctx,
): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) {
    throw new ConfigError(`$ref "${ref}" has an invalid JSON Pointer "${pointer}"`, {
      path: ctx.jsonPath,
    });
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw missingNode(ref, pointer, targetFile, ctx);
      }
      current = current[index];
    } else if (isPlainObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw missingNode(ref, pointer, targetFile, ctx);
    }
  }
  return current;
}

function missingNode(ref: string, pointer: string, targetFile: string, ctx: Ctx): ConfigError {
  return new ConfigError(`$ref "${ref}" (${targetFile}) points to a missing node "${pointer}"`, {
    path: ctx.jsonPath,
  });
}

function hasRefKey(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "$ref")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refKey(file: string, pointer: string): string {
  return `${file}#${pointer}`;
}

const defaultReadFile = (path: string): string => readFileSync(path, "utf8");
