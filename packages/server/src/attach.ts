// Attachment ingest (§12.5, §8.7) — turning an agent-supplied PATH into a blob
// ref. Shared by the two paths an agent can attach files through: the outbox
// (FR-55, §13.4) and the MCP `send` tool (FR-159, §13.6).
//
// It lives in its own module because it is a SECURITY surface, not a
// convenience: an agent names a path and the server reads it, so realpath
// containment is what stands between "attach my report" and "attach
// /etc/passwd". Two callers duplicating that check is how the two copies
// eventually disagree — there is exactly one implementation and both use it.

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { BlobStore } from "@muxeon/orchestrator";
import { mimeByName } from "./exchange-reply";

/** Per-file size cap (FR-46) — the same ceiling the exchange reply collection uses. */
export const ATTACH_CAP_BYTES = 25 * 1024 * 1024;

export interface AttachContext {
  /**
   * realpath-containment roots (§8.7): the agent's exchange dir and its cwd. A
   * file resolving outside EVERY root is refused — symlinks included, which is
   * why the comparison is on realpath and not on the written path.
   */
  readonly containRoots: readonly string[];
  /** Base for RELATIVE paths — the agent's cwd when it has one, else its exchange. */
  readonly filesBase: string;
  readonly blobs: BlobStore;
}

/** A §12.5 blob ref — what a delivered payload carries in place of the bytes. */
export interface AttachedRef {
  readonly blob: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * Ingest ONE path into the blob store. Returns the ref, or a human-readable
 * REASON string on refusal — the caller decides what a refusal means for it
 * (the outbox rejects the whole file, `send` fails the call), but the wording
 * an agent sees is the same either way.
 */
export async function ingestAttachment(
  file: string,
  ctx: AttachContext,
): Promise<AttachedRef | string> {
  const candidate = isAbsolute(file) ? file : resolve(ctx.filesBase, file);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return `references a missing file: ${file}`;
  }
  const roots = await Promise.all(ctx.containRoots.map((root) => realpath(root).catch(() => null)));
  const contained = roots.some(
    (root) => root !== null && (real === root || real.startsWith(root + sep)),
  );
  if (!contained) {
    return `references a file outside the exchange/cwd containment (§8.7): ${file}`;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(real));
  } catch {
    return `references an unreadable file: ${file}`;
  }
  if (bytes.length > ATTACH_CAP_BYTES) {
    return `references a file over the ${ATTACH_CAP_BYTES}-byte cap (FR-46): ${file}`;
  }
  const base = real.split(sep).pop() ?? "file";
  return {
    blob: await ctx.blobs.write(bytes, { name: base }),
    name: base,
    mime: mimeByName(base),
    size: bytes.length,
  };
}

/**
 * Ingest a whole list, ALL-OR-NOTHING: the first refusal aborts and is returned
 * as the reason. Partial success would deliver a message whose attachments
 * silently disagree with what the agent asked for — worse than a refusal it can
 * see and retry.
 */
export async function ingestAttachments(
  files: readonly string[],
  ctx: AttachContext,
): Promise<readonly AttachedRef[] | string> {
  const refs: AttachedRef[] = [];
  for (const file of files) {
    const ingested = await ingestAttachment(file, ctx);
    if (typeof ingested === "string") return ingested;
    refs.push(ingested);
  }
  return refs;
}
