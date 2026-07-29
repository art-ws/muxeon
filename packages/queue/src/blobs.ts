// Blob store (§5.3) + realpath-containment (§8.7, §10.11). Media/files are not
// inlined in the JSON record; they live as separate files under <root>/blobs/, and
// the payload carries an OPAQUE blob id (never a path). The blob id resolved from a
// payload is UNTRUSTED edge input: before any read (outgoing deliver) or write-back
// (incoming) it is contained under <root>/blobs/ — `..`, separators, absolute paths
// and symlinks are all rejected, so a crafted id cannot read or write outside the
// store.

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export function blobsDir(root: string): string {
  return join(root, "blobs");
}

export async function ensureBlobDirs(root: string): Promise<void> {
  await mkdir(join(blobsDir(root), "tmp"), { recursive: true });
}

/** A single sanitized extension segment — short, alphanumeric, no dots. */
const BLOB_EXT = /^[A-Za-z0-9]{1,8}$/;

/**
 * A safe blob id (T117): the historical extension-less token, optionally
 * followed by ONE sanitized extension. No leading dots (hidden files), no
 * separators, no traversal — checked before any path join.
 */
const SAFE_BLOB_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,8})?$/;
const MAX_BLOB_ID = 120;

/** mime → extension for the common media types (the name's own extension wins). */
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
};

/**
 * Derives the stored-file extension (T117) from what the edge knows: the
 * original filename's own extension wins; otherwise the mime type maps through
 * a small table; anything unknown/unsafe → undefined (an extension-less blob,
 * the historical shape).
 */
export function blobExtension(name?: string, mime?: string): string | undefined {
  if (name !== undefined) {
    const dot = name.lastIndexOf(".");
    if (dot > 0) {
      const ext = name.slice(dot + 1);
      if (BLOB_EXT.test(ext)) return ext.toLowerCase();
    }
  }
  if (mime !== undefined) {
    const essence = mime.split(";")[0]?.trim().toLowerCase() ?? "";
    return MIME_EXT[essence];
  }
  return undefined;
}

/**
 * Writes `bytes` as a new blob (tmp + atomic rename) and returns an OPAQUE id — a
 * random token, never a path (§5.3). The caller stores the id in the message
 * payload; the bytes stay out of the JSON record. With `ext` (T117) the id (and
 * thus the stored file) carries that extension — agents and operators reading
 * the file directly from <root>/blobs/ get its type without copying; consumers
 * still treat the id as opaque.
 */
export async function writeBlob(root: string, bytes: Uint8Array, ext?: string): Promise<string> {
  const dir = realpathSync(blobsDir(root));
  const id =
    ext !== undefined && BLOB_EXT.test(ext) ? `${randomUUID()}.${ext.toLowerCase()}` : randomUUID();
  await writeFile(join(dir, "tmp", id), bytes);
  await rename(join(dir, "tmp", id), join(dir, id)); // atomic move into blobs/
  return id;
}

/**
 * Resolves an untrusted blob `id` to its real path under <root>/blobs/, enforcing
 * containment (§8.7, §10.11): a safe single-segment id, an existing regular file
 * that is NOT a symlink, sitting directly under the real blobs dir. Throws on any
 * traversal/symlink attempt. Use before every read and write-back.
 */
export function resolveBlobPath(root: string, id: string): string {
  // rejects "..", separators, absolute paths, hidden files, bad charset; one
  // optional extension segment is allowed (T117)
  if (id.length > MAX_BLOB_ID || !SAFE_BLOB_ID.test(id)) {
    throw new Error(`unsafe blob id: ${JSON.stringify(id)}`);
  }
  const dir = realpathSync(blobsDir(root)); // resolve the blobs dir (a symlinked dir is fine)
  const candidate = join(dir, id);
  const stat = lstatSync(candidate); // throws if the blob does not exist
  if (stat.isSymbolicLink()) {
    throw new Error(`blob "${id}" is a symlink — rejected (§8.7)`);
  }
  if (!stat.isFile()) {
    throw new Error(`blob "${id}" is not a regular file`);
  }
  if (!isContained(candidate, dir)) {
    throw new Error(`blob "${id}" escapes <root>/blobs/`);
  }
  return candidate;
}

export async function readBlob(root: string, id: string): Promise<Uint8Array> {
  return readFile(resolveBlobPath(root, id));
}

function isContained(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
