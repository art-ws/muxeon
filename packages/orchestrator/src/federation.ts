// Federation transit types (§18.5, FR-141/FR-142/FR-143) — the shapes the router
// writes into link queues and receives back from links. The router is the single
// point on BOTH sides of a link (§10.26): outgoing FQN routes are authorized here,
// inbound envelopes pass the owner's gates here; a link may never enqueue past it.

import { join } from "node:path";
import type { Signal } from "@muxeon/core";

/** Receipt codes travelling back over a link (§18.5, FR-143). */
export type FederationReceiptCode =
  | "ok"
  | "WIP_LIMIT"
  | "AGENT_PAUSED"
  | "UNKNOWN_ACTOR"
  | "HOP_CAP";

/** The receipt payload riding a link record (§18.5): answers envelope `ref`. */
export interface FederationReceiptPayload {
  readonly ref: string;
  readonly code: FederationReceiptCode;
  readonly detail?: string;
}

/**
 * The federation transit envelope of a link-queue record (§18.5): `to` is the
 * FQN head the REMOTE side resolves (this server's link tail already stripped);
 * `hops` counts transits (0 at origin, +1 per hop, cap {@link DEFAULT_HOP_CAP});
 * `receipt` marks the record as a receipt travelling back (FR-143).
 */
export interface FedTransit {
  readonly to: string;
  readonly hops: number;
  readonly receipt?: FederationReceiptPayload;
}

/**
 * A link-queue record: an ordinary Signal plus the transit envelope. The Signal
 * half keeps the LOCAL view (`to` = full FQN as this server names it) so the
 * transport journal and queue inspection read naturally; the wire frame is
 * derived from `fed` at the deliver port.
 */
export type LinkRecord = Signal & { readonly fed: FedTransit };

/** Type guard: does a queue record carry the federation transit envelope? */
export function isLinkRecord(signal: Signal): signal is LinkRecord {
  const fed = (signal as LinkRecord).fed;
  return (
    typeof fed === "object" &&
    fed !== null &&
    typeof fed.to === "string" &&
    typeof fed.hops === "number"
  );
}

/** Per-message hop cap (§18.5, FR-141): exceeding it yields a receipt, never a loop. */
export const DEFAULT_HOP_CAP = 8;

/** The reserved queue-root segment link queues live under (§18.5): `<root>/fed/<link>/`. */
export const FED_QUEUE_DIR = "fed";

/** The root all link queues live under (§18.5). */
export function fedQueueRoot(root: string): string {
  return join(root, FED_QUEUE_DIR);
}

/** Which side of a link a tail name resolves to (§18.4): my import or my accept. */
export type LinkKind = "import" | "accept";

/** The result of a federated ingress (§18.5): ok, or the receipt code sent back. */
export interface FederationIngressResult {
  readonly ok: boolean;
  readonly code?: FederationReceiptCode;
}

/** Federation ports injected into the router (§10.26) — config/link knowledge stays outside. */
export interface RouterFederation {
  /** Kind of a link tail, or null when the name is not a configured link (§18.4). */
  readonly linkKind: (name: string) => LinkKind | null;
  /** May an inbound envelope be forwarded through this IMPORT (§18.2 `transit`)? */
  readonly transitAllowed: (importName: string) => boolean;
  /** Export surface (§18.4): export name → LOCAL participant name, or null. */
  readonly exportedToLocal: (exportName: string) => string | null;
  /**
   * Reply-correlation (§18.10-3): has `local` a journaled exchange with `remoteFqn`
   * under id `replyTo`? Grants ingress to a non-exported actor and egress toward an
   * accept link — the two halves of "answers flow back, initiative needs an import".
   */
  readonly hasCorrelation: (
    local: string,
    remoteFqn: string,
    replyTo: string | undefined,
  ) => Promise<boolean>;
  /** Hop cap override (§18.5); default {@link DEFAULT_HOP_CAP}. */
  readonly hopCap?: number;
}
