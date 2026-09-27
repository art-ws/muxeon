// Everything the panel derives from an alarm's level K (§22.6.1, FR-206) — one
// pure module, so color, pulse, sound, repeats and the tab title cannot drift
// apart, and so the scale is testable without a DOM (the filter.ts/prompt-name.ts
// discipline). Components only draw what this returns.
//
// The scale is CONTINUOUS (the operator's request): K=0 green, 0.5 yellow, 1 red,
// and everything in between. Only `band` is discrete — it names the level in words
// and a glyph, because color must never be the only carrier of meaning.

/** An alarm as far as its look is concerned. */
export interface AlarmLevelled {
  readonly id: string;
  readonly level: number;
  readonly state: string;
  readonly raisedAt: number;
}

export type AlarmBand = "notice" | "warning" | "critical";

export interface AlarmSound {
  /** Tone, Hz: 440·2^K — an octave from calm to shrill. */
  readonly freq: number;
  /** Beeps per signal: 1 + round(2K) — one "ding" up to three. */
  readonly pulses: number;
  /** Share of full volume: 0.25 + 0.5K. */
  readonly gain: number;
  /** Soft below the critical band, edgier in it. */
  readonly wave: "sine" | "triangle";
}

export interface AlarmLook {
  /** HSL hue: 120·(1−K) — 120° green, 60° yellow, 0° red. */
  readonly hue: number;
  readonly band: AlarmBand;
  readonly glyph: string;
  /** Period of the frame/backdrop pulse, ms: 2400 → 600. */
  readonly pulseMs: number;
  /** Step of the tab-title ticker, ms: 900 → 300 (background tabs clamp to ≥1 s anyway). */
  readonly titleTickMs: number;
  readonly sound: AlarmSound;
  /** Repeat the sound until someone reacts: none below 0.5, then 60 s → 10 s. */
  readonly repeatMs: number | null;
  /** Keep the OS notification on screen until clicked — from 0.5 up. */
  readonly requireInteraction: boolean;
}

const clamp01 = (k: number): number => (Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0);
const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

export function alarmBand(k: number): AlarmBand {
  const level = clamp01(k);
  if (level < 1 / 3) return "notice";
  if (level < 2 / 3) return "warning";
  return "critical";
}

const GLYPHS: Record<AlarmBand, string> = { notice: "🟢", warning: "🟡", critical: "🔴" };

export function alarmLook(k: number): AlarmLook {
  const level = clamp01(k);
  const band = alarmBand(level);
  return {
    hue: Math.round(120 * (1 - level)),
    band,
    glyph: GLYPHS[band],
    pulseMs: Math.round(lerp(2400, 600, level)),
    titleTickMs: Math.round(lerp(900, 300, level)),
    sound: {
      freq: Math.round(440 * 2 ** level),
      pulses: 1 + Math.round(2 * level),
      gain: Math.round((0.25 + 0.5 * level) * 100) / 100,
      wave: band === "critical" ? "triangle" : "sine",
    },
    repeatMs: level < 0.5 ? null : Math.round(lerp(60_000, 10_000, (level - 0.5) / 0.5)),
    requireInteraction: level >= 0.5,
  };
}

/**
 * K as a HUMAN reads it (§22.6.1, T350): "85%", never "0.85". Only the panel
 * speaks percent — the agent passes and reads back its own 0…1.
 */
export const formatLevel = (k: number): string => `${Math.round(clamp01(k) * 100)}%`;

/** Replace the sound when the level rose by at least this much (§22.6.4). */
export const SOUND_ESCALATION = 0.1;
/** …or when at least this long has passed since the last sound. */
export const SOUND_COOLDOWN_MS = 30_000;

/**
 * Pacing of REPLACEMENTS (§22.6.4): an agent may cry as often as it likes, but the
 * room does not turn into a siren for it. A replacement sounds again only when it
 * escalates, when enough time has passed, or when the previous alarm had already
 * gone quiet. Also decides whether the OS notification re-alerts (`renotify`).
 */
export function shouldSound(
  previous: AlarmLevelled | undefined,
  next: AlarmLevelled,
  lastSoundAt: number | undefined,
  now: number,
): boolean {
  if (next.state !== "raised") return false;
  if (previous === undefined || previous.state !== "raised") return true;
  if (previous.id === next.id) return false; // the same cry, nothing new to say
  if (next.level - previous.level >= SOUND_ESCALATION - 1e-9) return true;
  return lastSoundAt === undefined || now - lastSoundAt >= SOUND_COOLDOWN_MS;
}

/**
 * The raised alarms, loudest first (§22.6.2): the modal shows the head, the strip
 * under it the rest. Ties go to the newer cry.
 */
export function loudestFirst<T extends AlarmLevelled>(alarms: Iterable<T>): T[] {
  return [...alarms]
    .filter((alarm) => alarm.state === "raised")
    .sort((a, b) => b.level - a.level || b.raisedAt - a.raisedAt);
}

/** Width of the tab-title ticker window, in characters. */
export const TITLE_WIDTH = 40;

/**
 * One frame of the tab-title ticker (§22.6.3). Every tenth frame is the ordinary
 * title, so the tab stays recognisable; the rest scroll the line through a window
 * of `width` characters. `reduced` (prefers-reduced-motion) swaps without
 * scrolling — the line's head and the title alternate.
 */
export function titleFrame(
  original: string,
  line: string,
  tick: number,
  options: { readonly width?: number; readonly reduced?: boolean } = {},
): string {
  const width = options.width ?? TITLE_WIDTH;
  if (options.reduced === true) return tick % 2 === 0 ? line : original;
  if (tick % 10 === 9) return original;
  const chars = [...line];
  if (chars.length <= width) return line;
  const loop = [...chars, " ", " ", "·", " ", " "];
  const start = tick % loop.length;
  return [...loop, ...loop].slice(start, start + width).join("");
}

/**
 * The level of an alarm's trace in the chat (§22.6.6): the answer or receipt the
 * panel recorded. The record carries it in its own protocol line — "(level 0.85)"
 * — so the bubble can wear the alarm's color without a second store.
 */
export function alarmRecordLevel(record: {
  readonly origin?: string;
  readonly payload?: unknown;
}): number | undefined {
  if (record.origin?.startsWith("alarm:") !== true) return undefined;
  if (typeof record.payload !== "string") return undefined;
  const match = /\(level (\d+(?:\.\d+)?)\)/.exec(record.payload);
  if (match === null) return undefined;
  const level = Number(match[1]);
  return Number.isFinite(level) && level >= 0 && level <= 1 ? level : undefined;
}
