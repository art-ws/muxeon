// Federated status projection (§18.4, FR-149) — the ONLY window into a remote
// actor's state (§10.27): derived availability flags published by the OWNER over
// the link. Nothing else crosses the boundary — queues/WIP, console, history,
// transport journal and lastActivity stay home. The stream is ephemeral: a
// snapshot on (re)connect plus coalesced deltas, never queued, never replayed.

import type { AgentStatus } from "./status";

/** An actor kind on the export surface (§18.1): agents and users federate, nothing else. */
export type FederatedActorType = "agent" | "user";

/**
 * A remote agent's projected status (§18.4): the owner's §5.1 value, or
 * `unknown` when the source is unreachable — a hop down the transit chain
 * re-emits `unknown` for the whole branch behind it (honesty over guessing:
 * never `down`, never the last known value as current — §10.27).
 */
export type ProjectedStatus = AgentStatus | "unknown";

/** A remote user's projected presence (§18.4): FR-133 computed by the OWNER's TTL. */
export type ProjectedPresence = "online" | "offline" | "unknown";

/**
 * One actor's availability projection as published over a link (FR-149).
 * `actor` is the export-surface name (alias, possibly already suffixed by
 * transit hops); the importer derives the local FQN by appending its own name
 * for the link. Exactly one of `status`/`presence` is set, by `type`.
 */
export interface StatusProjection {
  readonly actor: string;
  readonly type: FederatedActorType;
  /** agent only: `idle`/`busy`/`down` per the owner, `unknown` past a dead hop. */
  readonly status?: ProjectedStatus;
  /** user only: FR-133 presence per the owner's own `presenceTtl`. */
  readonly presence?: ProjectedPresence;
  /** both kinds: pause §16 / user DND FR-134. */
  readonly paused: boolean;
}

/** Why an importer shows `unknown` (§18.4) — a tooltip cause, not a status. */
export type UnknownReason = "link-down" | "not-published" | "hop-down";
