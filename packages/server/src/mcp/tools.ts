// The agent-plane tool set (§8.1, §8.6) — least-privilege: whoami, list_peers,
// send, get_status, get_history (T126, FR-87), plus two ACL-gated bridges into
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
} from "@teamai/core";
import { SESSION_ACTIONS, isSessionAction } from "@teamai/core";
import type { Router } from "@teamai/orchestrator";

export interface AgentPlaneDeps {
  readonly topology: Topology;
  readonly router: Router;
  /** A peer's status: an agent's AgentStatus, "idle" for an operator, undefined if unknown. */
  peerStatus(name: string): AgentStatus | undefined;
  /**
   * A peer's kind (§15.5, FR-111): "agent" (operators included — an operator is an
   * agent in the plane, §2), "group", or "tag". Groups/tags are input-only broadcast
   * targets — no status, no console/session. Absent ⇒ every peer is an "agent"
   * (backward-compatible; no groups/tags configured).
   */
  peerType?(name: string): "agent" | "group" | "tag";
  /**
   * The caller's message history with one peer (T126, FR-87): the last `limit`
   * records of the pair, both directions, chronological — the transport log
   * (§8.2) read-only. Absent ⇒ get_history answers UNAVAILABLE (tests, mcp
   * off-paths) — the tool never invents an empty history.
   */
  pairHistory?(caller: string, peer: string, limit: number): Promise<readonly Signal[]>;
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
  /** Clock for message ts; default Date.now. Injectable for tests. */
  readonly now?: () => number;
  /** Idempotency-id generator when send omits one (§5.3/§10.9); default randomUUID. */
  readonly newId?: () => string;
}

/** The closed tool set (§8.6); AGENT_TOOLS keys off this and the §10.10 guard asserts it. */
export const AGENT_TOOL_NAMES = [
  "whoami",
  "list_peers",
  "send",
  "get_status",
  "get_history",
  "list_commands",
  "send_command",
  "list_controls",
  "control_session",
] as const;

/** get_history depth bounds (FR-87) — mirrors the §12.4 history paging caps. */
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

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
      "A `to` naming a group/tag broadcasts one-directionally to its members.",
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
        id: { type: "string", description: "idempotency key; the server generates one if omitted" },
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
      "JSON records) — recover the dialogue after a context clear or restart. " +
      "Restricted to the caller's neighbors.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "neighbor name (agent or operator)" },
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
  const typeOf = (name: string): "agent" | "group" | "tag" => deps.peerType?.(name) ?? "agent";
  switch (tool) {
    case "whoami":
      return ok({ name: caller });

    case "list_peers": {
      // Each neighbor carries its type (§15.5); groups/tags are input-only — no status.
      const peers = deps.topology.neighbors(caller).map((name) => {
        const type = typeOf(name);
        return type === "agent"
          ? { name, type, status: deps.peerStatus(name) ?? "down" }
          : { name, type };
      });
      return ok({ peers });
    }

    case "get_status": {
      const name = args.name;
      if (typeof name !== "string") return fail("INVALID_ARGS", "name must be a string");
      // Neighbor-scope (§8.7/§10.11): a node outside the caller's neighborhood is not
      // revealed — same visibility as list_peers. Self is not a neighbor.
      if (!deps.topology.hasEdge(caller, name))
        return fail("UNKNOWN_PEER", `not a neighbor: ${name}`);
      // A group/tag has no status (§15.5) — report it plainly, not a fake "down".
      if (typeOf(name) !== "agent")
        return fail("NOT_STATUSABLE", `"${name}" is a ${typeOf(name)} — it has no status`);
      return ok({ status: deps.peerStatus(name) ?? "down" });
    }

    case "get_history": {
      const { peer, limit } = args;
      if (typeof peer !== "string") return fail("INVALID_ARGS", "peer must be a string");
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
      const records = await deps.pairHistory(caller, peer, depth);
      return ok({ peer, records });
    }

    case "send": {
      const { to, payload, replyTo, id, kind } = args;
      if (typeof to !== "string") return fail("INVALID_ARGS", "to must be a string");
      if (payload === undefined) return fail("INVALID_ARGS", "payload is required");
      // forward-compat kinds (§5.3/FR-25b): the closed set grows by requirement (R3)
      if (kind !== undefined && kind !== "message" && kind !== "reaction") {
        return fail("INVALID_ARGS", `unsupported kind "${String(kind)}"`);
      }
      const message: Signal = {
        id: typeof id === "string" && id.length > 0 ? id : (deps.newId ?? randomUUID)(),
        from: caller, // identity is the session's, not anything the caller passes (§8.6)
        to,
        kind: kind === "reaction" ? "reaction" : "message",
        ts: (deps.now ?? Date.now)(),
        payload,
        ...(typeof replyTo === "string" ? { replyTo } : {}),
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
        return fail(result.code, `delivery to "${to}" not permitted`);
      }
      // Broadcast receipt (§15.5, FR-111): the per-member fan-out aggregate. Partial
      // WIP refusals are per-member, never a failure of the whole broadcast.
      if ("kind" in result && result.kind === "broadcast") {
        return ok({ id: message.id, queued: true, fanout: result.fanout });
      }
      return ok({ id: message.id, queued: true });
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

    default:
      return fail("UNKNOWN_TOOL", tool);
  }
}

/** Build a per-session MCP Server exposing the agent-plane tools bound to `caller` (§8.6). */
export function createAgentServer(caller: string, deps: AgentPlaneDeps): Server {
  const server = new Server({ name: "teamai", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AGENT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    dispatch(req.params.name, req.params.arguments ?? {}, caller, deps),
  );
  return server;
}
