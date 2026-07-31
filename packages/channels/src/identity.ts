// Channel identity and addressing in users mode (§17.6, FR-125/FR-126).
//
// A channel that is not bound to one legacy operator resolves TWO things per
// inbound event:
//
//   1. the SENDER — the channel identity (telegram username/user-id, slack user-id)
//      is mapped to EXACTLY ONE user through the `users[].channels[<channel>].alias`
//      bindings (invariant §10.21). An unbound identity is refused politely and
//      never reaches the router: there are no guests;
//   2. the TARGET — channel-native mentions of OTHER bound users first, then plain
//      `@name` tokens against the sender's visible peers (agents/users/groups/tags,
//      the one namespace of §10.17), and finally SELF-delivery (`to = from`) when
//      nothing matched — the message stays with the user (self-chat, §17.7).
//
// Both resolvers are injected by the server (it owns the config and the topology),
// so the connectors stay free of config knowledge — exactly like `knownAgents`.

/** Injected users-mode identity port of ONE channel instance (§17.6). */
export interface ChannelIdentity {
  /** Alias in THIS channel → the bound user, or undefined (unbound ⇒ refused). */
  userOf(alias: string): string | undefined;
  /** The user's alias in THIS channel — the egress address (§17.5). */
  aliasOf(user: string): string | undefined;
  /**
   * Names this user may address: their topology neighbours plus the group/tag
   * nodes they are wired to (§10.2/§10.17). Used for the `@name` scan only — the
   * router re-checks the edge anyway (single delivery point, §8.2).
   */
  peersOf(user: string): readonly string[];
}

/** Token charset mirrors §3.2 / the safe file-id charset (§8.7). */
const AT_TOKEN = /@([A-Za-z0-9_.-]+)/g;

/**
 * Resolves the recipient of an inbound message in users mode (§17.6-2). Never
 * fails: with no mention matching anything the message is a note to self, which
 * is always deliverable (self-delivery needs no edge, §10.2).
 */
export function resolveUserTarget(
  text: string | undefined,
  sender: string,
  identity: ChannelIdentity,
): { readonly target: string; readonly self: boolean } {
  const peers = new Set(identity.peersOf(sender));
  for (const match of (text ?? "").matchAll(AT_TOKEN)) {
    const token = match[1];
    if (token === undefined) continue;
    // (a) channel-native mention of another bound user — "@alex_tg" in telegram.
    const mentioned = identity.userOf(token);
    if (mentioned !== undefined && mentioned !== sender) {
      return { target: mentioned, self: false };
    }
    // (b) a plain @name token against the sender's visible peers.
    if (peers.has(token)) return { target: token, self: false };
  }
  return { target: sender, self: true }; // (c) self-delivery (§17.6-2c)
}
