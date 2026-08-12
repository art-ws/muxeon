// The importer-side model of remote actors (§18.4, FR-140/FR-149): per import —
// its surface (actor names, types, instance-id paths) and the live status
// projection of each actor. The cache dies with the link (invariant §10.27):
// link down ⇒ every actor of that link is `unknown` with the cause, never the
// last known value as current, and never a guessed `down`.

import {
  type FederatedActorType,
  type ProjectedPresence,
  type ProjectedStatus,
  type StatusProjection,
  type UnknownReason,
  appendServer,
} from "@muxeon/core";
import type { FedActorEntry } from "./protocol";

/** One remote actor as the surfaces see it (FR-140/FR-150). */
export interface RemotePeer {
  /** The local FQN (`dev@b`, `bob@c@b`). */
  readonly name: string;
  readonly type: FederatedActorType;
  /** The import this peer arrived through — the FQN tail, the panel's server group. */
  readonly server: string;
  readonly link: "up" | "down";
  /** agent only (§18.4): the projection, `unknown` when the source is unreachable. */
  readonly status?: ProjectedStatus;
  /** user only (§18.4): FR-133 presence per the owner, `unknown` when unreachable. */
  readonly presence?: ProjectedPresence;
  readonly paused: boolean;
  /** Why `unknown` (§18.4) — a tooltip cause, not a status. */
  readonly reason?: UnknownReason;
  /** Instance-id path — consumed by transit re-export (§18.4 cycle guard). */
  readonly path: readonly string[];
}

interface ActorState {
  readonly type: FederatedActorType;
  readonly path: readonly string[];
  status?: ProjectedStatus;
  presence?: ProjectedPresence;
  paused: boolean;
}

interface LinkState {
  up: boolean;
  statusPublished: boolean;
  readonly actors: Map<string, ActorState>; // keyed by the EXPORTER-relative name
}

/**
 * The registry of everything imported (§18.4). One per server; fed by the link
 * clients, read by every surface (MCP list_peers/get_status, /api/peers, the
 * panel push loop) and by transit re-export (§18.4). `subscribe` is a coarse
 * change signal — readers re-pull, nothing is pushed by value.
 */
export class RemoteRegistry {
  readonly #instanceId: string;
  readonly #links = new Map<string, LinkState>();
  readonly #subscribers = new Set<() => void>();

  constructor(instanceId: string) {
    this.#instanceId = instanceId;
  }

  #notify(): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber();
      } catch {
        // a broken subscriber never breaks the registry
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  #link(name: string): LinkState {
    let state = this.#links.get(name);
    if (state === undefined) {
      state = { up: false, statusPublished: true, actors: new Map() };
      this.#links.set(name, state);
    }
    return state;
  }

  /** The link came up (§18.7): remember whether the exporter publishes statuses. */
  linkUp(link: string, statusPublished: boolean): void {
    const state = this.#link(link);
    state.up = true;
    state.statusPublished = statusPublished;
    this.#notify();
  }

  /**
   * The link went down (§10.27): the status cache dies WITH the link — every
   * actor of it reads `unknown`/link-down until the snapshot after reconnect.
   * The surface itself is kept: the actors are still known to exist.
   */
  linkDown(link: string): void {
    const state = this.#link(link);
    state.up = false;
    for (const actor of state.actors.values()) {
      if (actor.type === "agent") actor.status = "unknown";
      else actor.presence = "unknown";
    }
    this.#notify();
  }

  /**
   * Replace the link's surface (§18.4): sent by the exporter after open and on
   * every change. Entries whose instance-id path contains OUR id are dropped —
   * the cycle guard that keeps a mutual import from looping the namespace.
   */
  surface(link: string, actors: readonly FedActorEntry[]): void {
    const state = this.#link(link);
    state.actors.clear();
    for (const entry of actors) {
      if (entry.path.includes(this.#instanceId)) continue; // §18.4 cycle guard
      const actor: ActorState = {
        type: entry.type,
        path: entry.path,
        paused: entry.status?.paused ?? false,
      };
      if (entry.type === "agent") actor.status = entry.status?.status ?? "unknown";
      else actor.presence = entry.status?.presence ?? "unknown";
      state.actors.set(entry.name, actor);
    }
    this.#notify();
  }

  /** Apply a status snapshot or delta (§18.4): only actors the surface knows. */
  applyStatuses(link: string, statuses: readonly StatusProjection[]): void {
    const state = this.#link(link);
    let changed = false;
    for (const status of statuses) {
      const actor = state.actors.get(status.actor);
      if (actor === undefined) continue; // status without a surface entry — ignore
      if (actor.type === "agent") actor.status = status.status ?? "unknown";
      else actor.presence = status.presence ?? "unknown";
      actor.paused = status.paused;
      changed = true;
    }
    if (changed) this.#notify();
  }

  linkState(link: string): "up" | "down" {
    return this.#links.get(link)?.up === true ? "up" : "down";
  }

  #peerOf(link: string, state: LinkState, name: string, actor: ActorState): RemotePeer {
    // Honesty order (§18.4/§10.27): a dead link beats everything; a neighbour
    // that does not publish beats a value; an upstream hop down arrives as an
    // explicit `unknown` value in the projection itself.
    const linkUp = state.up;
    const published = state.statusPublished;
    const value = actor.type === "agent" ? actor.status : actor.presence;
    let reason: UnknownReason | undefined;
    if (!linkUp) reason = "link-down";
    else if (!published) reason = "not-published";
    else if (value === "unknown") reason = "hop-down";
    const status =
      actor.type === "agent" ? (reason !== undefined ? "unknown" : actor.status) : undefined;
    const presence =
      actor.type === "user" ? (reason !== undefined ? "unknown" : actor.presence) : undefined;
    return {
      name: appendServer(name, link),
      type: actor.type,
      server: link,
      link: linkUp ? "up" : "down",
      ...(status !== undefined ? { status } : {}),
      ...(presence !== undefined ? { presence } : {}),
      paused: actor.paused,
      ...(reason !== undefined ? { reason } : {}),
      path: actor.path,
    };
  }

  /** Every remote actor of one import (§18.4), as the surfaces see them. */
  peersOf(link: string): readonly RemotePeer[] {
    const state = this.#links.get(link);
    if (state === undefined) return [];
    const peers: RemotePeer[] = [];
    for (const [name, actor] of state.actors) {
      peers.push(this.#peerOf(link, state, name, actor));
    }
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every remote actor across all imports. */
  peers(): readonly RemotePeer[] {
    const out: RemotePeer[] = [];
    for (const link of this.#links.keys()) out.push(...this.peersOf(link));
    return out;
  }

  /** One peer by its local FQN, or null. */
  get(fqn: string): RemotePeer | null {
    for (const [link, state] of this.#links) {
      const suffix = `@${link}`;
      if (!fqn.endsWith(suffix)) continue;
      const name = fqn.slice(0, -suffix.length);
      const actor = state.actors.get(name);
      if (actor !== undefined) return this.#peerOf(link, state, name, actor);
    }
    return null;
  }
}
