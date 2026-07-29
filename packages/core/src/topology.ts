// Topology — the undirected graph of permitted communication edges (§7, §10.2).
// An edge means mutual permission to exchange messages; direction is irrelevant
// and duplicate declarations are harmless. Operators are ordinary nodes (declared
// implicitly via channel binding, §7.1). `core` performs no I/O.

export type AdjacencyMap = Readonly<Record<string, readonly string[]>>;

export class Topology {
  readonly #adjacency = new Map<string, Set<string>>();

  constructor(edges: AdjacencyMap) {
    for (const [node, neighbors] of Object.entries(edges)) {
      const set = this.#ensure(node);
      for (const other of neighbors) {
        if (other === node) continue; // a self-loop is not an edge (§10.2)
        set.add(other);
        this.#ensure(other).add(node); // undirected: record both directions
      }
    }
  }

  #ensure(node: string): Set<string> {
    let set = this.#adjacency.get(node);
    if (set === undefined) {
      set = new Set<string>();
      this.#adjacency.set(node, set);
    }
    return set;
  }

  /** Every node in the topology (agents and operators), sorted. */
  nodes(): string[] {
    return [...this.#adjacency.keys()].sort();
  }

  hasNode(node: string): boolean {
    return this.#adjacency.has(node);
  }

  /** Neighbors of `node` (symmetric, undirected), sorted; empty if unknown. */
  neighbors(node: string): string[] {
    return [...(this.#adjacency.get(node) ?? [])].sort();
  }

  /** Whether the edge `a—b` exists (symmetric). Self (a === b) is never an edge. */
  hasEdge(a: string, b: string): boolean {
    return this.#adjacency.get(a)?.has(b) ?? false;
  }

  /**
   * The §10.2 delivery rule: a message from→to is permitted iff it is
   * self-delivery (from === to, allowed without an edge — e.g. a routine to its
   * owner, §6.2) or an edge exists. The router is the single enforcement point
   * (§8.2); this method is the rule it applies.
   */
  canDeliver(from: string, to: string): boolean {
    return from === to || this.hasEdge(from, to);
  }
}
