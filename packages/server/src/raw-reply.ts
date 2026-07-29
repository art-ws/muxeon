// Raw-mode reply delivery (FR-88, §14.2). A raw turn's payload was injected into
// the terminal verbatim (no exchange, no `send`) — so its REPLY is the console
// itself: at turn end the dispatcher captures the pane as-is by the configured
// rule (§14.2) and routes that text BACK to the operator through the router (the
// reply edge is legal, §10.2). The captured text rides an ordinary
// `kind:"message"` with `origin:"raw"` so the panel renders it as-is (§14.3).
//
// Best-effort, like the file-borne reply (exchange-reply.ts): it runs inside the
// dispatcher's afterTurn, after complete() — a capture/route error there must not
// poison the loop, the turn is already done. The id is deterministic
// (`<id>:raw`) so a redelivered raw turn's duplicate collapses in the dedup
// window (§10.9).

import type { Signal } from "@teamai/core";

export interface RawReplyDeps {
  /** The agent's topology name — the reply's `from` (§10.2). */
  readonly agent: string;
  /** Capture the console as-is for this finished turn (lifecycle captureConsole). */
  readonly capture: () => Promise<string>;
  readonly route: (message: Signal) => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * Capture and route the raw-mode reply for one finished raw turn (FR-88).
 * Returns true when a reply was routed (always, on a successful capture — even
 * an empty pane is the honest "as-is" answer the operator asked for).
 */
export async function routeRawReply(message: Signal, deps: RawReplyDeps): Promise<boolean> {
  const output = await deps.capture();
  await deps.route({
    id: `${message.id}:raw`,
    from: deps.agent,
    to: message.from,
    kind: "message",
    ts: (deps.now ?? Date.now)(),
    replyTo: message.id,
    payload: output,
    origin: "raw",
  });
  return true;
}
