// @muxeon/orchestrator — router (single delivery point, topology check + id
// sanitize), per-session dispatcher, AgentStatus state-machine, busy→down probe,
// operator egress dispatcher. Owns §10.1/§10.2/§10.8. (SPEC.md §8.2)
// Populated in T14–T17, T28.
export * from "./router";
export * from "./federation";
export * from "./broadcast";
export * from "./intersect";
export * from "./command-fanout";
export * from "./status";
export * from "./dispatcher";
export * from "./nudge";
export * from "./transport-log";
// The server reaches tmux only through orchestrator helpers (§8) — re-exported
// for the console-fallback scrape (FR-47), like probeSession for the down-probe,
// and for the panel's interactive console (§12.9, FR-160).
export {
  type CaptureOptions,
  type TmuxConsoleAttachment,
  type TmuxConsoleHandlers,
  attachConsole,
  capturePane,
} from "@muxeon/tmux";
export * from "./driver";
export * from "./down-probe";
export * from "./idle-teardown";
export * from "./liveness-probe";
export * from "./session";
export * from "./egress";
export * from "./blob-store";
export * from "./control";
export * from "./queue-admin";
export * from "./retention";
export * from "./exchange";
export * from "./token-usage";
export * from "./token-sampler";
export * from "./rendezvous";
export * from "./rendezvous-state";
export * from "./rendezvous-coordinator";
export * from "./pause";
export * from "./pause-state";
export * from "./presence";
export * from "./quiescence";
