// File-borne reply delivery (FR-54, §13.3): at turn end the agent's exchange dir
// is collected — reply.md becomes the answer payload, artifact files become blob
// attachments (§12.5) — and routed BACK to the original sender through the router
// (the reply edge is legal, §10.2; the routed send closes the reply-nudge window,
// FR-45, so the scrape/nudge chain stays silent). Best-effort by design: it runs
// after complete() — a crash here loses at most the reply, never the turn.

import { readFile } from "node:fs/promises";
import type { Signal } from "@muxeon/core";
import type { BlobStore, Exchange } from "@muxeon/orchestrator";

/** Extension → mime for §12.5 refs; unknown → octet-stream (FR-46). */
export const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  webm: "video/webm",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

export function mimeByName(name: string): string {
  const ext = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// FR-46 default cap — an artifact above it is skipped with a warning, the rest
// of the reply still goes out.
const ARTIFACT_CAP_BYTES = 25 * 1024 * 1024;

export interface ExchangeReplyDeps {
  /** The agent's topology name — the reply's `from` (§10.2). */
  readonly agent: string;
  readonly exchange: Pick<Exchange, "collect">;
  readonly blobs: BlobStore;
  readonly route: (
    message: Signal,
  ) => Promise<{ ok: boolean; code?: string; limit?: number; depth?: number }>;
  readonly now?: () => number;
  readonly warn?: (text: string) => void;
}

/**
 * Collect and route the file-borne reply for one finished turn (FR-54). The id is
 * deterministic (`<id>:reply`) so a redelivered turn's duplicate collapses in the
 * dedup window (§10.9). Returns true when a reply was DELIVERED — the caller uses
 * that to decide whether the turn dir may go (§13.3): a refused reply keeps it.
 */
export async function routeExchangeReply(
  message: Signal,
  deps: ExchangeReplyDeps,
): Promise<boolean> {
  const collected = await deps.exchange.collect(message);
  if (collected === null) return false;
  const warn = deps.warn ?? ((text) => process.stderr.write(`${text}\n`));

  const refs: { blob: string; name: string; mime: string; size: number }[] = [];
  for (const file of collected.files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file.path));
    } catch {
      continue; // vanished between collect and read — the agent's own cleanup
    }
    if (bytes.length > ARTIFACT_CAP_BYTES) {
      warn(
        `muxeon: warning: exchange artifact "${file.name}" of ${deps.agent} exceeds ${ARTIFACT_CAP_BYTES} bytes — skipped (FR-46)`,
      );
      continue;
    }
    refs.push({
      blob: await deps.blobs.write(bytes, { name: file.name }),
      name: file.name,
      mime: mimeByName(file.name),
      size: bytes.length,
    });
  }
  if (collected.text === undefined && refs.length === 0) return false;

  const payload =
    refs.length === 0
      ? collected.text
      : { ...(collected.text !== undefined ? { text: collected.text } : {}), blobs: refs };
  const result = await deps.route({
    id: `${message.id}:reply`,
    from: deps.agent,
    to: message.from,
    kind: "message",
    ts: (deps.now ?? Date.now)(),
    replyTo: message.id,
    payload,
    origin: "exchange",
  });
  if (!result.ok) {
    // A reply is gated like any send — under the WIP cap (FR-104, operator's choice)
    // and under the recipient's pause (§16.2, FR-117). It was produced but not
    // delivered — never drop it silently; warn so the refusal is visible.
    warn(
      `muxeon: warning: reply from ${deps.agent} to "${message.from}" refused (${result.code}${
        result.code === "WIP_LIMIT" ? `, limit ${result.limit}, ${result.depth} in flight` : ""
      }) — not delivered (${result.code === "AGENT_PAUSED" ? "§16.2" : "FR-104"})`,
    );
    // NOT delivered ⇒ not collected as far as cleanup is concerned (T239): the
    // turn dir survives, so the late-reply harvest (FR-74) re-offers the very
    // same answer on the next sweep, until the recipient drains or the orphan
    // window closes (which warns — §13.3). A refusal happens BEFORE enqueue and
    // never reaches done/ (§10.19), so the retry cannot deliver a duplicate.
    return false;
  }
  return true;
}
