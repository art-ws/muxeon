// ChannelConnector — the unified channel interface (§8.4, §3.2; FR-24a/FR-26).
// Inbound goes through the router (§8.2) via the injected onInbound handler;
// outbound is pushed by the operator pseudo-session's egress dispatcher calling
// deliver() as the egress sink (§5.3). The connector NEVER touches the queue
// (§8, §10.8) — completion is the dispatcher's job.

import type { Message, Signal } from "@teamai/core";
import type { RouteCode } from "@teamai/orchestrator";

/**
 * Bridge to the router (§8.2), injected by the server wiring (T30). Rejects by
 * throwing RouteRefusedError so the connector can report a clear error back to
 * the operator in the same channel (§3.2).
 */
export type InboundHandler = (message: Message) => Promise<void>;

export interface ChannelConnector {
  readonly type: string;
  /** The operator node this channel binds (§7.1); one channel per operator (§7.5). */
  readonly bindOperator: string;
  /** Fallback target when the text has no @agent token (§3.2/§7.5). */
  readonly defaultTarget?: string;

  /** Subscribe to external events; each inbound becomes a Message + onInbound. */
  start(onInbound: InboundHandler): Promise<void>;

  /**
   * Push one message to the operator — the egress sink. Called by the pseudo-
   * session dispatcher (orchestrator §8.2), which completes to done/ itself; a
   * throw leaves the record in cur/ for re-send (at-least-once, §10.9). Payload
   * blob refs are resolved to bytes only under <root>/blobs/ (§8.7).
   */
  deliver(signal: Signal): Promise<void>;

  stop(): Promise<void>;
}

/**
 * The router refused an inbound message (no edge / unknown peer, §10.2). The
 * message is operator-facing (§3.2) and carries no internal paths (§8.7).
 */
export class RouteRefusedError extends Error {
  readonly code: RouteCode;
  readonly to: string;

  constructor(code: RouteCode, to: string) {
    super(RouteRefusedError.#reason(code, to));
    this.name = "RouteRefusedError";
    this.code = code;
    this.to = to;
  }

  static #reason(code: RouteCode, to: string): string {
    switch (code) {
      case "TOPOLOGY_DENIED":
        return `cannot deliver to "${to}": no topology edge allows it`;
      case "WIP_LIMIT":
        // Backpressure (FR-104): a mechanical, temporary refusal — retry later.
        return `"${to}" is busy (WIP limit reached) — try again once it catches up`;
      case "AGENT_PAUSED":
        // Pause (§16.2, FR-117): an operator-declared refusal, and the message was
        // dropped — the sender must resend after the resume, nothing is queued.
        return `"${to}" is paused — the message was discarded, try again once it resumes`;
      default:
        return `unknown peer "${to}"`;
    }
  }
}

/** Operator-facing error text (§3.2): clear for route refusals, generic otherwise (§8.7). */
export function operatorErrorText(error: unknown): string {
  if (error instanceof RouteRefusedError) return `teamai: ${error.message}`;
  return "teamai: delivery failed";
}

/** Short text for a reaction signal (FR-25b): the payload as plain text. */
export function reactionText(signal: Signal): string {
  return typeof signal.payload === "string" ? signal.payload : JSON.stringify(signal.payload);
}

// --- payload convention (§5.3) ----------------------------------------------
// Media/files are never inlined: the payload is either a plain text string or
// { text?, blobs?: [{ blob: <opaque id>, name? }] }. Anything else is rendered
// as JSON text so the operator still sees the message.

export interface BlobRef {
  /** Opaque blob id (§5.3) — resolved only under <root>/blobs/ (§8.7). */
  readonly blob: string;
  readonly name?: string;
  /** Upload-time media type (§12.5) — render/serve hints; never re-trusted per request. */
  readonly mime?: string;
  readonly size?: number;
}

export interface NormalizedPayload {
  readonly text?: string;
  readonly blobs: readonly BlobRef[];
}

export function normalizePayload(payload: unknown): NormalizedPayload {
  if (typeof payload === "string") return { text: payload, blobs: [] };
  if (isPlainObject(payload)) {
    const text = typeof payload.text === "string" ? payload.text : undefined;
    const blobs = Array.isArray(payload.blobs) ? payload.blobs.flatMap(decodeBlobRef) : [];
    if (text !== undefined || blobs.length > 0) {
      return { ...(text !== undefined ? { text } : {}), blobs };
    }
  }
  return { text: JSON.stringify(payload), blobs: [] };
}

// A malformed ref is untrusted edge input (§8.7) — dropped, not delivered; a
// well-formed ref still passes realpath-containment at read time (§10.11).
function decodeBlobRef(value: unknown): BlobRef[] {
  if (typeof value === "string") return [{ blob: value }];
  if (isPlainObject(value) && typeof value.blob === "string") {
    const name = typeof value.name === "string" ? value.name : undefined;
    const mime = typeof value.mime === "string" ? value.mime : undefined;
    const size = typeof value.size === "number" ? value.size : undefined;
    return [
      {
        blob: value.blob,
        ...(name !== undefined ? { name } : {}),
        ...(mime !== undefined ? { mime } : {}),
        ...(size !== undefined ? { size } : {}),
      },
    ];
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
