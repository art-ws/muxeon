// Alarms in the panel (§22.6, FR-206): the LOUD part — a modal over everything,
// the tab-title ticker, the sound and the OS notification — and the QUIET part —
// the banner in the agent's chat. Everything derived from the level K comes from
// alarm-look.ts; the browser policies (autoplay, one voice, notification
// permission) live in alarm-audio.ts.
//
// Loud vs quiet (§22.2): an alarm is loud while `raised`. The first interaction of
// ANY person silences it for everyone (§22.11-Q1); an alarm with options then
// stays in the chat as a banner until it is answered or dismissed (§22.11-Q2). A
// person in DND gets the quiet part only (§22.11-Q3).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  audioUnlocked,
  claimVoice,
  hasVoice,
  installAudioUnlock,
  onAudioUnlock,
  playAlarmSound,
  showAlarmNotification,
} from "./alarm-audio";
import { alarmLook, formatLevel, loudestFirst, shouldSound, titleFrame } from "./alarm-look";
import { alarmStyle, useAlarms } from "./alarms-context";
import type { AlarmActionResult } from "./api";
import { useT } from "./i18n-context";
import { Markdown } from "./markdown";
import { TimeStamp } from "./timestamp";
import type { AlarmView } from "./types";

type Translate = (text: string) => string;

/** One line of plain text out of markdown-ish alarm text — the title and the OS body. */
const plainLine = (text: string): string =>
  text
    .replace(/[`*_>#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The level in words and numbers: "critical · 85%" — never the color alone (§22.6.1). */
export function levelLabel(level: number, t: Translate): string {
  const look = alarmLook(level);
  return `${look.glyph} ${t(look.band)} · ${formatLevel(level)}`;
}

/** Why a click did not land (§22.4) — an answer to show, never a failure to swallow. */
function refusalText(result: Extract<AlarmActionResult, { ok: false }>, t: Translate): string {
  switch (result.code) {
    case "ALARM_SUPERSEDED":
      return t("The agent replaced this alarm — see the new one");
    case "ALARM_RESOLVED":
      return result.alarm?.resolvedBy !== undefined
        ? `${t("Already handled by")} ${result.alarm.resolvedBy}`
        : t("Already handled");
    default:
      return `${t("Not delivered")}: ${result.code}`;
  }
}

/**
 * The loud part (§22.6.2…§22.6.5). Mounted once by the panel, on every route: the
 * modal must come up over a settings page or an open console just the same.
 */
export function AlarmCenter(props: {
  /** Do-not-disturb of the viewer (FR-134): the loud part is withheld (§22.11-Q3). */
  dnd: boolean;
  /** "Play alarm sounds" (§22.7) and its setter — the modal's 🔇 flips the same pref. */
  sound: boolean;
  onSound: (on: boolean) => void;
  /** "Desktop notifications for alarms" (§22.7). */
  notify: boolean;
  /** The agent's display label (FR-156). */
  labelOf: (agent: string) => string;
  /** Go to the agent's chat — where every interaction leads (§22.2). */
  onOpenChat: (agent: string) => void;
}): React.JSX.Element | null {
  const t = useT();
  const { enabled, alarms, act } = useAlarms();
  const loud = useMemo(
    () => (props.dnd || !enabled ? [] : loudestFirst(alarms.values())),
    [alarms, props.dnd, enabled],
  );
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const head = loud.find((alarm) => alarm.id === focusId) ?? loud[0];
  const others = loud.filter((alarm) => alarm !== head);

  // The latest props for callbacks that must not re-arm effects when they change
  // (toggling the sound must not replay the alarm).
  const live = useRef({ ...props, head, t });
  live.current = { ...props, head, t };

  // One voice per browser, and the autoplay unlock on the first gesture (§22.6.4).
  const [unlocked, setUnlocked] = useState(audioUnlocked);
  useEffect(() => {
    claimVoice();
    const disarm = installAudioUnlock();
    const unsubscribe = onAudioUnlock(() => {
      setUnlocked(true);
      // the cry that arrived while the tab was mute is heard now (§22.6.4)
      const current = live.current;
      if (current.head !== undefined && current.sound && hasVoice()) {
        playAlarmSound(alarmLook(current.head.level).sound);
      }
    });
    return () => {
      disarm();
      unsubscribe();
    };
  }, []);

  // Sound and OS notification on each NEW cry, paced by shouldSound (§22.6.4/§22.6.5).
  const previous = useRef(new Map<string, AlarmView>());
  const lastSoundAt = useRef<number | undefined>(undefined);
  const notes = useRef(new Map<string, Notification>());
  useEffect(() => {
    const current = live.current;
    const now = Date.now();
    let sounded = false;
    const close = (agent: string): void => {
      notes.current.get(agent)?.close();
      notes.current.delete(agent);
    };
    for (const [agent, alarm] of alarms) {
      const before = previous.current.get(agent);
      if (before?.id === alarm.id && before.state === alarm.state) continue;
      if (alarm.state !== "raised" || current.dnd || !enabled) {
        close(agent);
        continue;
      }
      const look = alarmLook(alarm.level);
      const ring = shouldSound(before, alarm, lastSoundAt.current, now);
      if (!hasVoice()) continue; // another tab speaks for this browser
      if (ring && current.sound && !sounded && playAlarmSound(look.sound)) {
        lastSoundAt.current = now;
        sounded = true;
      }
      if (current.notify) {
        const note = showAlarmNotification({
          agent,
          title: `${current.labelOf(agent)} — ${levelLabel(alarm.level, current.t)}`,
          body: plainLine(alarm.text).slice(0, 200),
          renotify: ring,
          requireInteraction: look.requireInteraction,
          silent: !current.sound || !ring,
          onClick: () => {
            void act(agent, alarm.id, "seen").then(() => live.current.onOpenChat(agent));
          },
        });
        if (note !== undefined) notes.current.set(agent, note);
      }
    }
    for (const agent of previous.current.keys()) if (!alarms.has(agent)) close(agent);
    previous.current = new Map(alarms);
  }, [alarms, enabled, act]);

  // Repeat the loudest cry until somebody reacts — from K ≥ 0.5 only (§22.6.4).
  const headId = head?.id;
  const headLevel = head?.level;
  useEffect(() => {
    if (headId === undefined || headLevel === undefined) return;
    const look = alarmLook(headLevel);
    if (look.repeatMs === null) return;
    const timer = setInterval(() => {
      if (live.current.sound && hasVoice() && playAlarmSound(look.sound)) {
        lastSoundAt.current = Date.now();
      }
    }, look.repeatMs);
    return () => clearInterval(timer);
  }, [headId, headLevel]);

  // The tab-title ticker (§22.6.3): the one sign a background tab can give.
  const headLine =
    head === undefined
      ? undefined
      : `${alarmLook(head.level).glyph} ${props.labelOf(head.agent)}: ${plainLine(head.text)}`;
  useEffect(() => {
    if (headLine === undefined || headLevel === undefined) return;
    const original = document.title;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    let tick = 0;
    document.title = titleFrame(original, headLine, tick, { reduced });
    const timer = setInterval(() => {
      tick += 1;
      document.title = titleFrame(original, headLine, tick, { reduced });
    }, alarmLook(headLevel).titleTickMs);
    return () => {
      clearInterval(timer);
      document.title = original;
    };
  }, [headLine, headLevel]);

  if (head === undefined) return null;
  return (
    <AlarmModal
      alarm={head}
      others={others}
      label={props.labelOf(head.agent)}
      labelOf={props.labelOf}
      sound={props.sound}
      onSound={props.onSound}
      soundBlocked={props.sound && !unlocked}
      onFocus={setFocusId}
      onDone={(agent) => {
        setFocusId(undefined);
        props.onOpenChat(agent);
      }}
    />
  );
}

function AlarmModal(props: {
  alarm: AlarmView;
  others: readonly AlarmView[];
  label: string;
  labelOf: (agent: string) => string;
  sound: boolean;
  onSound: (on: boolean) => void;
  soundBlocked: boolean;
  onFocus: (id: string) => void;
  onDone: (agent: string) => void;
}): React.JSX.Element {
  const t = useT();
  const { act } = useAlarms();
  const { alarm } = props;
  const look = alarmLook(alarm.level);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new alarm starts with a clean note
  useEffect(() => setNote(undefined), [alarm.id]);

  // Native <dialog> as a modal — the top layer, a focus trap and Escape for free,
  // like the panel's other dialogs.
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const run = async (action: "seen" | "answer", option?: number): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await act(alarm.agent, alarm.id, action, option);
    setBusy(false);
    if (result.ok) props.onDone(alarm.agent);
    else setNote(refusalText(result, t));
  };

  return (
    <dialog
      ref={dialogRef}
      className="alarm-dialog alarm-themed"
      style={alarmStyle(look.hue, look.pulseMs)}
      role="alertdialog"
      aria-labelledby="alarm-title"
      aria-describedby="alarm-text"
      // Escape means "I am here" — every way out of this window leads to the chat
      // (§22.6.2); a click on the backdrop closes nothing.
      onCancel={(event) => {
        event.preventDefault();
        void run("seen");
      }}
      onKeyDown={(event) => {
        const index = Number(event.key) - 1;
        const options = alarm.options ?? [];
        if (Number.isInteger(index) && index >= 0 && index < options.length) {
          event.preventDefault();
          void run("answer", index);
        }
      }}
    >
      <div className="alarm-card" key={alarm.id}>
        <header className="alarm-head">
          <h2 id="alarm-title" className="alarm-title">
            {props.label}
          </h2>
          <span className="alarm-level">{levelLabel(alarm.level, t)}</span>
          <button
            type="button"
            className="alarm-mute"
            aria-pressed={!props.sound}
            title={props.sound ? t("Mute alarm sounds") : t("Unmute alarm sounds")}
            onClick={() => props.onSound(!props.sound)}
          >
            {props.sound ? "🔊" : "🔇"}
          </button>
        </header>
        <div className="alarm-meta">
          {t("raised")} <TimeStamp ts={alarm.raisedAt} />
        </div>
        <div id="alarm-text" className="alarm-text">
          <Markdown text={alarm.text} />
        </div>
        {props.soundBlocked && (
          <p className="alarm-hint">
            {t("Sound is blocked by the browser — click anywhere to enable")}
          </p>
        )}
        {note !== undefined && <p className="alarm-note">{note}</p>}
        <div className="alarm-actions">
          {(alarm.options ?? []).map((option, index) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: options are unique by contract, the index is their identity
              key={index}
              type="button"
              className="alarm-option"
              disabled={busy}
              onClick={() => void run("answer", index)}
            >
              <kbd>{index + 1}</kbd> {option}
            </button>
          ))}
          <button
            type="button"
            className="alarm-open"
            disabled={busy}
            // biome-ignore lint/a11y/noAutofocus: the alert dialog must take the focus it interrupts with
            autoFocus
            onClick={() => void run("seen")}
          >
            {t("Open chat")}
          </button>
        </div>
        {props.others.length > 0 && (
          <div className="alarm-others">
            <span>{`+${props.others.length} ${t("more")}:`}</span>
            {props.others.map((other) => (
              <button
                key={other.id}
                type="button"
                className="alarm-other alarm-themed"
                style={alarmStyle(alarmLook(other.level).hue)}
                onClick={() => props.onFocus(other.id)}
              >
                {`${props.labelOf(other.agent)} ${formatLevel(other.level)}`}
              </button>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

/**
 * The quiet part in the agent's chat (§22.6.6): the active alarm as a strip under
 * the header — the text, the options and, once seen, "Dismiss". This is where an
 * "Open chat" lands with the buttons still at hand, and the only alarm surface a
 * person in DND gets.
 */
export function AlarmBanner(props: { agent: string }): React.JSX.Element | null {
  const t = useT();
  const { enabled, alarms, act } = useAlarms();
  const alarm = enabled ? alarms.get(props.agent) : undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new alarm starts with a clean note
  useEffect(() => setNote(undefined), [alarm?.id]);
  if (alarm === undefined) return null;
  const look = alarmLook(alarm.level);
  const options = alarm.options ?? [];
  const run = async (action: "seen" | "answer" | "dismiss", option?: number): Promise<void> => {
    setBusy(true);
    const result = await act(alarm.agent, alarm.id, action, option);
    setBusy(false);
    setNote(result.ok ? undefined : refusalText(result, t));
  };
  return (
    <section
      className={`alarm-banner alarm-themed${alarm.state === "raised" ? " loud" : ""}`}
      style={alarmStyle(look.hue, look.pulseMs)}
      aria-label={t("Alarm")}
    >
      <div className="alarm-banner-head">
        <strong>{levelLabel(alarm.level, t)}</strong>
        <TimeStamp ts={alarm.raisedAt} />
        {alarm.state === "seen" && alarm.resolvedBy !== undefined && (
          <span className="alarm-seen-by">{`${t("seen by")} ${alarm.resolvedBy}`}</span>
        )}
      </div>
      <div className="alarm-banner-text">
        <Markdown text={alarm.text} />
      </div>
      {note !== undefined && <p className="alarm-note">{note}</p>}
      <div className="alarm-actions">
        {options.map((option, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: options are unique by contract, the index is their identity
            key={index}
            type="button"
            className="alarm-option"
            disabled={busy}
            onClick={() => void run("answer", index)}
          >
            {option}
          </button>
        ))}
        {options.length === 0 && (
          <button
            type="button"
            className="alarm-open"
            disabled={busy}
            onClick={() => void run("seen")}
          >
            {t("Got it")}
          </button>
        )}
        {options.length > 0 && alarm.state === "seen" && (
          <button
            type="button"
            className="alarm-dismiss"
            disabled={busy}
            title={t("Close without answering — the agent is told")}
            onClick={() => void run("dismiss")}
          >
            {t("Dismiss")}
          </button>
        )}
      </div>
    </section>
  );
}
