// AgentStatus — the session state-machine surface (§5.1). `down` = no tmux
// session; `idle`/`busy` come from the adapter's detect (§5.2). `core` knows only
// this neutral status and never the detection mechanism.
export type AgentStatus = "idle" | "busy" | "down";
