// Operator-plane: channels list/status (§8.5). Read-only: which operator is bound
// to which connector type, and whether its egress deliver port is registered
// (i.e. the connector is up and the operator's pseudo-session is being served).

import type { ChannelRuntime } from "../wire-channels";

export interface ChannelSummary {
  /** Channel instance name (§17.2, FR-125) — `name`, or the type by default. */
  readonly name: string;
  /** The bound legacy operator (§12.1); absent in users mode (§17.2). */
  readonly operator?: string;
  readonly type: string;
  /**
   * "connected" once the deliver port is registered; "pending" while it is not.
   * A users-mode channel owns no queue (§17.5) — it is "connected" as soon as its
   * connector is up, which it is by the time this list can be asked for.
   */
  readonly status: "connected" | "pending";
}

export interface ChannelsAdmin {
  list(): ChannelSummary[];
}

export function createChannelsAdmin(channels: ReadonlyMap<string, ChannelRuntime>): ChannelsAdmin {
  return {
    list: () =>
      [...channels.values()].map((channel) => ({
        name: channel.name,
        ...(channel.operator !== undefined ? { operator: channel.operator } : {}),
        type: channel.type,
        status: (channel.egress?.hasDeliver ?? true) ? "connected" : "pending",
      })),
  };
}
