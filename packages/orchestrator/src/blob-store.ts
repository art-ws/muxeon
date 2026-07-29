// Blob access for the edges (§5.3, §8.7) — exposed THROUGH orchestrator so
// @teamai/queue stays orchestrator-only (§8), like session.ts. Channel connectors
// (§8.4) write inbound media as blobs and resolve outbound payload blob refs to
// bytes ONLY under <root>/blobs/ — containment lives in the queue layer (§10.11).

import { blobExtension, ensureBlobDirs, readBlob, writeBlob } from "@teamai/queue";

/** What the writing edge knows about the bytes (T117) — both optional. */
export interface BlobHint {
  readonly name?: string | undefined;
  readonly mime?: string | undefined;
}

export interface BlobStore {
  /**
   * Write bytes as a new blob (tmp+rename); returns the OPAQUE blob id (§5.3).
   * The optional hint (T117) lets the store suffix the id — and thus the file
   * on disk — with the type's extension (from the name, else the mime).
   */
  write(bytes: Uint8Array, hint?: BlobHint): Promise<string>;
  /**
   * Read a blob by an UNTRUSTED id with realpath-containment under <root>/blobs/
   * (§8.7, §10.11); throws on any traversal/symlink attempt.
   */
  read(id: string): Promise<Uint8Array>;
}

/** Blob store rooted at the queue root <root> (§5.3); creates blobs/ dirs. */
export async function createBlobStore(root: string): Promise<BlobStore> {
  await ensureBlobDirs(root);
  return {
    write: (bytes, hint) => writeBlob(root, bytes, blobExtension(hint?.name, hint?.mime)),
    read: (id) => readBlob(root, id),
  };
}
