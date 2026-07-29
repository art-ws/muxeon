// Agent pause — the do-not-disturb registry (§16, FR-116). An operator-declared
// flag per AGENT: while it is set, the transport delivers nothing to that agent —
// the router refuses every kind before enqueue (§16.2, FR-117) and the agent's
// dispatcher holds its drain (§16.3, FR-118).
//
// The flag is ORTHOGONAL to the session status (§5.1): an agent can be paused while
// idle, busy or down, and pause never raises or retires a session. It is runtime
// state, not configuration — mirrored to <stateDir>/paused.json (pause-state.ts) so
// an operator's declared refusal is not silently undone by a deploy.
//
// This module is PURE (no fs, no timers): the registry plus the seed/validation
// helper. The composition root wires the persistence and the ports.

/** Serialisable snapshot — exactly what `state/paused.json` holds (§16.4). */
export interface PauseFile {
  readonly version: 1;
  /** The paused agent names, sorted (a stable file across writes). */
  readonly paused: readonly string[];
}

/**
 * The set of paused agents (§16.1). Mutation is idempotent and takes the DESIRED
 * state (`set(name, true|false)`), never a toggle: two operator surfaces must not
 * invert each other (§16.4).
 */
export class PauseRegistry {
  readonly #paused = new Set<string>();

  constructor(seed?: Iterable<string>) {
    for (const name of seed ?? []) this.#paused.add(name);
  }

  /** Is this agent paused? — the router/dispatcher gate (§16.2/§16.3). */
  has(name: string): boolean {
    return this.#paused.has(name);
  }

  /** The paused agents, sorted — the admin/panel view and the snapshot. */
  list(): readonly string[] {
    return [...this.#paused].sort();
  }

  /**
   * Applies the desired state; returns whether it CHANGED anything (the caller
   * persists only on a change — a repeated pause is a cheap no-op).
   */
  set(name: string, paused: boolean): boolean {
    if (paused) {
      if (this.#paused.has(name)) return false;
      this.#paused.add(name);
      return true;
    }
    return this.#paused.delete(name);
  }

  snapshot(): PauseFile {
    return { version: 1, paused: this.list() };
  }
}

/**
 * Rehydrate from a persisted snapshot (§16.4). A name that is no longer a
 * configured agent (renamed/removed) is DROPPED and reported, never silently
 * carried: the caller warns. A missing/corrupt file (null) starts empty — nothing
 * paused, which is the safe direction (messages flow; the operator sees it).
 */
export function seedPauseRegistry(
  file: PauseFile | null,
  isKnownAgent: (name: string) => boolean,
): { readonly registry: PauseRegistry; readonly dropped: readonly string[] } {
  const names = Array.isArray(file?.paused) ? file.paused : [];
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue; // junk in the file
    (isKnownAgent(name) ? kept : dropped).push(name);
  }
  return { registry: new PauseRegistry(kept), dropped };
}
