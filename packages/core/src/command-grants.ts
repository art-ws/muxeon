// CommandGrants — the DIRECTED access-control map for agent→agent slash commands
// (§7.1, §8.6, FR-94/FR-95). Unlike Topology (undirected messaging), commanding a
// peer is a privilege with a direction: "<from> may run <slash> on <to>". A grant
// authorizes a command ONLY together with a topology edge (§10.2) and the
// recipient's real command catalog (FR-66) — this map narrows WITHIN neighbors, it
// never widens the graph. The "*" wildcard matches any sender key, any recipient
// key, and (as a command-list element) every command the recipient actually has.
// `core` performs no I/O.

export type CommandGrantsMap = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/** The wildcard token: any sender, any recipient, or every command (§7.1). */
export const COMMAND_WILDCARD = "*";

export class CommandGrants {
  readonly #map: CommandGrantsMap;

  constructor(map: CommandGrantsMap = {}) {
    this.#map = map;
  }

  /**
   * The commands `from` may run on `to`, resolving "*" wildcards across the four
   * matching cells (from→to, from→*, *→to, *→*). Returns "all" when any matching
   * grant lists "*" — every command the recipient actually has, the real catalog
   * still bounds it at execution (FR-66). Otherwise the explicit union of slash
   * names; an empty set means nothing is granted.
   */
  allowedFor(from: string, to: string): "all" | ReadonlySet<string> {
    const cells = [
      this.#map[from]?.[to],
      this.#map[from]?.[COMMAND_WILDCARD],
      this.#map[COMMAND_WILDCARD]?.[to],
      this.#map[COMMAND_WILDCARD]?.[COMMAND_WILDCARD],
    ];
    const slashes = new Set<string>();
    for (const cell of cells) {
      if (cell === undefined) continue;
      for (const slash of cell) {
        if (slash === COMMAND_WILDCARD) return "all";
        slashes.add(slash);
      }
    }
    return slashes;
  }

  /**
   * Whether `from` is permitted to run `/slash` on `to` (post-wildcard). The
   * caller still enforces the topology edge (§10.2) and the recipient's real
   * command catalog (FR-66) on its own — this is only the ACL check.
   */
  permits(from: string, to: string, slash: string): boolean {
    const allowed = this.allowedFor(from, to);
    return allowed === "all" || allowed.has(slash);
  }
}
