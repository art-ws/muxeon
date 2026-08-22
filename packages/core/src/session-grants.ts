// SessionGrants — the DIRECTED access-control map for agent→agent session
// lifecycle control (§7.1, §8.6, FR-96/FR-97). The exact parallel of CommandGrants
// (slash commands): "<from> may run <action> on <to>'s session". Unlike Topology
// (undirected messaging), controlling a peer's session is a privilege with a
// direction. A grant authorizes an action ONLY together with a topology edge
// (§10.2) and the recipient's applicable action catalog (a started session needs a
// provision command, FR-7) — this map narrows WITHIN neighbors, it never widens the
// graph. The "*" wildcard matches any sender key, any recipient key, and (as an
// action-list element) every action the recipient actually supports. `core`
// performs no I/O.

/**
 * The closed set of lifecycle actions an agent may invoke on a peer's session
 * (§8.6): the hard operator verbs (`start`=provision, `stop`=kill,
 * `restart`=kill+provision) and the graceful twins (`shutdown`, `reload`). The
 * agent-plane `control_session` tool and §7.5 validation key off this set; it grows
 * only by requirement (R3).
 */
export const SESSION_ACTIONS = ["start", "stop", "shutdown", "restart", "reload"] as const;

export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** Whether `value` is one of the closed lifecycle actions (used by §7.5 validation). */
export function isSessionAction(value: string): value is SessionAction {
  return (SESSION_ACTIONS as readonly string[]).includes(value);
}

export type SessionGrantsMap = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/** The wildcard token: any sender, any recipient, or every action (§7.1). */
export const SESSION_WILDCARD = "*";

export class SessionGrants {
  readonly #map: SessionGrantsMap;

  constructor(map: SessionGrantsMap = {}) {
    this.#map = map;
  }

  /**
   * The actions `from` may run on `to`, resolving "*" wildcards across the four
   * matching cells (from→to, from→*, *→to, *→*). Returns "all" when any matching
   * grant lists "*" — every action the recipient actually supports, the applicable
   * catalog still bounds it at execution (FR-96). Otherwise the explicit union of
   * action names; an empty set means nothing is granted.
   */
  allowedFor(from: string, to: string): "all" | ReadonlySet<string> {
    const cells = [
      this.#map[from]?.[to],
      this.#map[from]?.[SESSION_WILDCARD],
      this.#map[SESSION_WILDCARD]?.[to],
      this.#map[SESSION_WILDCARD]?.[SESSION_WILDCARD],
    ];
    const actions = new Set<string>();
    for (const cell of cells) {
      if (cell === undefined) continue;
      for (const action of cell) {
        if (action === SESSION_WILDCARD) return "all";
        actions.add(action);
      }
    }
    return actions;
  }

  /**
   * Whether `from` is permitted to run `action` on `to`'s session (post-wildcard).
   * The caller still enforces the topology edge (§10.2) and the recipient's
   * applicable action catalog (FR-96) on its own — this is only the ACL check.
   */
  permits(from: string, to: string, action: string): boolean {
    const allowed = this.allowedFor(from, to);
    return allowed === "all" || allowed.has(action);
  }

  /**
   * Whether `name` may run `action` on its OWN session — the deferred self-path
   * of §21 (a chain item), never a synchronous one. The exact parallel of
   * `CommandGrants.permitsSelf`, and for the same reason: the recipient
   * wildcards mean "any NEIGHBOUR", and self is not a neighbour, so restarting
   * yourself takes an explicit `{<name>: {<name>: […]}}` cell.
   */
  permitsSelf(name: string, action: string): boolean {
    const cell = this.#map[name]?.[name];
    if (cell === undefined) return false;
    return cell.includes(SESSION_WILDCARD) || cell.includes(action);
  }
}
