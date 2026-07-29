// @teamai/lifecycle — agent lifecycle operations (§4, FR-7/FR-8/FR-9): attach to a
// running session, provision a new one (argv, no shell — §8.7), kill / restart, and
// send slash commands. Each operation acts on an AgentTarget through a SessionControl
// port and transitions the agent's status cell (§5.1). Consumed by the operator-plane
// (T31) and the CLI (T33). — T19–T20.
export * from "./context";
export * from "./attach";
export * from "./reconcile";
export * from "./provision";
export * from "./kill";
export * from "./teardown";
export * from "./restart";
export * from "./revive";
export * from "./slash";
export * from "./command";
export * from "./internal";
