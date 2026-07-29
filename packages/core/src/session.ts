// Agent and Session domain identities (§2, §5.3, §7.1). `core` performs no I/O.

// Agent — an external executor participating in the topology. `tmux` is the
// stable session name that keys its queue and lets it survive restarts (§2,
// §5.3, §10.3); `type` selects an Adapter (§7.1).
export interface Agent {
  readonly name: string;
  readonly type: string;
  readonly tmux: string;
  /** Optional working directory (attach-only / cwd-routines, §6.2, §7.1). */
  readonly cwd?: string;
}

// Session — a running participant identified by its queue key (§5.3): an agent's
// tmux session name, or an operator's name (pseudo-session, §5.3).
export interface Session {
  readonly name: string;
}
