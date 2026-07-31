// The link wire protocol (§18.7, FR-138) — a sketch made concrete. Three HTTP
// surfaces on the SEPARATE federation listener: POST /fed/handshake (bearer →
// instance-id + version + statusPublished), GET /fed/actors (export surface +
// status snapshot), WS /fed/link (bidirectional frames). Frames split into the
// persistent family (envelope/receipt — link-queue records, acked per transfer)
// and the ephemeral family (surface/status-snapshot/status — never queued,
// truth restored by the snapshot on reconnect). That split IS invariant §10.27,
// not a protocol detail: message delivery survives a dead link, status
// knowledge does not.

import type { FederatedActorType, SignalKind, StatusProjection } from "@teamai/core";
import type { FederationReceiptCode, LinkRecord } from "@teamai/orchestrator";

/** Protocol version (§18.7): a mismatch is link-down with a clear log, not a guess. */
export const FED_PROTOCOL_VERSION = 1;

export const FED_HANDSHAKE_PATH = "/fed/handshake";
export const FED_ACTORS_PATH = "/fed/actors";
export const FED_LINK_PATH = "/fed/link";

/** How long a persistent frame waits for its transfer ack before the record re-sends. */
export const FED_ACK_TIMEOUT_MS = 10_000;

export interface HandshakeRequest {
  readonly version: number;
}

export interface HandshakeResponse {
  readonly instanceId: string;
  readonly version: number;
  /** §18.4/FR-149: whether this exporter publishes status projections at all. */
  readonly statusPublished: boolean;
}

/**
 * One actor on an export surface (§18.4): `name` is relative to the exporter
 * (own alias, or an already-suffixed transit FQN); `path` is the instance-id
 * chain the entry travelled — an importer seeing its OWN id in the path drops
 * the branch (the §18.4 cycle guard); `status` is the current projection.
 */
export interface FedActorEntry {
  readonly name: string;
  readonly type: FederatedActorType;
  readonly path: readonly string[];
  readonly status?: StatusProjection;
}

export interface ActorsResponse {
  readonly actors: readonly FedActorEntry[];
}

/** The persistent envelope on the wire (§18.5): `to` is the head THIS receiver resolves. */
export interface WireEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: SignalKind;
  readonly ts: number;
  readonly payload: unknown;
  readonly replyTo?: string;
  readonly hops: number;
}

/** The persistent receipt on the wire (§18.5, FR-143): `id` is its queue-record id. */
export interface WireReceipt {
  readonly id: string;
  readonly ref: string;
  readonly code: FederationReceiptCode;
  readonly detail?: string;
  readonly from: string;
  readonly to: string;
  readonly hops: number;
}

export type LinkFrame =
  | { readonly type: "envelope"; readonly envelope: WireEnvelope }
  | { readonly type: "receipt"; readonly receipt: WireReceipt }
  /** Transfer ack (§10.25): the peer durably processed the record named by `ref`. */
  | { readonly type: "ack"; readonly ref: string }
  /** Ephemeral (§10.27): the full export surface — sent after open and on change. */
  | { readonly type: "surface"; readonly actors: readonly FedActorEntry[] }
  /** Ephemeral (§10.27): every actor's current projection — truth after (re)connect. */
  | { readonly type: "status-snapshot"; readonly statuses: readonly StatusProjection[] }
  /** Ephemeral (§10.27): coalesced deltas (`federation.statusDebounceMs`). */
  | { readonly type: "status"; readonly statuses: readonly StatusProjection[] };

/** Parse one wire message; null for anything malformed (a bad peer, not a crash). */
export function parseFrame(raw: unknown): LinkFrame | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "envelope":
      return typeof frame.envelope === "object" && frame.envelope !== null
        ? ({ type: "envelope", envelope: frame.envelope as WireEnvelope } as LinkFrame)
        : null;
    case "receipt":
      return typeof frame.receipt === "object" && frame.receipt !== null
        ? ({ type: "receipt", receipt: frame.receipt as WireReceipt } as LinkFrame)
        : null;
    case "ack":
      return typeof frame.ref === "string" ? { type: "ack", ref: frame.ref } : null;
    case "surface":
      return Array.isArray(frame.actors)
        ? ({ type: "surface", actors: frame.actors as FedActorEntry[] } as LinkFrame)
        : null;
    case "status-snapshot":
      return Array.isArray(frame.statuses)
        ? ({ type: "status-snapshot", statuses: frame.statuses as StatusProjection[] } as LinkFrame)
        : null;
    case "status":
      return Array.isArray(frame.statuses)
        ? ({ type: "status", statuses: frame.statuses as StatusProjection[] } as LinkFrame)
        : null;
    default:
      return null;
  }
}

/**
 * A link-queue record → its wire frame (§18.5). `wireName` maps a LOCAL sender
 * name to its export alias (an already-suffixed FQN passes through) so the
 * remote side sees the same name the export surface shows.
 */
export function toWireFrame(record: LinkRecord, wireName: (name: string) => string): LinkFrame {
  const receipt = record.fed.receipt;
  if (receipt !== undefined) {
    return {
      type: "receipt",
      receipt: {
        id: record.id,
        ref: receipt.ref,
        code: receipt.code,
        ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
        from: wireName(record.from),
        to: record.fed.to,
        hops: record.fed.hops,
      },
    };
  }
  return {
    type: "envelope",
    envelope: {
      id: record.id,
      from: wireName(record.from),
      to: record.fed.to,
      kind: record.kind,
      ts: record.ts,
      payload: record.payload,
      ...(record.replyTo !== undefined ? { replyTo: record.replyTo } : {}),
      hops: record.fed.hops,
    },
  };
}

/** A received persistent frame → the LinkRecord handed to the router's ingress. */
export function toLinkRecord(frame: LinkFrame): { record: LinkRecord; ackRef: string } | null {
  if (frame.type === "envelope") {
    const e = frame.envelope;
    return {
      ackRef: e.id,
      record: {
        id: e.id,
        from: e.from,
        to: e.to,
        kind: e.kind,
        ts: e.ts,
        payload: e.payload,
        ...(e.replyTo !== undefined ? { replyTo: e.replyTo } : {}),
        fed: { to: e.to, hops: e.hops },
      },
    };
  }
  if (frame.type === "receipt") {
    const r = frame.receipt;
    return {
      ackRef: r.id,
      record: {
        id: r.id,
        from: r.from,
        to: r.to,
        kind: "message",
        ts: 0,
        payload: null,
        fed: {
          to: r.to,
          hops: r.hops,
          receipt: {
            ref: r.ref,
            code: r.code,
            ...(r.detail !== undefined ? { detail: r.detail } : {}),
          },
        },
      },
    };
  }
  return null;
}
