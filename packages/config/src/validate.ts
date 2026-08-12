// Semantic config validation — the closed list of §7.5 fail-fast rules, run after
// structural validation (schema.ts) and $ref/$env resolution. Every violation is a
// fatal ConfigError with its location (FR-33); the one non-fatal case (a bound
// operator with no edges) is returned as a warning.
//
// Rule 4 ("agent type is a known adapter") needs the adapter registry, which lives
// one layer up (@muxeon/adapters, §8.3) — config must NOT depend on it. So the
// known types are INJECTED via context; the composition root (server) supplies
// them. Topology neighbor checks reuse @muxeon/core's Topology (a legal config→core
// edge).

import {
  COMMAND_WILDCARD,
  FQN_SEPARATOR,
  SESSION_WILDCARD,
  Topology,
  isSessionAction,
} from "@muxeon/core";
import { joinPointer } from "./env";
import { ConfigError } from "./error";
import {
  type ChannelConfig,
  INTERNAL_COMMAND_SLASHES,
  type MuxeonConfig,
  channelName,
} from "./schema";

export interface ValidateContext {
  /** Registered adapter types (§8.3). When provided, enforces §7.5 "type known". */
  readonly knownAdapterTypes?: Iterable<string>;
}

/** Runs the §7.5 rules. Throws ConfigError on any fatal violation; returns warnings. */
export function validateRules(config: MuxeonConfig, context: ValidateContext = {}): string[] {
  const warnings: string[] = [];
  const agentNames = collectAgentNames(config); // rule 2: agent names unique
  const operatorNames = collectOperatorNames(config); // rule 5: one operator ≤ one channel
  // Users (§17.3, FR-121): the fifth namespace set and a queue-key owner of its own.
  const userNames = collectUserNames(config);
  assertNamesDisjoint(agentNames, operatorNames); // rule 2: agent/operator names disjoint
  assertQueueKeysUnique(config, operatorNames, userNames); // rule 3: tmux ∪ operators ∪ users
  assertKnownAdapterTypes(config, context.knownAdapterTypes); // rule 4 (if injected)

  // Groups & tags (§15, FR-106/FR-107): the broadcast namespace. Group names are
  // explicit (config.groups) and must form an acyclic forest; tags are implicit (the
  // union of agents' tags). All four kinds (agents/operators/groups/tags) share ONE
  // namespace and must be pairwise disjoint so a `to`/topology node resolves to
  // exactly one kind (§10.17). Groups/tags carry NO queue key — they are input-only.
  const groupNames = collectGroupNames(config); // FR-106: group names unique
  const tagNames = collectTagNames(config); // FR-107: implicit tag namespace
  assertGroupHierarchy(config, groupNames); // FR-106: parents exist, acyclic, no self-parent
  assertAgentGroups(config, groupNames); // FR-106: agents[].group names a declared group
  assertUserGroups(config, groupNames); // FR-130: users[].group names a declared group
  assertBroadcastNamespaceDisjoint(agentNames, operatorNames, groupNames, tagNames, userNames);

  // Federation (§18.3, FR-137): import names are the SIXTH set of the shared
  // namespace (§10.17), `@` is reserved as the FQN separator, export aliases are
  // unique, and the link listener never shares a port with anything else.
  // Relay-mode accepts (§18.11.4, FR-152) join the SAME link-name set: a
  // `relay: true` accept is a topology node and a queue segment exactly like an
  // import; accepts without `relay` stay outside (existing configs keep working).
  const importNames = collectImportNames(config);
  const relayAcceptNames = collectRelayAcceptNames(config, importNames);
  const linkNames = new Set([...importNames, ...relayAcceptNames]);
  assertNoFqnSeparatorInNames(config, importNames);
  assertImportNamespaceDisjoint(
    linkNames,
    agentNames,
    operatorNames,
    groupNames,
    tagNames,
    userNames,
  );
  assertExportAliasesUnique(config);
  assertFederationPorts(config);
  assertFederationQueueKey(config);

  // Topology nodes may now be groups/tags (input-only broadcast targets, §15.2),
  // users (§17.1 — full nodes with a queue of their own) and link names (§18.5 —
  // the server node granting all exported actors of that link, §18.10-6; a
  // relay accept is such a node too, §18.11.3/FR-154).
  const participants = new Set([
    ...agentNames,
    ...operatorNames,
    ...groupNames,
    ...tagNames,
    ...userNames,
    ...linkNames,
  ]);
  assertTopologyClosed(config, participants); // rule 1: topology nodes are known

  const topology = new Topology(config.topology);
  const channelNames = collectChannelNames(config); // §17.3/FR-125: instance names unique
  assertDefaultTargets(config, agentNames, topology); // rule 6: defaultTarget agent + neighbor
  assertWebchatChannels(config); // rule 9 (§12.2/§17.3): port/auth/bind, no defaultTarget
  assertUserChannelBindings(config, channelNames); // §17.3/FR-125: known channel, alias rules
  assertUserAuthPresence(config); // §17.3/FR-122: a webchat-bound user needs a password
  assertCommandGrants(config, agentNames, topology); // rule 10 (§7.5/FR-94): agent→agent command ACL
  assertSessionGrants(config, agentNames, topology); // rule 11 (§7.5/FR-96): agent→agent session-control ACL
  warnOperatorsWithoutEdges(operatorNames, topology, warnings); // rule 5: warning
  warnUsers(config, userNames, topology, warnings); // §17.3: no edges / a panel with no login
  warnLegacyOperators(config, warnings); // FR-132: bindOperator is deprecated by users[]
  warnFederation(config, warnings); // §18.2/§18.8: http:// links, an accept nobody holds
  warnPublishWithoutContent(config, warnings); // §18.11.1/FR-152: publish with nothing to publish

  return warnings;
}

function collectAgentNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, agent] of config.agents.entries()) {
    if (names.has(agent.name)) {
      throw new ConfigError(`duplicate agent name "${agent.name}"`, {
        path: joinPointer(joinPointer("/agents", String(i)), "name"),
      });
    }
    names.add(agent.name);
  }
  return names;
}

// Legacy operators (§12.1): channels that still bind ONE operator node. A channel
// in users mode (§17.2) has no bindOperator — its identities come from the users'
// bindings (FR-125), so it contributes no operator name.
function collectOperatorNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, channel] of config.channels.entries()) {
    const operator = channel.bindOperator;
    if (operator === undefined) continue;
    if (names.has(operator)) {
      throw new ConfigError(`operator "${operator}" is bound by more than one channel`, {
        path: joinPointer(joinPointer("/channels", String(i)), "bindOperator"),
      });
    }
    names.add(operator);
  }
  return names;
}

// §17.3 / FR-121: user names are unique. They join the ONE shared namespace
// (§10.17, asserted below) and own a queue key each (§5.3).
function collectUserNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, user] of (config.users ?? []).entries()) {
    if (names.has(user.name)) {
      throw new ConfigError(`duplicate user name "${user.name}"`, {
        path: joinPointer(joinPointer("/users", String(i)), "name"),
      });
    }
    names.add(user.name);
  }
  return names;
}

// §17.3 / FR-125: `channels[].name` (default: the type) is the key of every user
// binding, so it must be unique — two channels of one type MUST name themselves.
function collectChannelNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, channel] of config.channels.entries()) {
    const name = channelName(channel);
    if (names.has(name)) {
      throw new ConfigError(
        `duplicate channel name "${name}" — name the channels explicitly (§17.2)`,
        { path: joinPointer(joinPointer("/channels", String(i)), "name") },
      );
    }
    names.add(name);
  }
  return names;
}

function assertNamesDisjoint(agentNames: Set<string>, operatorNames: Set<string>): void {
  for (const name of operatorNames) {
    if (agentNames.has(name)) {
      throw new ConfigError(
        `name "${name}" is used by both an agent and an operator — queue key collision (§5.3)`,
      );
    }
  }
}

function assertQueueKeysUnique(
  config: MuxeonConfig,
  operatorNames: Set<string>,
  userNames: Set<string>,
): void {
  const owner = new Map<string, string>();
  for (const [i, agent] of config.agents.entries()) {
    const existing = owner.get(agent.tmux);
    if (existing !== undefined) {
      throw new ConfigError(
        `queue key "${agent.tmux}" is shared by ${existing} and agent "${agent.name}"`,
        {
          path: joinPointer(joinPointer("/agents", String(i)), "tmux"),
        },
      );
    }
    owner.set(agent.tmux, `agent "${agent.name}"`);
  }
  for (const operator of operatorNames) {
    const existing = owner.get(operator);
    if (existing !== undefined) {
      throw new ConfigError(
        `queue key "${operator}" is shared by ${existing} and operator "${operator}"`,
      );
    }
    owner.set(operator, `operator "${operator}"`);
  }
  // A user owns a pseudo-session queue exactly like an operator (§17.2/§5.3), so
  // its name must not collide with an agent's tmux session either.
  for (const user of userNames) {
    const existing = owner.get(user);
    if (existing !== undefined) {
      throw new ConfigError(`queue key "${user}" is shared by ${existing} and user "${user}"`);
    }
    owner.set(user, `user "${user}"`);
  }
}

// §7.5 / FR-106: group names are declared explicitly and must be unique.
function collectGroupNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, group] of (config.groups ?? []).entries()) {
    if (names.has(group.name)) {
      throw new ConfigError(`duplicate group name "${group.name}"`, {
        path: joinPointer(joinPointer("/groups", String(i)), "name"),
      });
    }
    names.add(group.name);
  }
  return names;
}

// §7.5 / FR-107: the tag namespace is IMPLICIT — the union of every agent's and
// (§17.2/FR-130) every user's `tags`; users are equal members of a tag.
function collectTagNames(config: MuxeonConfig): Set<string> {
  const tags = new Set<string>();
  for (const agent of config.agents) {
    for (const tag of agent.tags ?? []) tags.add(tag);
  }
  for (const user of config.users ?? []) {
    for (const tag of user.tags ?? []) tags.add(tag);
  }
  return tags;
}

// §7.5 / FR-106: every `parent` names a declared group, no group is its own parent,
// and the `parent` chains form a forest (acyclic). A cycle would make hierarchical
// member resolution (§15.4) non-terminating.
function assertGroupHierarchy(config: MuxeonConfig, groupNames: Set<string>): void {
  const groups = config.groups ?? [];
  const parentOf = new Map<string, string>();
  const indexOf = new Map<string, number>();
  for (const [i, group] of groups.entries()) {
    indexOf.set(group.name, i);
    if (group.parent === undefined) continue;
    const path = joinPointer(joinPointer("/groups", String(i)), "parent");
    if (group.parent === group.name) {
      throw new ConfigError(`group "${group.name}" cannot be its own parent`, { path });
    }
    if (!groupNames.has(group.parent)) {
      throw new ConfigError(`group "${group.name}" has unknown parent "${group.parent}"`, { path });
    }
    parentOf.set(group.name, group.parent);
  }
  // Walk each group's parent chain to a root; revisiting a node means a cycle.
  for (const start of groupNames) {
    const seen = new Set<string>([start]);
    let cur = parentOf.get(start);
    while (cur !== undefined) {
      if (seen.has(cur)) {
        throw new ConfigError(`group hierarchy has a cycle through "${cur}"`, {
          path: joinPointer(joinPointer("/groups", String(indexOf.get(cur) ?? 0)), "parent"),
        });
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
}

// §7.5 / FR-106: an agent's `group` (when set) names a declared group.
function assertAgentGroups(config: MuxeonConfig, groupNames: Set<string>): void {
  for (const [i, agent] of config.agents.entries()) {
    if (agent.group === undefined) continue;
    if (!groupNames.has(agent.group)) {
      throw new ConfigError(`agent "${agent.name}" references unknown group "${agent.group}"`, {
        path: joinPointer(joinPointer("/agents", String(i)), "group"),
      });
    }
  }
}

// §17.3 / FR-130: a user's `group` (when set) names a declared group — the same
// rule agents live by (§15.3); membership feeds the broadcast fan-out (§15.4).
function assertUserGroups(config: MuxeonConfig, groupNames: Set<string>): void {
  for (const [i, user] of (config.users ?? []).entries()) {
    if (user.group === undefined) continue;
    if (!groupNames.has(user.group)) {
      throw new ConfigError(`user "${user.name}" references unknown group "${user.group}"`, {
        path: joinPointer(joinPointer("/users", String(i)), "group"),
      });
    }
  }
}

// §17.3 / FR-125: every binding key names a DECLARED channel; the form must match
// the channel kind — webchat takes `true` (the login is the identity), telegram/
// slack take a non-empty `alias` that is UNIQUE within that channel (two users
// behind one alias would make the sender unresolvable, §10.21).
function assertUserChannelBindings(config: MuxeonConfig, channelNames: Set<string>): void {
  const byChannel = new Map<string, ChannelConfig>();
  for (const channel of config.channels) byChannel.set(channelName(channel), channel);
  const aliasOwner = new Map<string, string>(); // "<channel> <alias>" → user
  for (const [i, user] of (config.users ?? []).entries()) {
    for (const [channel, binding] of Object.entries(user.channels ?? {})) {
      const path = joinPointer(joinPointer(joinPointer("/users", String(i)), "channels"), channel);
      if (!channelNames.has(channel)) {
        throw new ConfigError(`user "${user.name}" binds unknown channel "${channel}"`, { path });
      }
      const declared = byChannel.get(channel);
      const isWebchat = declared?.type === "webchat";
      if (isWebchat && binding !== true) {
        throw new ConfigError(
          `webchat binding of "${user.name}" must be true — the login is the identity (§17.2)`,
          { path },
        );
      }
      if (!isWebchat && binding === true) {
        throw new ConfigError(
          `binding of "${user.name}" to "${channel}" requires an alias — the channel identity (§17.6)`,
          { path },
        );
      }
      if (binding === true) continue;
      const key = `${channel} ${binding.alias}`;
      const owner = aliasOwner.get(key);
      if (owner !== undefined) {
        throw new ConfigError(
          `alias "${binding.alias}" in channel "${channel}" is claimed by both "${owner}" and "${user.name}" (§10.21)`,
          { path: joinPointer(path, "alias") },
        );
      }
      aliasOwner.set(key, user.name);
    }
  }
}

// §17.3 / FR-122: `auth` is MANDATORY for a user bound to a webchat channel —
// that binding is a login, and a login without a password is not one.
function assertUserAuthPresence(config: MuxeonConfig): void {
  const webchatNames = new Set(
    config.channels.filter((c) => c.type === "webchat").map((c) => channelName(c)),
  );
  for (const [i, user] of (config.users ?? []).entries()) {
    if (user.auth !== undefined) continue;
    const bound = Object.keys(user.channels ?? {}).find((name) => webchatNames.has(name));
    if (bound !== undefined) {
      throw new ConfigError(
        `user "${user.name}" binds webchat channel "${bound}" and requires auth (§17.2)`,
        { path: joinPointer(joinPointer("/users", String(i)), "auth") },
      );
    }
  }
}

// §7.5 / §10.17: agents ∪ operators ∪ groups ∪ tags ∪ users is ONE namespace —
// FIVE pairwise disjoint sets since §17.1 — so any `to`/topology node resolves to
// exactly one kind. (agent↔operator disjointness is asserted separately by
// assertNamesDisjoint; agent/operator↔user collisions are also queue-key
// collisions and are caught by assertQueueKeysUnique.)
function assertBroadcastNamespaceDisjoint(
  agentNames: Set<string>,
  operatorNames: Set<string>,
  groupNames: Set<string>,
  tagNames: Set<string>,
  userNames: Set<string>,
): void {
  const collide = (name: string, a: string, b: string): never => {
    throw new ConfigError(
      `name "${name}" is used by both a ${a} and a ${b} — the broadcast namespace must be disjoint (§10.17)`,
    );
  };
  for (const g of groupNames) {
    if (agentNames.has(g)) collide(g, "group", "agent");
    if (operatorNames.has(g)) collide(g, "group", "operator");
    if (tagNames.has(g)) collide(g, "group", "tag");
    if (userNames.has(g)) collide(g, "group", "user");
  }
  for (const t of tagNames) {
    if (agentNames.has(t)) collide(t, "tag", "agent");
    if (operatorNames.has(t)) collide(t, "tag", "operator");
    if (userNames.has(t)) collide(t, "tag", "user");
  }
}

function assertKnownAdapterTypes(config: MuxeonConfig, known: Iterable<string> | undefined): void {
  if (known === undefined) return;
  const types = new Set(known);
  for (const [i, agent] of config.agents.entries()) {
    if (!types.has(agent.type)) {
      throw new ConfigError(
        `agent "${agent.name}" has unknown type "${agent.type}" (no registered adapter)`,
        {
          path: joinPointer(joinPointer("/agents", String(i)), "type"),
        },
      );
    }
  }
}

function assertTopologyClosed(config: MuxeonConfig, participants: Set<string>): void {
  // §18.3/§18.10-6: federation grants per-SERVER — an FQN can never be a node,
  // the edge goes on the import name. Said explicitly, not as "unknown".
  const reject = (name: string, path: string): never => {
    if (name.includes(FQN_SEPARATOR)) {
      throw new ConfigError(
        `topology node "${name}" is an FQN — federation edges are per-server, use the import name (§18.10-6)`,
        { path },
      );
    }
    throw new ConfigError(`topology references unknown participant "${name}"`, { path });
  };
  for (const [node, neighbors] of Object.entries(config.topology)) {
    if (!participants.has(node)) reject(node, joinPointer("/topology", node));
    for (const [i, neighbor] of neighbors.entries()) {
      if (!participants.has(neighbor)) {
        reject(neighbor, joinPointer(joinPointer("/topology", node), String(i)));
      }
    }
  }
}

// §7.5 rule 10 (FR-94/FR-95): the agent→agent command ACL is closed and coherent.
// Sender and recipient (when not the "*" wildcard) must be known AGENTS — an
// operator commands via the operator-plane, not the agent-plane MCP, and a slash
// runs on an agent's console, so an operator is neither a valid sender nor target.
// Every explicit (from→to) pair must have a topology edge (a grant only narrows
// WITHIN the graph, §10.2 — a grant without an edge can never fire), and may not
// target the sender itself. Every explicit command named for an explicit recipient
// must exist in that recipient's catalog (mergeCommands ∪ internal, FR-66/FR-67) —
// fail-fast on a typo. Wildcard cells skip the per-pair / per-command checks (they
// span recipients/commands that cannot be enumerated to one catalog).
function assertCommandGrants(
  config: MuxeonConfig,
  agentNames: Set<string>,
  topology: Topology,
): void {
  if (config.commandGrants === undefined) return;
  const catalogs = new Map<string, Set<string>>(); // recipient → its command slashes
  const catalogOf = (agent: string): Set<string> => {
    const cached = catalogs.get(agent);
    if (cached !== undefined) return cached;
    const found = config.agents.find((a) => a.name === agent);
    const slashes = new Set<string>(INTERNAL_COMMAND_SLASHES);
    for (const command of config.types?.[found?.type ?? ""]?.commands ?? [])
      slashes.add(command.slash);
    for (const command of found?.commands ?? []) slashes.add(command.slash);
    catalogs.set(agent, slashes);
    return slashes;
  };

  for (const [from, recipients] of Object.entries(config.commandGrants)) {
    const fromPath = joinPointer("/commandGrants", from);
    if (from !== COMMAND_WILDCARD && !agentNames.has(from)) {
      throw new ConfigError(`command grant sender "${from}" is not an existing agent`, {
        path: fromPath,
      });
    }
    for (const [to, slashes] of Object.entries(recipients)) {
      const toPath = joinPointer(fromPath, to);
      if (to !== COMMAND_WILDCARD && !agentNames.has(to)) {
        throw new ConfigError(`command grant recipient "${to}" is not an existing agent`, {
          path: toPath,
        });
      }
      const explicitPair = from !== COMMAND_WILDCARD && to !== COMMAND_WILDCARD;
      if (explicitPair && from === to) {
        throw new ConfigError(`command grant "${from} → ${to}" cannot target the sender itself`, {
          path: toPath,
        });
      }
      if (explicitPair && !topology.hasEdge(from, to)) {
        throw new ConfigError(
          `command grant "${from} → ${to}" has no topology edge — a command needs a §10.2 edge`,
          { path: toPath },
        );
      }
      if (to === COMMAND_WILDCARD) continue; // can't bind commands to one catalog
      const catalog = catalogOf(to);
      for (const [i, slash] of slashes.entries()) {
        if (slash === COMMAND_WILDCARD) continue;
        if (!catalog.has(slash)) {
          throw new ConfigError(
            `command grant "${from} → ${to}" names unknown command "${slash}" (not in "${to}"'s commands)`,
            { path: joinPointer(toPath, String(i)) },
          );
        }
      }
    }
  }
}

// Sender and recipient (when not the "*" wildcard) must be known AGENTS — an
// operator controls sessions via the operator-plane, not the agent-plane MCP, and a
// lifecycle action runs on an agent's session, so an operator is neither a valid
// sender nor target. Every explicit (from→to) pair must have a topology edge (a
// grant only narrows WITHIN the graph, §10.2) and may not target the sender itself.
// Every explicit action must be a known lifecycle action (SESSION_ACTIONS), and a
// start/restart/reload named for an explicit recipient requires that recipient to
// have a provision command (its applicable catalog, FR-7/FR-96) — fail-fast on a
// grant that can never fire, the parallel of FR-94's command-in-catalog check.
// Wildcard cells skip the per-pair / per-action checks (they span recipients/actions
// that cannot be bound to one agent).
function assertSessionGrants(
  config: MuxeonConfig,
  agentNames: Set<string>,
  topology: Topology,
): void {
  if (config.sessionGrants === undefined) return;
  // start/restart/reload need a way back up — a provision command on the recipient.
  const NEEDS_PROVISION = new Set(["start", "restart", "reload"]);
  const hasProvision = (agent: string): boolean =>
    config.agents.find((a) => a.name === agent)?.provision !== undefined;

  for (const [from, recipients] of Object.entries(config.sessionGrants)) {
    const fromPath = joinPointer("/sessionGrants", from);
    if (from !== SESSION_WILDCARD && !agentNames.has(from)) {
      throw new ConfigError(`session grant sender "${from}" is not an existing agent`, {
        path: fromPath,
      });
    }
    for (const [to, actions] of Object.entries(recipients)) {
      const toPath = joinPointer(fromPath, to);
      if (to !== SESSION_WILDCARD && !agentNames.has(to)) {
        throw new ConfigError(`session grant recipient "${to}" is not an existing agent`, {
          path: toPath,
        });
      }
      const explicitPair = from !== SESSION_WILDCARD && to !== SESSION_WILDCARD;
      if (explicitPair && from === to) {
        throw new ConfigError(`session grant "${from} → ${to}" cannot target the sender itself`, {
          path: toPath,
        });
      }
      if (explicitPair && !topology.hasEdge(from, to)) {
        throw new ConfigError(
          `session grant "${from} → ${to}" has no topology edge — an action needs a §10.2 edge`,
          { path: toPath },
        );
      }
      for (const [i, action] of actions.entries()) {
        const actionPath = joinPointer(toPath, String(i));
        if (action === SESSION_WILDCARD) continue;
        if (!isSessionAction(action)) {
          throw new ConfigError(
            `session grant "${from} → ${to}" names unknown action "${action}" (expected start/stop/shutdown/restart/reload)`,
            { path: actionPath },
          );
        }
        // An explicit recipient with a start/restart/reload grant must be startable.
        if (to !== SESSION_WILDCARD && NEEDS_PROVISION.has(action) && !hasProvision(to)) {
          throw new ConfigError(
            `session grant "${from} → ${to}" names "${action}" but "${to}" has no provision command to start it`,
            { path: actionPath },
          );
        }
      }
    }
  }
}

function assertDefaultTargets(
  config: MuxeonConfig,
  agentNames: Set<string>,
  topology: Topology,
): void {
  for (const [i, channel] of config.channels.entries()) {
    const target = channel.defaultTarget;
    if (target === undefined) continue;
    const path = joinPointer(joinPointer("/channels", String(i)), "defaultTarget");
    // In users mode addressing is by mention or self-delivery (§17.6) — there is
    // no single sender a default target could be authorized against.
    if (channel.bindOperator === undefined) {
      throw new ConfigError(
        "defaultTarget does not apply in users mode — address by @mention or self (§17.6)",
        { path },
      );
    }
    if (!agentNames.has(target)) {
      throw new ConfigError(`channel defaultTarget "${target}" is not an existing agent`, { path });
    }
    if (!topology.hasEdge(channel.bindOperator, target)) {
      throw new ConfigError(
        `channel defaultTarget "${target}" is not a topology neighbor of operator "${channel.bindOperator}" (§10.2)`,
        { path },
      );
    }
  }
}

/** Channel types that can run WITHOUT a bound operator, i.e. in users mode (§17.2). */
const USERS_MODE_TYPES = new Set(["webchat", "telegram", "slack"]);

// §7.5 «Канал webchat» (§12.2): the panel runs on its OWN port (the §8.1 surface
// is not extended), behind a mandatory password, and never uses @-addressing —
// the recipient is always explicit in the UI, so defaultTarget is an error.
// Since §17.2 the channel has TWO mutually exclusive identity modes: legacy
// (`bindOperator` + `auth.password`) and users (`auth.mode:"users"`, identity per
// login). A channel of any other type still needs its `bindOperator` unless it can
// take identities from user bindings (USERS_MODE_TYPES).
function assertWebchatChannels(config: MuxeonConfig): void {
  for (const [i, channel] of config.channels.entries()) {
    const base = joinPointer("/channels", String(i));
    if (channel.type !== "webchat") {
      if (channel.bindOperator === undefined && !USERS_MODE_TYPES.has(channel.type)) {
        throw new ConfigError(
          `channel type "${channel.type}" requires bindOperator — it has no per-user identity (§17.2)`,
          { path: joinPointer(base, "bindOperator") },
        );
      }
      continue;
    }

    const port = channel.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError("webchat requires a port (integer in 1..65535)", {
        path: joinPointer(base, "port"),
      });
    }
    if (port === config.server.port) {
      throw new ConfigError(
        `webchat port ${port} must differ from server.port (§12.2 — the §8.1 surface is not extended)`,
        { path: joinPointer(base, "port") },
      );
    }

    if (channel.bind !== undefined && (typeof channel.bind !== "string" || channel.bind === "")) {
      throw new ConfigError("webchat bind must be a non-empty string", {
        path: joinPointer(base, "bind"),
      });
    }

    // basePath (T120): the URL prefix the whole panel mounts under. "/"-led
    // segments, no trailing slash, no dot-led segments (".."/hidden — the same
    // discipline the static server enforces); absent ⇒ the root.
    if (channel.basePath !== undefined) {
      const basePath = channel.basePath;
      if (typeof basePath !== "string" || !WEBCHAT_BASE_PATH.test(basePath)) {
        throw new ConfigError(
          'webchat basePath must be "/"-led segments without a trailing slash (e.g. "/team")',
          { path: joinPointer(base, "basePath") },
        );
      }
    }

    // Identity mode (§17.3): users mode declares `auth.mode:"users"` and carries
    // NEITHER bindOperator NOR a channel password — every login is a user's own.
    const auth = channel.auth;
    const authPath = joinPointer(base, "auth");
    if (!isRecord(auth)) {
      // No auth block at all: in the legacy shape that is the missing password
      // (§12.2); with no bindOperator either, the channel declares no identity
      // source at all (§17.2).
      throw new ConfigError(
        channel.bindOperator !== undefined
          ? "webchat requires auth.password (an $env reference, §7.3)"
          : 'webchat requires either bindOperator (legacy) or auth.mode:"users" (§17.2)',
        { path: authPath },
      );
    }
    const usersMode = auth.mode === "users";
    if (auth.mode !== undefined && !usersMode) {
      throw new ConfigError('webchat auth.mode must be "users" when set (§17.2)', {
        path: joinPointer(authPath, "mode"),
      });
    }
    if (usersMode) {
      if (channel.bindOperator !== undefined) {
        throw new ConfigError(
          'webchat auth.mode:"users" and bindOperator are mutually exclusive (§17.3)',
          { path: joinPointer(base, "bindOperator") },
        );
      }
      if (auth.password !== undefined) {
        throw new ConfigError(
          'webchat auth.mode:"users" takes no channel password — each user has their own (§17.2)',
          { path: joinPointer(authPath, "password") },
        );
      }
    } else {
      if (channel.bindOperator === undefined) {
        throw new ConfigError(
          'webchat requires either bindOperator (legacy) or auth.mode:"users" (§17.2)',
          { path: joinPointer(base, "bindOperator") },
        );
      }
      // auth.password arrives here already $env-resolved (§7.3); inline values were
      // rejected pre-resolution (assertChannelSecretsAreEnvRefs).
      if (typeof auth.password !== "string" || auth.password === "") {
        throw new ConfigError("webchat requires auth.password (an $env reference, §7.3)", {
          path: authPath,
        });
      }
    }
    validateWebchatAuthSession(auth, authPath, usersMode);

    if (channel.defaultTarget !== undefined) {
      throw new ConfigError(
        "webchat does not use defaultTarget — the recipient is chosen explicitly in the UI (§12.2)",
        { path: joinPointer(base, "defaultTarget") },
      );
    }

    validateWebchatUpload(channel.upload, joinPointer(base, "upload"));
    validateWebchatHistory(channel.history, joinPointer(base, "history"));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** basePath grammar (T120): /seg(/seg)*, segments never dot-led (no ".."/hidden). */
const WEBCHAT_BASE_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

// auth: { password (required, $env §7.3), session?: { ttl?, renew?: duration } }
// — closed (§12.6). ttl and renew (FR-86) use the retain.age grammar (§7.1,
// e.g. "1d"); the parse happens at wiring (boot, fail-fast) like history.retain.age.
function validateWebchatAuthSession(
  auth: Record<string, unknown>,
  path: string,
  usersMode: boolean,
): void {
  for (const key of Object.keys(auth)) {
    // `mode` joins the closed set with users mode (§17.2); `password` stays a
    // legacy-only field (rejected above when the channel runs in users mode).
    if (key !== "password" && key !== "session" && !(usersMode && key === "mode")) {
      throw new ConfigError(`unknown auth field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  if (auth.session === undefined) return;
  const sessionPath = joinPointer(path, "session");
  const session = auth.session;
  if (!isRecord(session)) throw new ConfigError("expected an object", { path: sessionPath });
  for (const key of Object.keys(session)) {
    if (key !== "ttl" && key !== "renew") {
      throw new ConfigError(`unknown session field "${key}"`, {
        path: joinPointer(sessionPath, key),
      });
    }
  }
  for (const field of ["ttl", "renew"] as const) {
    const value = session[field];
    if (value !== undefined && (typeof value !== "string" || value === "")) {
      throw new ConfigError(`session.${field} must be a non-empty duration string (e.g. "1d")`, {
        path: joinPointer(sessionPath, field),
      });
    }
  }
}

// upload: { maxBytes?: positive int, mime?: non-empty string[] } — closed (§12.2).
function validateWebchatUpload(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("expected an object", { path });
  for (const key of Object.keys(value)) {
    if (key !== "maxBytes" && key !== "mime") {
      throw new ConfigError(`unknown upload field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  if (value.maxBytes !== undefined) {
    const maxBytes = value.maxBytes;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new ConfigError("upload.maxBytes must be a positive integer", {
        path: joinPointer(path, "maxBytes"),
      });
    }
  }
  if (value.mime !== undefined) {
    if (!Array.isArray(value.mime)) {
      throw new ConfigError("upload.mime must be an array of patterns", {
        path: joinPointer(path, "mime"),
      });
    }
    for (const [i, pattern] of value.mime.entries()) {
      if (typeof pattern !== "string" || pattern === "") {
        throw new ConfigError("expected a non-empty string", {
          path: joinPointer(joinPointer(path, "mime"), String(i)),
        });
      }
    }
  }
}

// history: { retain?: { age?: non-empty string, count?: non-negative int } } — closed (§12.3).
function validateWebchatHistory(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("expected an object", { path });
  for (const key of Object.keys(value)) {
    if (key !== "retain") {
      throw new ConfigError(`unknown history field "${key}"`, { path: joinPointer(path, key) });
    }
  }
  if (value.retain === undefined) return;
  const retainPath = joinPointer(path, "retain");
  const retain = value.retain;
  if (!isRecord(retain)) throw new ConfigError("expected an object", { path: retainPath });
  for (const key of Object.keys(retain)) {
    if (key !== "age" && key !== "count") {
      throw new ConfigError(`unknown retain field "${key}"`, {
        path: joinPointer(retainPath, key),
      });
    }
  }
  if (retain.age !== undefined && (typeof retain.age !== "string" || retain.age === "")) {
    throw new ConfigError("expected a non-empty string", { path: joinPointer(retainPath, "age") });
  }
  if (
    retain.count !== undefined &&
    (typeof retain.count !== "number" || !Number.isInteger(retain.count) || retain.count < 0)
  ) {
    throw new ConfigError("expected a non-negative integer", {
      path: joinPointer(retainPath, "count"),
    });
  }
}

function warnOperatorsWithoutEdges(
  operatorNames: Set<string>,
  topology: Topology,
  warnings: string[],
): void {
  for (const operator of operatorNames) {
    if (topology.neighbors(operator).length === 0) {
      warnings.push(
        `operator "${operator}" has no topology edges and can neither send nor receive`,
      );
    }
  }
}

// §17.3 advisories (never fatal): a user with no edges still has a working
// self-chat (self-delivery needs no edge, §10.2) but reaches nobody else; a
// users-mode panel with not a single bound user has no way in at all.
function warnUsers(
  config: MuxeonConfig,
  userNames: Set<string>,
  topology: Topology,
  warnings: string[],
): void {
  for (const user of userNames) {
    if (topology.neighbors(user).length === 0) {
      warnings.push(
        `user "${user}" has no topology edges — only their own self-chat works (§17.3)`,
      );
    }
  }
  for (const channel of config.channels) {
    if (channel.bindOperator !== undefined) continue;
    const name = channelName(channel);
    const bound = (config.users ?? []).some((user) => Object.hasOwn(user.channels ?? {}, name));
    if (!bound) {
      warnings.push(
        channel.type === "webchat"
          ? `webchat channel "${name}" runs in users mode with no user bound to it — nobody can log in (§17.3)`
          : `channel "${name}" runs in users mode with no user bound to it — inbound has no identity (§17.3)`,
      );
    }
  }
}

// §18.3 / FR-137: import names are unique — each is a routing tail (§18.4) and
// a topology node (§18.10-6), so two links under one name would be unresolvable.
function collectImportNames(config: MuxeonConfig): Set<string> {
  const names = new Set<string>();
  for (const [i, entry] of (config.imports ?? []).entries()) {
    const path = joinPointer(joinPointer("/imports", String(i)), "name");
    if (names.has(entry.name)) {
      throw new ConfigError(`duplicate import name "${entry.name}"`, { path });
    }
    assertLinkNameIsPathSafe(entry.name, path);
    names.add(entry.name);
  }
  for (const [i, entry] of (config.federation?.accept ?? []).entries()) {
    assertLinkNameIsPathSafe(
      entry.name,
      joinPointer(joinPointer("/federation/accept", String(i)), "name"),
    );
  }
  return names;
}

// §18.11.4 / FR-152: an accept with `relay: true` is a routing tail and a
// topology node exactly like an import, so its name must not collide with any
// import's — one tail must resolve to one link. Accepts without `relay` stay
// out of the set (compatibility: they are reply tails only, never topology nodes).
function collectRelayAcceptNames(config: MuxeonConfig, importNames: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const [i, entry] of (config.federation?.accept ?? []).entries()) {
    if (entry.relay !== true) continue;
    if (importNames.has(entry.name)) {
      throw new ConfigError(
        `relay accept name "${entry.name}" collides with an import — link names share one namespace (§10.17/§18.11.4)`,
        { path: joinPointer(joinPointer("/federation/accept", String(i)), "name") },
      );
    }
    names.add(entry.name);
  }
  return names;
}

// §18.5: a link name IS a queue directory segment (`<root>/fed/<link>/`), so it
// must be a plain single segment — the same discipline queue keys live by.
function assertLinkNameIsPathSafe(name: string, path: string): void {
  if (/[/\\\0]/.test(name) || name === "." || name === "..") {
    throw new ConfigError(
      `link name "${name}" must be a plain name — it keys a queue directory (§18.5)`,
      {
        path,
      },
    );
  }
}

// §18.3: `@` is reserved as the FQN separator — no local entity may carry it:
// actors (agents/operators/users), groups, tags, imports, accept names and
// export aliases. A local name with `@` would be indistinguishable from an FQN.
function assertNoFqnSeparatorInNames(config: MuxeonConfig, importNames: Set<string>): void {
  const offend = (kind: string, name: string, path?: string): never => {
    throw new ConfigError(
      `${kind} name "${name}" contains "${FQN_SEPARATOR}" — reserved as the FQN separator (§18.3)`,
      path !== undefined ? { path } : {},
    );
  };
  const has = (name: string): boolean => name.includes(FQN_SEPARATOR);
  for (const [i, agent] of config.agents.entries()) {
    if (has(agent.name))
      offend("agent", agent.name, joinPointer(joinPointer("/agents", String(i)), "name"));
    if (typeof agent.exported === "string" && has(agent.exported))
      offend(
        "export alias",
        agent.exported,
        joinPointer(joinPointer("/agents", String(i)), "exported"),
      );
    for (const tag of agent.tags ?? []) if (has(tag)) offend("tag", tag);
  }
  for (const [i, user] of (config.users ?? []).entries()) {
    if (has(user.name))
      offend("user", user.name, joinPointer(joinPointer("/users", String(i)), "name"));
    if (typeof user.exported === "string" && has(user.exported))
      offend(
        "export alias",
        user.exported,
        joinPointer(joinPointer("/users", String(i)), "exported"),
      );
    for (const tag of user.tags ?? []) if (has(tag)) offend("tag", tag);
  }
  for (const [i, channel] of config.channels.entries()) {
    const operator = channel.bindOperator;
    if (operator !== undefined && has(operator))
      offend(
        "operator",
        operator,
        joinPointer(joinPointer("/channels", String(i)), "bindOperator"),
      );
  }
  for (const [i, group] of (config.groups ?? []).entries()) {
    if (has(group.name))
      offend("group", group.name, joinPointer(joinPointer("/groups", String(i)), "name"));
  }
  for (const name of importNames) if (has(name)) offend("import", name);
  for (const [i, entry] of (config.federation?.accept ?? []).entries()) {
    if (has(entry.name))
      offend(
        "accept",
        entry.name,
        joinPointer(joinPointer("/federation/accept", String(i)), "name"),
      );
  }
}

// §18.3 / §10.17: link names (imports and relay accepts, §18.11.4) join the ONE
// shared namespace as the sixth set — a topology node / `to` must still resolve
// to exactly one kind.
function assertImportNamespaceDisjoint(
  linkNames: Set<string>,
  agentNames: Set<string>,
  operatorNames: Set<string>,
  groupNames: Set<string>,
  tagNames: Set<string>,
  userNames: Set<string>,
): void {
  const others: readonly [string, Set<string>][] = [
    ["agent", agentNames],
    ["operator", operatorNames],
    ["group", groupNames],
    ["tag", tagNames],
    ["user", userNames],
  ];
  for (const name of linkNames) {
    for (const [kind, set] of others) {
      if (set.has(name)) {
        throw new ConfigError(
          `name "${name}" is used by both a federation link and a ${kind} — the shared namespace must be disjoint (§10.17/§18.3)`,
        );
      }
    }
  }
}

// §18.3: export aliases are unique WITHIN the set of exported names (an actor
// exporting `true` contributes its own name). The export namespace is separate
// from the local one — an alias may legally match some other local name.
function assertExportAliasesUnique(config: MuxeonConfig): void {
  const owner = new Map<string, string>();
  const claim = (exportName: string, who: string, path: string): void => {
    const existing = owner.get(exportName);
    if (existing !== undefined) {
      throw new ConfigError(
        `export name "${exportName}" is claimed by both ${existing} and ${who} (§18.3)`,
        { path },
      );
    }
    owner.set(exportName, who);
  };
  for (const [i, agent] of config.agents.entries()) {
    if (agent.exported === undefined) continue;
    const exportName = agent.exported === true ? agent.name : agent.exported;
    claim(
      exportName,
      `agent "${agent.name}"`,
      joinPointer(joinPointer("/agents", String(i)), "exported"),
    );
  }
  for (const [i, user] of (config.users ?? []).entries()) {
    if (user.exported === undefined) continue;
    const exportName = user.exported === true ? user.name : user.exported;
    claim(
      exportName,
      `user "${user.name}"`,
      joinPointer(joinPointer("/users", String(i)), "exported"),
    );
  }
}

// §18.3: the link listener is its own surface (§18.7, decision §18.10-9) — its
// port may not collide with server.port or any channel's port.
function assertFederationPorts(config: MuxeonConfig): void {
  const federation = config.federation;
  if (federation === undefined) return;
  if (federation.port !== 0 && federation.port === config.server.port) {
    throw new ConfigError(
      `federation.port ${federation.port} must differ from server.port (§18.7 — a separate listener)`,
      { path: "/federation/port" },
    );
  }
  for (const channel of config.channels) {
    if (federation.port !== 0 && channel.port === federation.port) {
      throw new ConfigError(
        `federation.port ${federation.port} must differ from channel "${channelName(channel)}" port (§18.7)`,
        { path: "/federation/port" },
      );
    }
  }
  const seen = new Set<string>();
  for (const [i, entry] of federation.accept.entries()) {
    if (seen.has(entry.name)) {
      throw new ConfigError(`duplicate accept name "${entry.name}"`, {
        path: joinPointer(joinPointer("/federation/accept", String(i)), "name"),
      });
    }
    seen.add(entry.name);
  }
}

// §18.5: link queues live under `<root>/fed/<link>/`, so the segment "fed" is
// reserved as a queue key the moment federation is configured. Existing
// non-federated configs keep it (FR-146 — no behavior change without the blocks).
function assertFederationQueueKey(config: MuxeonConfig): void {
  const federated = (config.imports ?? []).length > 0 || config.federation !== undefined;
  if (!federated) return;
  for (const [i, agent] of config.agents.entries()) {
    if (agent.tmux === "fed") {
      throw new ConfigError('queue key "fed" is reserved for federation link queues (§18.5)', {
        path: joinPointer(joinPointer("/agents", String(i)), "tmux"),
      });
    }
  }
  for (const user of config.users ?? []) {
    if (user.name === "fed") {
      throw new ConfigError('queue key "fed" is reserved for federation link queues (§18.5)');
    }
  }
  for (const channel of config.channels) {
    if (channel.bindOperator === "fed") {
      throw new ConfigError('queue key "fed" is reserved for federation link queues (§18.5)');
    }
  }
}

// §18.2/§18.8 advisories (never fatal): a plain-http link is fine on a loopback
// test bench but not on a network; an unknown scheme IS fatal — the link client
// could never speak it. An empty accept list means the listener admits nobody.
function warnFederation(config: MuxeonConfig, warnings: string[]): void {
  for (const [i, entry] of (config.imports ?? []).entries()) {
    if (entry.url.startsWith("https://")) continue;
    if (entry.url.startsWith("http://")) {
      warnings.push(
        `import "${entry.name}" uses plain http:// — acceptable for local testing only (§18.8)`,
      );
      continue;
    }
    throw new ConfigError(`import "${entry.name}" url must be http(s)://`, {
      path: joinPointer(joinPointer("/imports", String(i)), "url"),
    });
  }
  if (config.federation !== undefined && config.federation.accept.length === 0) {
    warnings.push("federation.accept is empty — the link listener admits nobody (§18.2)");
  }
}

// §18.11.1 / FR-152 (advisory): `publish: true` with nothing to publish — no own
// exported actor and no OTHER transit import whose branch could ride along (the
// published link's own branch would only bounce off the hub's cycle guard).
function warnPublishWithoutContent(config: MuxeonConfig, warnings: string[]): void {
  const imports = config.imports ?? [];
  const hasExported =
    config.agents.some((agent) => agent.exported !== undefined) ||
    (config.users ?? []).some((user) => user.exported !== undefined);
  if (hasExported) return;
  for (const entry of imports) {
    if (entry.publish !== true) continue;
    const otherTransit = imports.some(
      (other) => other.name !== entry.name && (other.transit ?? true),
    );
    if (!otherTransit) {
      warnings.push(
        `import "${entry.name}" sets publish with no exported actors and no transit branches — nothing to publish (§18.11.1)`,
      );
    }
  }
}

// FR-132: `bindOperator` is the legacy single-login shape (§12.1). It keeps
// working unchanged — the core represents such an operator as a user without
// `auth` and with one binding (§17.9) — but a config that already declares
// `users[]` should move the rest across.
function warnLegacyOperators(config: MuxeonConfig, warnings: string[]): void {
  if ((config.users ?? []).length === 0) return;
  for (const channel of config.channels) {
    if (channel.bindOperator === undefined) continue;
    warnings.push(
      `channel "${channelName(channel)}" still binds operator "${channel.bindOperator}" — bindOperator is deprecated by users[] (§17.9/FR-132)`,
    );
  }
}
