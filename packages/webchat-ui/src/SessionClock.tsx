// The chat-header session clock (§5.5, FR-197): "up 3d · quiet 2h" beside the
// status and the token meter. The status says WHAT the agent is; these two spans
// say FOR HOW LONG — an agent idle since yesterday and one that answered a minute
// ago look identical without them, and a `busy` peer whose quiet span keeps
// growing is a turn that has stopped moving.
//
// Polls GET /api/agents/:name/clock on the meter's cadence and renders nothing
// when the peer has no session (a person) or the port is unwired. The maths lives
// in session-clock.ts; this file is fetch + markup.

import { useEffect, useState } from "react";
import { fetchPeerClock } from "./api";
import { useT } from "./i18n-context";
import { clockLabel, clockTitle } from "./session-clock";
import type { PeerClock } from "./types";

/** Same cadence as the token meter: the spans move by the minute, 15s is ample. */
const REFRESH_MS = 15_000;

export function SessionClock({ peer }: { peer: string }): React.JSX.Element | null {
  const t = useT();
  const [clock, setClock] = useState<PeerClock | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState(0);

  useEffect(() => {
    let alive = true;
    setClock(undefined); // drop the previous peer's spans so they can't flash
    const load = (): void => {
      void fetchPeerClock(peer)
        .then((next) => {
          if (!alive) return;
          setClock(next);
          setFetchedAt(Date.now());
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [peer]);

  if (clock === undefined) return null;
  // A throttled background tab can hold a sample far longer than the cadence —
  // age it forward rather than render a span that is quietly behind the wall clock.
  const label = clockLabel(clock, fetchedAt === 0 ? 0 : Date.now() - fetchedAt);
  return (
    <ClockChip
      {...(label.up !== undefined ? { up: `${t("up")} ${label.up}` } : {})}
      quiet={`${t("quiet")} ${label.quiet}`}
      title={clockTitle(label, t)}
    />
  );
}

/**
 * The markup, separated from the fetching so it can be rendered in a test without
 * a network or an effect: a down agent must show the quiet span ALONE, with no
 * dangling separator, and that is a JSX branch — exactly the kind that reached a
 * live stand unnoticed once already (chat-header.test.tsx).
 */
export function ClockChip(props: {
  readonly up?: string;
  readonly quiet: string;
  readonly title: string;
}): React.JSX.Element {
  return (
    <span className="session-clock" title={props.title}>
      {props.up !== undefined && (
        <>
          {props.up}
          <span className="session-clock-sep"> · </span>
        </>
      )}
      {props.quiet}
    </span>
  );
}
