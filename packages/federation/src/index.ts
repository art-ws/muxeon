// @muxeon/federation — server federation (§18): the link wire protocol (§18.7),
// the importer's client and remote-actor registry (§18.4), the exporter's
// listener and status publisher (FR-149), composed by the manager. Routing and
// authorization stay in @muxeon/orchestrator's router (§10.26) — this package
// moves frames and knowledge, never grants.
export * from "./protocol";
export * from "./registry";
export * from "./client";
export * from "./listener";
export * from "./manager";
