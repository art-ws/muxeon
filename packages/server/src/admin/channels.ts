// Operator-plane: channels list/status (§8.5). Read-only: which operator is bound
// to which connector type, and whether its egress deliver port is registered
// (i.e. the connector is up and the operator's pseudo-session is being served).

import type { ChannelRuntime } from "../wire-channels";

export interface ChannelSummary {
  readonly operator: string;
  readonly type: string;
  /** "connected" once the deliver port is registered; "pending" while it is not. */
  readonly status: "connected" | "pending";
}

export interface ChannelsAdmin {
  list(): ChannelSummary[];
}

export function createChannelsAdmin(channels: ReadonlyMap<string, ChannelRuntime>): ChannelsAdmin {
  return {
    list: () =>
      [...channels.values()].map((channel) => ({
        operator: channel.operator,
        type: channel.type,
        status: channel.egress.hasDeliver ? "connected" : "pending",
      })),
  };
}
