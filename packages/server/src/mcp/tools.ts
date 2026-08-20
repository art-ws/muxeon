// The agent-plane tool set (§8.1, §8.6) — least-privilege: whoami, list_peers,
// send, get_status, get_history (T126, FR-87), get_screen (T214, FR-147 — read a
// neighbour's console as text, so a peer's REAL state can be observed and not just
// inferred from its status), plus two ACL-gated bridges into
// operator capabilities: the command pair list_commands/send_command (FR-94/FR-95,
// run a peer's slash commands) and the session pair list_controls/control_session
// (FR-96/FR-97, start/stop/shutdown/restart/reload a peer's session). Both bridges
// fire ONLY through their explicit ACL (commandGrants / sessionGrants) AND a
// topology edge; every OTHER operator capability (queue edits, routine CRUD,
// channels) stays absent — that is the §10.10 invariant, guarded in
// plane-isolation.test.ts. Each per-session Server is created bound to the caller's
// declared identity (§8.6); the tools close over it.

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentStatus,
  CommandGrants,
  SessionAction,
  SessionGrants,
  Signal,
  Topology,
} from "@muxeon/core";
import { SESSION_ACTIONS, isFqn, isSessionAction } from "@muxeon/core";
import type { Router } from "@muxeon/orchestrator";
import type { AttachedRef } from "../attach";

export interface AgentPlaneDeps {
  readonly topology: Topology;
  readonly router: Router;
  /** A peer's status: an agent's AgentStatus, "idle" for an operator, undefined if unknown. */
  peerStatus(name: string): AgentStatus | undefined;
  /**
   * A peer's kind (§15.5, FR-111): "agent" (operators included — an operator is an
   * agent in the plane, §2), "group", or "tag". Groups/tags are input-only broadcast
   * targets — no status, no console/session. Since §17.5 a peer can also be a
   * "user" — a human: no session, no console, and `presence` instead of a status
   * (FR-133). Absent ⇒ every peer is an "agent" (backward-compatible).
   */
  peerType?(name: string): "agent" | "group" | "tag" | "user";
  /**
   * A user peer's presence (§17.5, FR-133): "online" while their last outgoing send
   * is inside `server.presenceTtl`, else "offline". Absent ⇒ presence is not wired.
   */
  peerPresence?(name: string): "online" | "offline" | undefined;
  /**
   * Is a peer PAUSED (§16.5, FR-119)? Read-only for the agent plane: a caller sees
   * that a neighbour is paused (so it can stop hammering a wall) but can never set
   * or clear the flag — pausing is an operator operation and no new bridge into the
   * operator plane is opened (§10.10). Absent ⇒ nobody is paused.
   */
  peerPaused?(name: string): boolean;
  /**
   * The caller's message history with one peer (T126, FR-87): the last `limit`
   * records of the pair, both directions, chronological — the transport log
   * (§8.2) read-only. Absent ⇒ get_history answers UNAVAILABLE (tests, mcp
   * off-paths) — the tool never invents an empty history.
   */
  pairHistory?(
    caller: string,
    peer: string,
    limit: number,
    /** Centre the window on this message id (FR-179) — empty result ⇒ unknown id. */
    around?: string,
  ): Promise<readonly Signal[]>;
  /**
   * A NEIGHBOUR's console as text (FR-147): the visible tmux pane, optionally with
   * `historyLines` of scrollback above it. Read-only observation — no lane, no
   * injection, no mutation (§10.8): the caller reads what a human would see over
   * the agent's shoulder, so it can judge the peer's actual state instead of
   * guessing from `get_status`. Throws when there is no live session (surfaced as
   * SCREEN_FAILED). Absent ⇒ get_screen answers UNAVAILABLE — the tool never
   * invents an empty screen.
   */
  screen?(name: string, historyLines?: number): Promise<string>;
  /**
   * The directed agent→agent command ACL (FR-94/FR-95). Absent ⇒ no command is
   * granted (list_commands answers empty, send_command answers COMMAND_DENIED).
   */
  readonly commandGrants?: CommandGrants;
  /**
   * A recipient's command catalog as slash names (mergeCommands ∪ internal,
   * FR-66/FR-67) — list_commands intersects it with the caller's grant. Absent ⇒
   * list_commands answers empty.
   */
  listCommands?(name: string): readonly string[];
  /**
   * Run an allowed slash command on `name` (the recipient) and resolve to its
   * captured console output — the operator command path (control-lane + idle
   * guard, FR-66). Throws on busy/down/unknown command → surfaced as
   * COMMAND_FAILED. Absent ⇒ send_command answers COMMAND_DENIED.
   */
  runCommand?(name: string, slash: string): Promise<string>;
  /**
   * The directed agent→agent session-control ACL (FR-96/FR-97). Absent ⇒ no action
   * is granted (list_controls answers empty, control_session answers CONTROL_DENIED).
   */
  readonly sessionGrants?: SessionGrants;
  /**
   * A recipient's APPLICABLE lifecycle actions — `[stop, shutdown]` always, plus
   * `[start, restart, reload]` when it has a provision command (FR-7). list_controls
   * intersects it with the caller's grant. Absent ⇒ list_controls answers empty.
   */
  listControls?(name: string): readonly SessionAction[];
  /**
   * Run an allowed lifecycle action on `name` (the recipient) and resolve to the
   * resulting status — the operator lifecycle path (control lane, FR-7/FR-8/FR-64).
   * Throws on a missing provision block / busy / unknown agent → surfaced as
   * CONTROL_FAILED. Absent ⇒ control_session answers CONTROL_DENIED.
   */
  controlSession?(name: string, action: SessionAction): Promise<AgentStatus>;
  /**
   * Close the caller's own running turn after a DELIVERED reply (§13.6, FR-157).
   * Called only when `send` carried a `replyTo` and the router accepted it: the
   * compact reply contract tells the agent that this one call also ends its turn,
   * and this is what makes that true — the server removes the message.json the
   * agent would otherwise have deleted by hand, so file-detect (FR-53) fires at
   * once instead of the turn waiting out the slower output detector.
   *
   * Ordering matters: closing only AFTER a successful route means a refused send
   * (WIP cap FR-104, recipient paused §16.2) leaves the turn open, so the agent
   * still holds the floor and can retry or fall back. Resolves true when a live
   * turn was actually closed — the caller suppresses that turn's file collection
   * on the strength of it (§10.29). Absent ⇒ send never closes turns (tests).
   */
  closeTurn?(caller: string, replyTo: string): Promise<boolean>;
  /**
   * Ingest the caller's `files` into blob refs (§12.5, FR-159) under the SAME
   * realpath containment the outbox uses (§8.7) — the caller's own cwd and
   * exchange dir, never anywhere else. Resolves to the refs, or to a reason
   * string which `send` surfaces as a refusal.
   *
   * Absent ⇒ attachments are unavailable and a send carrying `files` is refused
   * rather than silently delivered without them: an answer missing the report it
   * announced is worse than an error the agent can act on.
   */
  attach?(caller: string, files: readonly string[]): Promise<AttachedRef[] | string>;
  /**
   * Reactions (§19.7, FR-167): the declared catalog and the one operation over it.
   * The pair is always (the user `peer`, the caller) — structurally, an agent can
   * only mark a message in a chat it is part of. Absent ⇒ both tools answer
   * REACTIONS_DISABLED rather than pretending an empty palette.
   */
  readonly reactions?: ReactionPlane;
  /** Clock for message ts; default Date.now. Injectable for tests. */
  readonly now?: () => number;
  /** Idempotency-id generator when send omits one (§5.3/§10.9); default randomUUID. */
  readonly newId?: () => string;
  /**
   * Federated peers visible to the caller (§18.4, FR-140/FR-150): every actor of
   * every import the caller has a topology edge on (§18.10-6), carrying the
   * read-only status projection — `unknown` when the source is unreachable
   * (§10.27). Absent ⇒ no federation; an FQN name answers UNKNOWN_PEER.
   */
  remotePeers?(): readonly FederatedPeer[];
}

/**
 * The reaction plane the tools see (§19.7) — structurally the webchat hub,
 * redeclared here so the tool set keeps its narrow, data-only dependency surface.
 */
export interface ReactionPlane {
  /** The declared palette (§19.2). Recent order is a picker affordance, not an agent's. */
  catalog(): {
    readonly categories: readonly { readonly name: string; readonly title?: string }[];
    readonly items: readonly {
      readonly key: string;
      readonly emoji: string;
      readonly label?: string;
      readonly category?: string;
    }[];
  };
  /** Place/remove one reaction; a refusal carries its §19.7 code, never a silent no-op. */
  react(input: {
    readonly owner: string;
    readonly peer: string;
    readonly actor: string;
    readonly messageId: string;
    readonly key: string;
    readonly remove?: boolean;
  }): Promise<
    | {
        readonly ok: true;
        readonly reactions: readonly { readonly key: string; readonly count: number }[];
      }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
}

/** A federated peer row (§18.4) — the FR-140 shape list_peers/get_status read. */
export interface FederatedPeer {
  readonly name: string;
  readonly type: "agent" | "user";
  readonly server: string;
  readonly link: "up" | "down";
  readonly status?: AgentStatus | "unknown";
  readonly presence?: "online" | "offline" | "unknown";
  readonly paused: boolean;
  readonly reason?: "link-down" | "not-published" | "hop-down";
}

/** The closed tool set (§8.6); AGENT_TOOLS keys off this and the §10.10 guard asserts it. */
export const AGENT_TOOL_NAMES = [
  "whoami",
  "list_peers",
  "send",
  "get_status",
  "get_history",
  "get_screen",
  "list_commands",
  "send_command",
  "list_controls",
  "control_session",
  "list_reactions",
  "react",
] as const;

/** get_history depth bounds (FR-87) — mirrors the §12.4 history paging caps. */
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

/**
 * get_screen scrollback bound (FR-147): the default capture is the VISIBLE pane —
 * exactly what the panel's console shows (§12.9, FR-102) and what a human sees. A
 * caller may ask for scrollback above it, capped so one tool call can never drag
 * an agent's whole session into another agent's context.
 */
export const SCREEN_MAX_HISTORY_LINES = 500;

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * Fold ingested attachments into the delivered payload as the §12.5 shape
 * `{ text?, blobs }` — the same envelope the exchange reply and the outbox
 * produce, so a recipient reads attachments identically whichever path sent
 * them. No files ⇒ the payload passes through UNTOUCHED, which is what keeps
 * every existing `send` byte-identical on the wire.
 */
export function withAttachments(payload: unknown, refs: readonly AttachedRef[]): unknown {
  if (refs.length === 0) return payload;
  if (typeof payload === "string") return { text: payload, blobs: refs };
  if (payload !== null && typeof payload === "object") {
    // A structured agent-to-agent payload keeps its own fields; refs APPEND to
    // any blobs already there rather than replacing them.
    const existing = (payload as { blobs?: unknown }).blobs;
    return {
      ...(payload as Record<string, unknown>),
      blobs: [...(Array.isArray(existing) ? existing : []), ...refs],
    };
  }
  return { text: String(payload), blobs: refs };
}

export const AGENT_TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Echo the caller's declared topology identity.",
    inputSchema: EMPTY_INPUT,
  },
  {
    name: "list_peers",
    description:
      "List the caller's topology neighbors with their type (agent|group|tag) and, " +
      "for agents/operators, their status. Groups and tags are input-only broadcast " +
      "targets — no status.",
    inputSchema: EMPTY_INPUT,
  },
  {
    name: "send",
    description:
      "Send a message to a neighbor via the router (topology edge required). " +
      "The payload is delivered AS-IS and is exactly what the recipient reads. " +
      "A `to` naming a group/tag broadcasts one-directionally to its members. " +
      'Sending a pure receipt ("ok", "принято", "closing this")? Pass ' +
      "expectsReply:false — the recipient is then told no answer is expected, " +
      "which is the only way to keep a receipt from earning a receipt.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "neighbor name (agent, operator, group or tag)" },
        payload: {
          description:
            "the message body the recipient reads. When replying to a human " +
            "(operator), pass the PLAIN TEXT of your answer itself — never a " +
            "status/receipt object. Structured payloads are for agent-to-agent signals.",
        },
        replyTo: { type: "string", description: "id of the message being answered" },
        kind: { type: "string", description: 'signal kind; default "message"' },
        expectsReply: {
          type: "boolean",
          description:
            "does this message ask for an answer? Default true. Pass false for a " +
            "receipt or a closing note: the recipient gets your text plus " +
            '"no reply is expected", is given no reply path at all, and owes you ' +
            "nothing back. Use it whenever your text says «don't answer» — " +
            "saying so in the text alone does not stop the reply contract.",
        },
        id: { type: "string", description: "idempotency key; the server generates one if omitted" },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "paths of files to attach — absolute, or relative to your working " +
            "directory. They must live inside your working directory or your " +
            "exchange dir. All or nothing: one bad path fails the whole send.",
        },
      },
      required: ["to", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Read a NEIGHBOR's status (idle/busy/down); restricted to the caller's neighbors.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "neighbor name" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_history",
    description:
      "Read your message history with a NEIGHBOR (both directions, chronological, " +
      "JSON records) — recover the dialogue after a context clear or restart, or " +
      "resolve a message you were handed by id (`around`). Restricted to the caller's neighbors.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "neighbor name (agent or operator)" },
        around: {
          type: "string",
          description:
            "message id to centre the window on — pass the replyTo= id you were handed to read the quoted message and its context",
        },
        limit: {
          type: "number",
          description: `depth: how many newest records to return (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT})`,
        },
      },
      required: ["peer"],
      additionalProperties: false,
    },
  },
  {
    name: "get_screen",
    description:
      "Read a NEIGHBOR's console as text — the visible pane of its terminal, the " +
      "same view a human gets. Use it to SEE what a peer is actually doing (which " +
      "prompt it sits on, what it printed, whether it is stuck) instead of inferring " +
      "it from get_status. Read-only: nothing is typed or sent. Restricted to the " +
      "caller's neighbors; only agents have a console.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "neighbor name (an agent)" },
        historyLines: {
          type: "number",
          description: `scrollback lines ABOVE the visible pane (default 0 = the visible screen only, max ${SCREEN_MAX_HISTORY_LINES})`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_commands",
    description:
      "List the slash commands you may run on a NEIGHBOR via send_command — your " +
      "command grants intersected with that agent's command catalog. Restricted " +
      "to the caller's neighbors; empty when nothing is granted.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "neighbor name (an agent)" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "send_command",
    description:
      "Run a slash command on a NEIGHBOR's console (e.g. clear, compact) and " +
      "return its captured output. Permitted only when a command grant allows it " +
      "AND a topology edge exists; the recipient must be idle. Use list_commands " +
      "to see what you may run.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "neighbor name (an agent)" },
        slash: {
          type: "string",
          description: 'command name WITHOUT the leading slash (e.g. "clear")',
        },
      },
      required: ["to", "slash"],
      additionalProperties: false,
    },
  },
  {
    name: "list_controls",
    description:
      "List the lifecycle actions you may run on a NEIGHBOR's session via " +
      "control_session — your session grants intersected with the actions that " +
      "agent supports. Restricted to the caller's neighbors; empty when nothing " +
      "is granted.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "neighbor name (an agent)" } },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "control_session",
    description:
      "Control a NEIGHBOR's session: start | stop | shutdown | restart | reload. " +
      "stop/restart are immediate (a hard kill interrupts any turn); shutdown/reload " +
      "ask the agent to quit first. Permitted only when a session grant allows it " +
      "AND a topology edge exists. Returns the resulting status. Use list_controls " +
      "to see what you may run.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "neighbor name (an agent)" },
        action: {
          type: "string",
          enum: [...SESSION_ACTIONS],
          description: "one of start | stop | shutdown | restart | reload",
        },
      },
      required: ["to", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reactions",
    description:
      "List the reactions this server declares — the closed palette you may place " +
      "with `react`: key, emoji and (when configured) label and category. Empty " +
      "means reactions are not configured here.",
    inputSchema: EMPTY_INPUT,
  },
  {
    name: "react",
    description:
      "Mark ONE message of a neighbour — a person OR another agent — with a reaction " +
      "instead of writing a message about it. This is the cheapest possible receipt: " +
      "it costs the other side no answer at all. The message must be one from your " +
      "chat with that neighbour (use the id you were given, or one from get_history). " +
      "Several different keys may sit on one message; the same key twice is a no-op. " +
      "`remove: true` takes back YOUR OWN reaction — never someone else's.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "neighbour name — the person or agent whose chat holds it",
        },
        messageId: { type: "string", description: "id of the message to mark" },
        key: { type: "string", description: "reaction key from list_reactions" },
        remove: { type: "boolean", description: "remove your own reaction instead of placing it" },
      },
      required: ["peer", "messageId", "key"],
      additionalProperties: false,
    },
  },
];

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

// Named error, not "success" (§8.6): isError marks the tool call failed and carries
// the code (TOPOLOGY_DENIED / UNKNOWN_PEER / INVALID_ARGS).
function fail(code: string, message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: code },
    isError: true,
  };
}

async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  caller: string,
  deps: AgentPlaneDeps,
): Promise<CallToolResult> {
  // A peer's kind (§15.5, FR-111); default "agent" when no groups/tags are configured.
  const typeOf = (name: string): "agent" | "group" | "tag" | "user" =>
    deps.peerType?.(name) ?? "agent";
  switch (tool) {
    case "whoami":
      return ok({ name: caller });

    case "list_peers": {
      // Each neighbor carries its type (§15.5); groups/tags are input-only — no status.
      const peers = deps.topology.neighbors(caller).map((name) => {
        const type = typeOf(name);
        // `paused` (§16.5) rides beside the status, never inside it — the two are
        // orthogonal (§16.1); a group/tag has neither.
        // A user (§17.5, FR-133) carries `presence`, never a session status; a
        // group/tag carries neither. The legacy operator keeps reporting "agent"
        // (§15.1) — compatibility with the pre-§17 plane.
        if (type === "user") {
          return {
            name,
            type,
            presence: deps.peerPresence?.(name) ?? "offline",
            paused: deps.peerPaused?.(name) ?? false,
          };
        }
        return type === "agent"
          ? {
              name,
              type,
              status: deps.peerStatus(name) ?? "down",
              paused: deps.peerPaused?.(name) ?? false,
            }
          : { name, type };
      });
      // Federated peers (§18.4, FR-140/FR-150): every actor of every import the
      // caller has an edge on, FQN-named, with `server`, link reachability and
      // the read-only projection — `unknown` never masquerades as idle/down.
      const remote = (deps.remotePeers?.() ?? []).map((peer) => ({
        name: peer.name,
        type: peer.type,
        server: peer.server,
        link: peer.link,
        ...(peer.status !== undefined ? { status: peer.status } : {}),
        ...(peer.presence !== undefined ? { presence: peer.presence } : {}),
        paused: peer.paused,
        ...(peer.reason !== undefined ? { reason: peer.reason } : {}),
      }));
      return ok({ peers: [...peers, ...remote] });
    }

    case "get_status": {
      const name = args.name;
      if (typeof name !== "string") return fail("INVALID_ARGS", "name must be a string");
      // A federated peer (§18.4, FR-150): the cached projection — never a probe
      // over the link. An unreachable source is UNAVAILABLE, not a fake "down"
      // (§10.27); a remote human is NOT_STATUSABLE exactly like a local one.
      if (isFqn(name)) {
        const peer = (deps.remotePeers?.() ?? []).find((entry) => entry.name === name);
        if (peer === undefined) return fail("UNKNOWN_PEER", `not a visible peer: ${name}`);
        if (peer.type === "user") {
          return fail("NOT_STATUSABLE", `"${name}" is a user — presence arrives in list_peers`);
        }
        if (peer.status === undefined || peer.status === "unknown") {
          const cause =
            peer.reason === "not-published"
              ? "the owner does not publish statuses"
              : "the link is unreachable";
          return fail("UNAVAILABLE", `status of "${name}" is unknown — ${cause}`);
        }
        return ok({ status: peer.status, paused: peer.paused });
      }
      // Neighbor-scope (§8.7/§10.11): a node outside the caller's neighborhood is not
      // revealed — same visibility as list_peers. Self is not a neighbor.
      if (!deps.topology.hasEdge(caller, name))
        return fail("UNKNOWN_PEER", `not a neighbor: ${name}`);
      // A group/tag has no status (§15.5), and neither has a user (§17.5: presence
      // is not a session status — it arrives in list_peers). Report it plainly.
      if (typeOf(name) !== "agent")
        return fail("NOT_STATUSABLE", `"${name}" is a ${typeOf(name)} — it has no status`);
      return ok({
        status: deps.peerStatus(name) ?? "down",
        paused: deps.peerPaused?.(name) ?? false, // §16.5 — orthogonal to the status
      });
    }

    case "get_history": {
      const { peer, limit, around } = args;
      if (typeof peer !== "string") return fail("INVALID_ARGS", "peer must be a string");
      if (around !== undefined && (typeof around !== "string" || around.length === 0)) {
        return fail("INVALID_ARGS", "around must be a non-empty message id");
      }
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
      ) {
        return fail("INVALID_ARGS", "limit must be a positive integer");
      }
      // Neighbor-scope (§8.7/§10.11): the same visibility as get_status — the
      // history of a pair the caller is not wired to is not revealed.
      if (!deps.topology.hasEdge(caller, peer)) {
        return fail("UNKNOWN_PEER", `not a neighbor: ${peer}`);
      }
      if (deps.pairHistory === undefined) {
        return fail("UNAVAILABLE", "the history port is not wired");
      }
      const depth = Math.min(limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
      const records = await deps.pairHistory(
        caller,
        peer,
        depth,
        ...(typeof around === "string" ? ([around] as const) : []),
      );
      // An `around` that matched nothing is NEWS, not an empty chat (FR-179): the
      // id was quoted at the agent, so "I cannot find it" must not arrive dressed
      // as "there is no history" — nor as the newest records, which answer a
      // different question.
      if (typeof around === "string" && records.length === 0) {
        return fail("UNKNOWN_MESSAGE", `no message "${around}" in the chat with ${peer}`);
      }
      return ok({ peer, records, ...(typeof around === "string" ? { around } : {}) });
    }

    case "get_screen": {
      const { name, historyLines } = args;
      if (typeof name !== "string") return fail("INVALID_ARGS", "name must be a string");
      if (
        historyLines !== undefined &&
        (typeof historyLines !== "number" || !Number.isInteger(historyLines) || historyLines < 0)
      ) {
        return fail("INVALID_ARGS", "historyLines must be a non-negative integer");
      }
      // Neighbor-scope (§8.7/§10.11): the same visibility gate as get_status — a
      // console outside the caller's neighborhood is not revealed, and the edge is
      // the ONLY gate (FR-147: observation is symmetric with being able to talk).
      if (!deps.topology.hasEdge(caller, name)) {
        return fail("UNKNOWN_PEER", `not a neighbor: ${name}`);
      }
      // Only an agent has a console: a user (§17.7), a group or a tag (§15.5) has
      // none — say so plainly instead of returning an empty screen.
      if (typeOf(name) !== "agent") {
        return fail("NOT_CAPTURABLE", `"${name}" is a ${typeOf(name)} — it has no console`);
      }
      if (deps.screen === undefined) {
        return fail("UNAVAILABLE", "the screen port is not wired");
      }
      // A down agent has no pane to capture — a mechanical, retryable fact, not a
      // policy denial. Pause (§16) does NOT hide the screen: it gates delivery,
      // never observation (§10.8 is read-only either way).
      if ((deps.peerStatus(name) ?? "down") === "down") {
        return fail("AGENT_DOWN", `"${name}" has no live session to capture`);
      }
      const lines = Math.min(historyLines ?? 0, SCREEN_MAX_HISTORY_LINES);
      try {
        return ok({ name, screen: await deps.screen(name, lines) });
      } catch (error) {
        return fail("SCREEN_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    case "send": {
      const { to, payload, replyTo, id, kind, files, expectsReply } = args;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      if (payload === undefined) return fail("INVALID_ARGS", "payload is required");
      // forward-compat kinds (§5.3/FR-25b): the closed set grows by requirement (R3)
      if (kind !== undefined && kind !== "message" && kind !== "reaction") {
        return fail("INVALID_ARGS", `unsupported kind "${String(kind)}"`);
      }
      // The receipt modifier (§13.7, FR-180): `false` delivers this message as a
      // NOTICE — the recipient reads it and is told no answer is expected, so an
      // "ok"/"принято" cannot start an ack chain. Not a kind: what changes is the
      // instruction the recipient reads, not the route this message takes.
      if (expectsReply !== undefined && typeof expectsReply !== "boolean") {
        return fail("INVALID_ARGS", "expectsReply must be a boolean");
      }
      // Attachments (FR-159, §12.5). Ingested BEFORE routing: a refusal must not
      // leave a delivered message whose promised files are missing.
      let refs: readonly AttachedRef[] = [];
      if (files !== undefined) {
        if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || f.length === 0)) {
          return fail("INVALID_ARGS", "files must be an array of non-empty path strings");
        }
        if (deps.attach === undefined) {
          return fail("ATTACH_FAILED", "attachments are not available on this server");
        }
        const ingested = await deps.attach(caller, files as string[]);
        if (typeof ingested === "string") return fail("ATTACH_FAILED", ingested);
        refs = ingested;
      }
      const message: Signal = {
        id: typeof id === "string" && id.length > 0 ? id : (deps.newId ?? randomUUID)(),
        from: caller, // identity is the session's, not anything the caller passes (§8.6)
        to,
        kind: kind === "reaction" ? "reaction" : "message",
        ts: (deps.now ?? Date.now)(),
        payload: withAttachments(payload, refs),
        ...(typeof replyTo === "string" ? { replyTo } : {}),
        ...(typeof expectsReply === "boolean" ? { expectsReply } : {}),
      };
      // A `to` naming a group/tag fans out in the router (§15.4); an agent/operator
      // takes the single-delivery path. The router classifies — the caller need not.
      const result = await deps.router.route(message); // edge check (§10.2) → enqueue/fan-out
      if (!result.ok) {
        // WIP backpressure (FR-104): a mechanical refusal, not a policy denial —
        // the receipt tells the caller to retry once the recipient drains.
        if (result.code === "WIP_LIMIT") {
          return fail(
            result.code,
            `"${to}" is at its WIP limit (${result.limit}); ${result.depth} in flight — retry when it drains`,
          );
        }
        // Pause (§16.2, FR-117): an operator-declared refusal, and the message was
        // DROPPED — say both, so the caller retries later instead of assuming delivery.
        if (result.code === "AGENT_PAUSED") {
          return fail(
            result.code,
            `"${to}" is paused by the operator — the message was discarded, retry when it resumes`,
          );
        }
        return fail(result.code, `delivery to "${to}" not permitted`);
      }
      // The reply is out — close the caller's own turn if this send answered it
      // (§13.6, FR-157). Best-effort and non-fatal: the delivery already happened,
      // so a failure here costs a slower turn end (the output detector still wins
      // the race, §5.2), never the answer. `turnClosed` is echoed so an agent —
      // and a test — can see that the call was understood as ending the turn.
      // The field is present ONLY on a reply (a send carrying replyTo) — that is
      // where it carries information. A plain send keeps its historical receipt
      // shape exactly: no agent should have to re-learn a wire it never uses.
      const answersATurn = typeof replyTo === "string" && replyTo.length > 0;
      const closed =
        answersATurn && deps.closeTurn !== undefined
          ? { turnClosed: await deps.closeTurn(caller, replyTo).catch(() => false) }
          : {};
      // Broadcast receipt (§15.5, FR-111): the per-member fan-out aggregate. Partial
      // WIP refusals are per-member, never a failure of the whole broadcast.
      if ("kind" in result && result.kind === "broadcast") {
        return ok({ id: message.id, queued: true, fanout: result.fanout, ...closed });
      }
      return ok({ id: message.id, queued: true, ...closed });
    }

    case "list_commands": {
      const to = args.to;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      // Neighbor-scope (§10.2/§10.11), like get_status: a command can only run
      // along an edge, so a non-neighbor reveals nothing.
      if (!deps.topology.hasEdge(caller, to)) return fail("UNKNOWN_PEER", `not a neighbor: ${to}`);
      // A group/tag has no console (§15.5) — commands act on a single agent's session.
      if (typeOf(to) !== "agent")
        return fail("UNKNOWN_PEER", `"${to}" is a ${typeOf(to)} — it has no console`);
      if (deps.commandGrants === undefined || deps.listCommands === undefined) {
        return ok({ to, commands: [] }); // nothing granted / port unwired
      }
      const allowed = deps.commandGrants.allowedFor(caller, to);
      const catalog = deps.listCommands(to);
      const commands = allowed === "all" ? [...catalog] : catalog.filter((s) => allowed.has(s));
      return ok({ to, commands });
    }

    case "send_command": {
      const { to, slash } = args;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      if (typeof slash !== "string" || slash.length === 0)
        return fail("INVALID_ARGS", "slash must be a non-empty string");
      // A command needs BOTH a topology edge (§10.2) and an ACL grant (FR-94).
      if (!deps.topology.hasEdge(caller, to)) return fail("UNKNOWN_PEER", `not a neighbor: ${to}`);
      if (typeOf(to) !== "agent")
        return fail("UNKNOWN_PEER", `"${to}" is a ${typeOf(to)} — it has no console`);
      if (
        deps.commandGrants === undefined ||
        deps.runCommand === undefined ||
        !deps.commandGrants.permits(caller, to, slash)
      ) {
        return fail("COMMAND_DENIED", `not permitted to run "/${slash}" on "${to}"`);
      }
      try {
        // The recipient's catalog/idle-guard/control-lane still apply (FR-66): an
        // unknown command or a busy/down recipient throws → COMMAND_FAILED.
        const output = await deps.runCommand(to, slash);
        return ok({ to, slash, output });
      } catch (error) {
        return fail("COMMAND_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    case "list_controls": {
      const to = args.to;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      // Neighbor-scope (§10.2/§10.11), like list_commands: an action can only run
      // along an edge, so a non-neighbor reveals nothing.
      if (!deps.topology.hasEdge(caller, to)) return fail("UNKNOWN_PEER", `not a neighbor: ${to}`);
      // A group/tag has no session (§15.5) — controls act on a single agent's session.
      if (typeOf(to) !== "agent")
        return fail("UNKNOWN_PEER", `"${to}" is a ${typeOf(to)} — it has no session`);
      if (deps.sessionGrants === undefined || deps.listControls === undefined) {
        return ok({ to, actions: [] }); // nothing granted / port unwired
      }
      const allowed = deps.sessionGrants.allowedFor(caller, to);
      const catalog = deps.listControls(to);
      const actions = allowed === "all" ? [...catalog] : catalog.filter((a) => allowed.has(a));
      return ok({ to, actions });
    }

    case "control_session": {
      const { to, action } = args;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      if (typeof action !== "string" || !isSessionAction(action)) {
        return fail("INVALID_ARGS", "action must be one of start|stop|shutdown|restart|reload");
      }
      // An action needs BOTH a topology edge (§10.2) and an ACL grant (FR-96).
      if (!deps.topology.hasEdge(caller, to)) return fail("UNKNOWN_PEER", `not a neighbor: ${to}`);
      if (typeOf(to) !== "agent")
        return fail("UNKNOWN_PEER", `"${to}" is a ${typeOf(to)} — it has no session`);
      if (
        deps.sessionGrants === undefined ||
        deps.controlSession === undefined ||
        !deps.sessionGrants.permits(caller, to, action)
      ) {
        return fail("CONTROL_DENIED", `not permitted to "${action}" "${to}"`);
      }
      try {
        // The recipient's applicable catalog / control-lane still apply (FR-7/FR-64):
        // a missing provision block or a busy/unknown recipient throws → CONTROL_FAILED.
        const status = await deps.controlSession(to, action);
        return ok({ to, action, status });
      } catch (error) {
        return fail("CONTROL_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    case "list_reactions": {
      // The catalog is server-wide and tiny; no gate beyond having a session — a
      // caller must know the legal keys before `react` can refuse an illegal one.
      if (deps.reactions === undefined) {
        return fail("REACTIONS_DISABLED", "no reaction catalog is configured on this server");
      }
      return ok(deps.reactions.catalog());
    }

    case "react": {
      const { peer, messageId, key, remove } = args;
      if (typeof peer !== "string") return fail("INVALID_ARGS", "peer must be a string");
      if (typeof messageId !== "string" || messageId.length === 0) {
        return fail("INVALID_ARGS", "messageId must be a non-empty string");
      }
      if (typeof key !== "string" || key.length === 0) {
        return fail("INVALID_ARGS", "key must be a non-empty string");
      }
      if (remove !== undefined && typeof remove !== "boolean") {
        return fail("INVALID_ARGS", "remove must be a boolean");
      }
      // The gate is the EDGE and nothing else (§19.7, FR-167) — same stance as
      // get_screen (FR-147): a reaction is a mark in a conversation the caller is
      // already allowed to have, not a new power over someone else's session.
      if (!deps.topology.hasEdge(caller, peer)) {
        return fail("UNKNOWN_PEER", `not a neighbor: ${peer}`);
      }
      if (deps.reactions === undefined) {
        return fail("REACTIONS_DISABLED", "no reaction catalog is configured on this server");
      }
      // Only a pair with panel history can carry a reaction (§19.10): an agent keeps
      // no chat log of its own, a group/tag is one-directional, a federated peer is
      // across the boundary (§10.24). Say which, rather than "unknown message".
      if (isFqn(peer)) {
        return fail("NOT_REACTABLE", `"${peer}" is a federated peer — reactions stay local`);
      }
      const kind = typeOf(peer);
      if (kind === "group" || kind === "tag") {
        return fail("NOT_REACTABLE", `"${peer}" is a ${kind} — one-directional, it has no chat`);
      }
      // An agent peer falls through to the hub as well — since FR-181 it lands on
      // the transport-journal carrier (§19.13) instead of NOT_REACTABLE. One place
      // decides "is there a record to mark", and it is the place that owns the logs.
      const outcome = await deps.reactions.react({
        owner: peer, // the human's history dir holds the pair (§19.4)
        peer: caller, // …under the caller's name: the pair is (peer, caller)
        actor: caller,
        messageId,
        key,
        ...(remove === true ? { remove: true } : {}),
      });
      if (!outcome.ok) return fail(outcome.code, outcome.message);
      return ok({ peer, messageId, key, reactions: outcome.reactions });
    }

    default:
      return fail("UNKNOWN_TOOL", tool);
  }
}

/** Build a per-session MCP Server exposing the agent-plane tools bound to `caller` (§8.6). */
export function createAgentServer(caller: string, deps: AgentPlaneDeps): Server {
  const server = new Server({ name: "muxeon", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AGENT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    dispatch(req.params.name, req.params.arguments ?? {}, caller, deps),
  );
  return server;
}
