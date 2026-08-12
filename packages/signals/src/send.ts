// On-demand signal send (§3.3, FR-19). The single primitive every proactive producer
// (routines §6, operator-plane signals.send §8.5) uses to deliver a signal: build the
// envelope, then route it THROUGH the router (topology edge check §10.2 → enqueue) —
// never past it (§8.2). signals owns no queue; it only constructs and hands off.

import type { Signal } from "@muxeon/core";
import type { RouteResult } from "@muxeon/orchestrator";
import { type BuildOptions, type SignalInput, buildSignal } from "./envelope";

/** The slice of the router signals needs — the single delivery point (§8.2). */
export interface SignalRouter {
  route(message: Signal): Promise<RouteResult>;
}

/** Build a signal and route it (edge check → enqueue). Returns the router's verdict. */
export function sendSignal(
  router: SignalRouter,
  input: SignalInput,
  options?: BuildOptions,
): Promise<RouteResult> {
  return router.route(buildSignal(input, options));
}
