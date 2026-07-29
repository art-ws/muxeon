// Signal envelope construction (§5.3, FR-18). A Signal is the generic event/prompt
// directed at a participant; a Message (kind "message") is the baseline special case.
// `signals` owns kind: baseline produces messages, and the envelope is the seam where
// forward-compatible kinds (reactions etc., T38/S) plug in without touching the core.

import { randomUUID } from "node:crypto";
import type { Signal, SignalKind } from "@teamai/core";

export interface SignalInput {
  readonly from: string;
  readonly to: string;
  readonly payload: unknown;
  /** Signal kind; baseline is "message" (the only SignalKind today), §5.3. */
  readonly kind?: SignalKind;
  readonly replyTo?: string;
  /** Producing channel or routine (§5.3). */
  readonly origin?: string;
  /** Idempotency key (§10.9); generated when absent. */
  readonly id?: string;
  readonly ts?: number;
}

export interface BuildOptions {
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** Build a signal envelope, filling id (random), ts (now) and kind ("message") defaults. */
export function buildSignal(input: SignalInput, options: BuildOptions = {}): Signal {
  return {
    id: input.id ?? (options.newId ?? randomUUID)(),
    from: input.from,
    to: input.to,
    kind: input.kind ?? "message",
    ts: input.ts ?? (options.now ?? Date.now)(),
    payload: input.payload,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
  };
}
