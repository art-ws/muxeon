// Message timestamps (§12.7, FR-151): the flow shows the absolute clock time,
// the tooltip adds HOW LONG AGO — a full local date-time plus a relative
// phrase ("5 minutes ago" / "5 минут назад", Intl.RelativeTimeFormat in the
// panel's language). The tooltip is computed on hover, not at render — a
// bubble can sit unre-rendered for an hour, and a stale "just now" would lie.

import { useState } from "react";
import { loadLang } from "./i18n";

/** The relative phrase for `ts` as seen from `now`, in `lang`. Pure — tested. */
export function relativeTime(ts: number, now: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const seconds = Math.round((ts - now) / 1000);
  if (Math.abs(seconds) < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  return rtf.format(days, "day");
}

/** A message time with the on-hover "full date · relative" tooltip (FR-151). */
export function TimeStamp(props: { ts: number; className?: string }): React.JSX.Element {
  const [title, setTitle] = useState<string>();
  return (
    <span
      {...(props.className !== undefined ? { className: props.className } : {})}
      {...(title !== undefined ? { title } : {})}
      onMouseEnter={() =>
        setTitle(
          `${new Date(props.ts).toLocaleString()} · ${relativeTime(props.ts, Date.now(), loadLang())}`,
        )
      }
    >
      {new Date(props.ts).toLocaleTimeString()}
    </span>
  );
}
