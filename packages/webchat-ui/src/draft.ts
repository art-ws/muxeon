// Draft/attachment logic (T50, §12.5) — DOM-free helpers behind the composer:
// attachment list ops, capture file naming, MediaRecorder mime negotiation.
// Components stay thin; this module is bun-tested.

import type { BlobMeta } from "./types";

export interface Attachment extends BlobMeta {
  /** Local chip label; falls back to the stored name. */
  readonly label: string;
}

export const toAttachment = (meta: BlobMeta): Attachment => ({ ...meta, label: meta.name });

export const addAttachment = (
  list: readonly Attachment[],
  meta: BlobMeta,
): readonly Attachment[] =>
  list.some((existing) => existing.id === meta.id) ? list : [...list, toAttachment(meta)];

export const removeAttachment = (list: readonly Attachment[], id: string): readonly Attachment[] =>
  list.filter((attachment) => attachment.id !== id);

/** Capture artifacts get readable, sortable names (voice-…, photo-…, clip-…). */
export function captureName(kind: "voice" | "photo" | "clip", ts: number, mime: string): string {
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${kind}-${stamp}.${extensionOf(mime)}`;
}

function extensionOf(mime: string): string {
  const subtype = mime.split(";")[0]?.split("/")[1] ?? "bin";
  return subtype === "jpeg" ? "jpg" : subtype;
}

/**
 * First recorder mime the browser supports (§12.5: audio/webm·opus preferred,
 * video/webm for clips); undefined lets MediaRecorder pick its own default.
 */
export function pickRecorderMime(
  candidates: readonly string[],
  isSupported: (mime: string) => boolean,
): string | undefined {
  return candidates.find((candidate) => isSupported(candidate));
}

export const VOICE_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
export const CLIP_MIME_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];
