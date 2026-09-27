// The React side of alarms (§22.6): one context, so the sidebar ring, the chat
// banner and the modal read the SAME slots without every component in between
// carrying them. The default is "off" — a server with alarms switched off
// (§22.8) gets no alarm surface at all.

import { createContext, useContext } from "react";
import type { AlarmActionResult } from "./api";
import type { AlarmView } from "./types";

export interface AlarmsApi {
  /** Does this server show alarms (§22.8)? Off ⇒ nothing is drawn. */
  readonly enabled: boolean;
  /** The ACTIVE alarm of each neighbour agent (raised or seen). */
  readonly alarms: ReadonlyMap<string, AlarmView>;
  /** seen / answer / dismiss (§22.4) — the answer is folded into the slots here. */
  act(
    agent: string,
    id: string,
    action: "seen" | "answer" | "dismiss",
    option?: number,
  ): Promise<AlarmActionResult>;
}

const OFF: AlarmsApi = {
  enabled: false,
  alarms: new Map(),
  act: async () => ({ ok: false, code: "ALARMS_DISABLED", error: "alarms are off" }),
};

export const AlarmsContext = createContext<AlarmsApi>(OFF);

export const useAlarms = (): AlarmsApi => useContext(AlarmsContext);

/** The alarm hue and pulse as CSS variables — the stylesheet derives both themes from them. */
export const alarmStyle = (hue: number, pulseMs?: number): React.CSSProperties =>
  ({
    "--alarm-hue": hue,
    ...(pulseMs !== undefined ? { "--alarm-pulse": `${pulseMs}ms` } : {}),
  }) as React.CSSProperties;
