// FQN — the federated actor name (§18.1, decision §18.10-8): email-style
// `{actor}@{server}`, chains grow on the RIGHT (`bob@c@b` = "actor bob@c of my
// neighbour b") and resolve by the LAST separator — the tail must be a link this
// server knows, the head is passed to it verbatim and resolved there by the same
// rule. `@` is therefore banned in every local name (§18.3, validated in config).

/** The FQN separator (§18.1). Reserved: no local name may contain it (§18.3). */
export const FQN_SEPARATOR = "@";

/** True when the name crosses a federation link (§18.4) — i.e. contains `@`. */
export function isFqn(name: string): boolean {
  return name.includes(FQN_SEPARATOR);
}

/** An FQN split by its LAST `@` (§18.4): `head` stays opaque, `tail` names the link. */
export interface FqnParts {
  readonly head: string;
  readonly tail: string;
}

/**
 * Split an FQN by the LAST `@` (§18.4). Returns null for a local name or a
 * degenerate form (empty head/tail) — a malformed FQN is unroutable, not local.
 */
export function splitFqn(name: string): FqnParts | null {
  const at = name.lastIndexOf(FQN_SEPARATOR);
  if (at <= 0 || at === name.length - 1) return null;
  return { head: name.slice(0, at), tail: name.slice(at + 1) };
}

/** Append a server suffix (§18.4): the re-export/re-emission rule, `dev@c` → `dev@c@b`. */
export function appendServer(name: string, server: string): string {
  return `${name}${FQN_SEPARATOR}${server}`;
}
