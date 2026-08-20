// Operator-plane: signals.send (§8.5, FR-19 "on demand"). The signal goes through
// the router (edge check §10.2 → enqueue) like every producer; `from` MUST be an
// existing graph node (agent or operator) — the operator-plane's "send on behalf
// of an agent" privilege is bounded by the topology's nodes (§8.7), never an
// invented name.

import { type SignalRouter, buildSignal } from "@muxeon/signals";
import { AdminError } from "./error";

export interface SignalSendInput {
  readonly from: string;
  readonly to: string;
  readonly payload: unknown;
  readonly kind?: string;
  readonly replyTo?: string;
  /** Idempotency key (§10.9); generated when absent. */
  readonly id?: string;
  /**
   * Answer opt-out (§13.7, FR-180): `false` delivers the signal as a NOTICE —
   * the recipient reads it, is told no answer is expected and is given no reply
   * path. Absent ⇒ the default of the kind.
   */
  readonly expectsReply?: boolean;
}

export interface SignalsAdmin {
  send(input: SignalSendInput): Promise<{ id: string; queued: true }>;
}

export interface SignalsAdminDeps {
  readonly router: SignalRouter;
  /** Whether a name is an existing graph node (agent or operator, §8.7). */
  readonly isNode: (name: string) => boolean;
}

export function createSignalsAdmin(deps: SignalsAdminDeps): SignalsAdmin {
  return {
    send: async (input) => {
      if (typeof input.from !== "string" || !deps.isNode(input.from)) {
        throw new AdminError(
          400,
          `"from" must be an existing agent or operator (got "${String(input.from)}")`,
          "UNKNOWN_FROM",
        );
      }
      if (typeof input.to !== "string" || input.to.length === 0) {
        throw new AdminError(400, '"to" is required', "BAD_REQUEST");
      }
      if (input.kind !== undefined && input.kind !== "message" && input.kind !== "reaction") {
        // the closed kind set (§5.3); new kinds arrive by requirement (R3, FR-25b)
        throw new AdminError(400, `unsupported signal kind "${input.kind}"`, "BAD_KIND");
      }
      if (input.expectsReply !== undefined && typeof input.expectsReply !== "boolean") {
        throw new AdminError(400, '"expectsReply" must be a boolean', "BAD_REQUEST");
      }
      const message = buildSignal({
        from: input.from,
        to: input.to,
        payload: input.payload,
        origin: "operator-plane",
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.expectsReply !== undefined ? { expectsReply: input.expectsReply } : {}),
      });
      const result = await deps.router.route(message);
      if (!result.ok) {
        if (result.code === "UNKNOWN_PEER") {
          throw new AdminError(404, `unknown peer "${input.to}"`, result.code);
        }
        if (result.code === "WIP_LIMIT") {
          // Backpressure (FR-104): Too Many Requests — the recipient's queue is full.
          throw new AdminError(
            429,
            `"${input.to}" is at its WIP limit (${result.limit}); ${result.depth} in flight`,
            result.code,
          );
        }
        if (result.code === "AGENT_PAUSED") {
          // Pause (§16.2, FR-117): a state CONFLICT, not overload — 409, so the
          // operator distinguishes "busy" (429) from "paused" and the message was
          // dropped, not queued.
          throw new AdminError(
            409,
            `"${input.to}" is paused — the message was discarded (§16.2)`,
            result.code,
          );
        }
        throw new AdminError(403, `no topology edge ${input.from} — ${input.to}`, result.code);
      }
      return { id: message.id, queued: true };
    },
  };
}
