// Operator-plane: blobs.upload (§8.5, FR-46, T59). Accepts raw bytes into the
// shared blob store (<root>/blobs/, tmp+rename, store-issued opaque id — §5.3) so
// signals.send can carry attachments by the §12.5 {text?, blobs:[ref]} convention.
// The CLI mirror is `signals send --blob <path>`. Same default size cap as the
// webchat upload (§12.5).

import type { BlobStore } from "@muxeon/orchestrator";
import { AdminError } from "./error";

export const DEFAULT_BLOB_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB, mirrors §12.5

export interface BlobsAdmin {
  /** The optional mime (T117, from the request content-type) names the stored file's extension. */
  upload(bytes: Uint8Array, mime?: string): Promise<{ id: string; size: number }>;
}

export interface BlobsAdminDeps {
  readonly blobs: BlobStore;
  /** Size cap (§12.5 spirit); default 25 MiB. */
  readonly maxBytes?: number;
}

export function createBlobsAdmin(deps: BlobsAdminDeps): BlobsAdmin {
  const maxBytes = deps.maxBytes ?? DEFAULT_BLOB_MAX_BYTES;
  return {
    upload: async (bytes, mime) => {
      if (bytes.length === 0) throw new AdminError(400, "empty blob body", "BAD_REQUEST");
      if (bytes.length > maxBytes) {
        throw new AdminError(413, `blob exceeds the ${maxBytes}-byte cap`, "TOO_LARGE");
      }
      const id = await deps.blobs.write(bytes, { mime });
      return { id, size: bytes.length };
    },
  };
}
