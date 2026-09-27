// Agent alarms (§22, FR-202…FR-205): an agent's cry for a human's attention.
// Three properties shape the whole module:
//
//   1. An alarm is the agent's STATE, not a message. Each agent has ONE slot; a new
//      alarm replaces the old one whole ("the latest is the actual one"). So it has
//      no place in a queue (§10.1), no envelope in a history (§5.3), no row in the
//      journal (FR-48) — exactly like a reaction (§19.1).
//   2. There is no addressee. The audience is every human neighbour of the agent
//      (§10.2) — "attract ANY operator's attention" — resolved at the moment of
//      showing, never stored.
//   3. The only thing an alarm ever puts into a queue is ONE signal to the agent,
//      when a human resolves it (§22.5): the chosen option, or a receipt that the
//      cry was heard. Always a notice (`expectsReply:false`, §13.7 — the operator's
//      decision §22.11-Q5), with the deterministic id `<alarmId>:resolution`, so a
//      second resolution cannot exist even in a race (§10.35).
//
// Storage is the slot itself, one file per agent (§22.9):
//
//   <config_dir>/state/alarms/<agent>.json   — the LATEST alarm, in whatever state
//
// The hub is the one door for every surface — the agent-plane `alarm` tool, the
// outbox drop and the panel — so they cannot disagree about a transition.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signal } from "@muxeon/core";
import { encodePeerName } from "./history";

/** Where an alarm is in its life (§22.2). Two ACTIVE states, four terminal ones. */
export type AlarmState =
  | "raised"
  | "seen"
  | "answered"
  | "acknowledged"
  | "withdrawn"
  | "superseded";

/** The slot (§22.2) — also the wire shape of the panel surface and the WS push. */
export interface Alarm {
  readonly id: string;
  readonly agent: string;
  /** Markdown, rendered like a chat bubble (§22.6.2). */
  readonly text: string;
  /** K ∈ [0, 1] — 0 is "for your information", 1 is a cry of pain (§22.1). */
  readonly level: number;
  /** Answer options in the agent's order; absent ⇒ a cry that asks for nothing. */
  readonly options?: readonly string[];
  readonly raisedAt: number;
  readonly state: AlarmState;
  /** Who moved it into seen/answered/acknowledged. */
  readonly resolvedBy?: string;
  readonly resolvedAt?: number;
  /** The chosen option's index — `answered` only. */
  readonly answer?: number;
}

export interface AlarmLimits {
  readonly maxText: number;
  readonly maxOptions: number;
  readonly maxOptionLength: number;
}

/** A panel that shows alarms (§22.4): the connector registers itself here. */
export interface AlarmSurface {
  /** Push the agent's slot to one user's tabs; `null` ⇒ nothing active any more. */
  push(user: string, agent: string, alarm: Alarm | null): void;
  /** Does this user have at least one live tab on this surface? */
  watching(user: string): boolean;
}

export interface AlarmsHubOptions {
  /** `alarms.enabled` (§22.8) — off ⇒ every door answers ALARMS_DISABLED. */
  readonly enabled: boolean;
  readonly limits: AlarmLimits;
  /** <config_dir>/state/alarms */
  readonly dir: string;
  /** Is this a local agent — the only kind of participant that may raise one? */
  isAgent(name: string): boolean;
  /** The humans who see this agent's alarm (§22.4) — evaluated on every use. */
  audienceOf(agent: string): readonly string[];
  /** Is this user in DND (FR-134)? Such a user sees the quiet part only (§22.11-Q3). */
  isPaused?(user: string): boolean;
  /** router.route — the resolution signal's only path (§8.2). */
  route?(signal: Signal): Promise<{ readonly ok: boolean; readonly code?: string }>;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly warn?: (text: string) => void;
  /** One line per transition (§22.9, NFR-9) — the only history alarms keep. */
  readonly log?: (line: string) => void;
}

/** What the agent learns from `alarm` (§22.3). */
export interface AlarmCallResult {
  readonly id: string;
  readonly state: "raised" | "withdrawn";
  readonly audience: readonly string[];
  /** Audience members with a live tab and not in DND — who hears it LOUDLY now. */
  readonly watching: number;
  readonly replaced?: {
    readonly id: string;
    readonly state: AlarmState;
    readonly resolvedBy?: string;
  };
}

/** What became of the signal to the agent (§22.5) — never silently lost. */
export interface AlarmNotify {
  readonly delivered: boolean;
  readonly code?: string;
}

export type AlarmOutcome<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** The slot as it stands — so a refused click can show who got there first. */
      readonly alarm?: Alarm;
      readonly notify?: AlarmNotify;
    };

/** A human's action result: the slot after it and, when a signal left, its fate. */
export interface AlarmActionResult {
  readonly alarm: Alarm;
  readonly notify?: AlarmNotify;
  /** The routed signal — the panel records it in the user's history (§22.5). */
  readonly signal?: Signal;
}

const ACTIVE: ReadonlySet<AlarmState> = new Set(["raised", "seen"]);

/** Raised or seen — the alarm is still showing somewhere (§22.2). */
export const isActiveAlarm = (alarm: Alarm | undefined): boolean =>
  alarm !== undefined && ACTIVE.has(alarm.state);

const refused = (code: string, message: string, alarm?: Alarm): AlarmOutcome<never> => ({
  ok: false,
  code,
  message,
  ...(alarm !== undefined ? { alarm } : {}),
});

/**
 * The one place an alarm is raised, replaced, withdrawn or resolved (§22). Every
 * mutation is serialized, which is what makes the id check a compare-and-set:
 * two people clicking two different options produce ONE answer (§10.35).
 */
export class AlarmsHub {
  readonly #o: AlarmsHubOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #slots = new Map<string, Alarm>();
  readonly #surfaces: AlarmSurface[] = [];
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: AlarmsHubOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  get enabled(): boolean {
    return this.#o.enabled;
  }

  /** A panel connector registers its socket side here (§22.4). */
  attachSurface(surface: AlarmSurface): void {
    this.#surfaces.push(surface);
  }

  /**
   * Read the slots back after a restart — "until someone interacts" survives the
   * coordinator (§22.4). The slot of an agent that left the topology is pruned
   * (§22.9), like an orphaned chain (§21.5).
   */
  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#o.dir);
    } catch {
      return; // no alarm was ever raised
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".tmp-")) continue;
      const path = join(this.#o.dir, name);
      let alarm: Alarm;
      try {
        alarm = JSON.parse(await readFile(path, "utf8")) as Alarm;
      } catch {
        this.#o.warn?.(`alarm slot ${name} is unreadable — ignored (§22.9)`);
        continue;
      }
      if (typeof alarm?.agent !== "string" || !this.#o.isAgent(alarm.agent)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      this.#slots.set(alarm.agent, alarm);
    }
  }

  /** The slot of one agent, whatever its state — tests and diagnostics. */
  slot(agent: string): Alarm | undefined {
    return this.#slots.get(agent);
  }

  /**
   * The ACTIVE alarms this user may see (§22.4): their neighbours' only. Off ⇒
   * none — a slot survives a switched-off subsystem but is not shown (§22.8).
   */
  active(user: string): readonly Alarm[] {
    if (!this.#o.enabled) return [];
    return [...this.#slots.values()].filter(
      (alarm) => isActiveAlarm(alarm) && this.#o.audienceOf(alarm.agent).includes(user),
    );
  }

  /**
   * The agent's door — the `alarm` tool and the outbox drop (§22.3). `input` is
   * untrusted: `{text, level, options?}` raises (or replaces), `{clear: true}`
   * withdraws. The agent is the CALLER, never an argument.
   */
  call(agent: string, input: unknown): Promise<AlarmOutcome<AlarmCallResult>> {
    return this.#serialize(async () => {
      if (!this.#o.enabled) {
        return refused("ALARMS_DISABLED", "alarms are switched off on this server");
      }
      if (!this.#o.isAgent(agent)) return refused("UNKNOWN_PEER", `not an agent: ${agent}`);
      const parsed = parseAlarmInput(input, this.#o.limits);
      if (typeof parsed === "string") return refused(parsed.split(":")[0] as string, parsed);
      const audience = this.#o.audienceOf(agent);
      const previous = this.#slots.get(agent);
      if (parsed.clear) {
        if (previous === undefined || !isActiveAlarm(previous)) {
          return refused("NO_ALARM", "you have no active alarm");
        }
        const withdrawn: Alarm = { ...previous, state: "withdrawn" };
        await this.#store(withdrawn);
        this.#pushAll(withdrawn);
        return {
          ok: true,
          id: withdrawn.id,
          state: "withdrawn",
          audience,
          watching: this.#watching(audience),
        };
      }
      // Nobody to cry to is an error, not a quiet success: the agent must know
      // that no human will ever see this (§22.3).
      if (audience.length === 0) {
        return refused("NO_AUDIENCE", "no human is your neighbour — nobody can see an alarm");
      }
      const alarm: Alarm = {
        id: this.#newId(),
        agent,
        text: parsed.text,
        level: parsed.level,
        ...(parsed.options !== undefined ? { options: parsed.options } : {}),
        raisedAt: this.#now(),
        state: "raised",
      };
      await this.#store(alarm);
      this.#pushAll(alarm);
      return {
        ok: true,
        id: alarm.id,
        state: "raised",
        audience,
        watching: this.#watching(audience),
        ...(previous !== undefined
          ? {
              replaced: {
                id: previous.id,
                // an active predecessor is superseded by THIS call — the file of the
                // old alarm is gone, so the answer is stated rather than stored
                state: isActiveAlarm(previous) ? "superseded" : previous.state,
                ...(previous.resolvedBy !== undefined ? { resolvedBy: previous.resolvedBy } : {}),
              },
            }
          : {}),
      };
    });
  }

  /**
   * "I have seen it" (§22.2) — the modal's "Open chat", Esc, a click on the OS
   * notification. An alarm WITH options goes quiet (`seen`) and keeps its buttons
   * in the chat; one without options is thereby acknowledged, and the agent gets
   * the receipt. Seeing a `seen` alarm again changes nothing.
   */
  seen(user: string, agent: string, id: string): Promise<AlarmOutcome<AlarmActionResult>> {
    return this.#serialize(async () => {
      const current = this.#check(user, agent, id);
      if ("code" in current) return current;
      if (current.state === "seen") return { ok: true, alarm: current };
      if (current.options !== undefined) {
        const seen: Alarm = { ...current, state: "seen", ...this.#by(user) };
        await this.#store(seen);
        this.#pushAll(seen);
        return { ok: true, alarm: seen };
      }
      return this.#acknowledge(current, user, "heard");
    });
  }

  /**
   * Answer with one of the agent's options (§22.5). The slot moves to `answered`
   * ONLY after the router accepted the signal: a paused agent or a full queue
   * leaves the question open and the buttons live — an answer lost in silence is
   * worse than a question left unanswered.
   */
  answer(
    user: string,
    agent: string,
    id: string,
    option: unknown,
  ): Promise<AlarmOutcome<AlarmActionResult>> {
    return this.#serialize(async () => {
      const current = this.#check(user, agent, id);
      if ("code" in current) return current;
      const options = current.options ?? [];
      if (
        typeof option !== "number" ||
        !Number.isInteger(option) ||
        option < 0 ||
        option >= options.length
      ) {
        return refused("UNKNOWN_OPTION", `no option ${String(option)} on this alarm`, current);
      }
      const signal = resolutionSignal(current, user, { option }, this.#now());
      const notify = await this.#route(signal);
      if (!notify.delivered) {
        return {
          ok: false,
          code: notify.code ?? "ROUTE_FAILED",
          message: "the answer was not delivered — the alarm stays open",
          alarm: current,
          notify,
        };
      }
      const answered: Alarm = { ...current, state: "answered", answer: option, ...this.#by(user) };
      await this.#store(answered);
      this.#pushAll(answered);
      return { ok: true, alarm: answered, notify, signal };
    });
  }

  /** Close a `seen` alarm without choosing (§22.2) — the banner's "Dismiss". */
  dismiss(user: string, agent: string, id: string): Promise<AlarmOutcome<AlarmActionResult>> {
    return this.#serialize(async () => {
      const current = this.#check(user, agent, id);
      if ("code" in current) return current;
      if (current.state !== "seen" || current.options === undefined) {
        return refused(
          "ALARM_STATE",
          "only a seen alarm with options can be dismissed — open the chat first",
          current,
        );
      }
      return this.#acknowledge(current, user, "dismissed");
    });
  }

  // Terminal by a human, without an option: the loud part stops whatever becomes
  // of the receipt — the human is already here (§22.5).
  async #acknowledge(
    current: Alarm,
    user: string,
    how: "heard" | "dismissed",
  ): Promise<AlarmOutcome<AlarmActionResult>> {
    const acknowledged: Alarm = { ...current, state: "acknowledged", ...this.#by(user) };
    await this.#store(acknowledged);
    this.#pushAll(acknowledged);
    const signal = resolutionSignal(current, user, { how }, this.#now());
    const notify = await this.#route(signal);
    return { ok: true, alarm: acknowledged, notify, ...(notify.delivered ? { signal } : {}) };
  }

  /**
   * The compare-and-set gate every human action passes (§22.2): the user must be
   * in the audience (anyone else is told nothing exists — §10.22), the id must be
   * the slot's (else the agent is already crying about something else), and the
   * slot must still be active (else someone got there first).
   */
  #check(user: string, agent: string, id: string): Alarm | AlarmOutcome<never> {
    if (!this.#o.enabled) {
      return refused("ALARMS_DISABLED", "alarms are switched off on this server");
    }
    const current = this.#slots.get(agent);
    if (current === undefined || !this.#o.audienceOf(agent).includes(user)) {
      return refused("UNKNOWN_ALARM", `no alarm of ${agent} for you`);
    }
    if (current.id !== id) {
      return refused("ALARM_SUPERSEDED", `${agent} replaced this alarm`, current);
    }
    if (!isActiveAlarm(current)) {
      return refused("ALARM_RESOLVED", `this alarm is already ${current.state}`, current);
    }
    return current;
  }

  #by(user: string): { resolvedBy: string; resolvedAt: number } {
    return { resolvedBy: user, resolvedAt: this.#now() };
  }

  async #route(signal: Signal): Promise<AlarmNotify> {
    const route = this.#o.route;
    if (route === undefined) return { delivered: false, code: "UNAVAILABLE" };
    try {
      const result = await route(signal);
      return result.ok
        ? { delivered: true }
        : { delivered: false, ...(result.code !== undefined ? { code: result.code } : {}) };
    } catch {
      return { delivered: false, code: "ROUTE_FAILED" };
    }
  }

  #watching(audience: readonly string[]): number {
    return audience.filter(
      (user) =>
        this.#o.isPaused?.(user) !== true &&
        this.#surfaces.some((surface) => surface.watching(user)),
    ).length;
  }

  // The WHOLE slot goes out, not a delta (§22.4): a tab simply replaces what it
  // knows about this agent — "the latest is the actual one", with no ordering races.
  #pushAll(alarm: Alarm): void {
    const shown = isActiveAlarm(alarm) ? alarm : null;
    for (const user of this.#o.audienceOf(alarm.agent)) {
      for (const surface of this.#surfaces) surface.push(user, alarm.agent, shown);
    }
  }

  async #store(alarm: Alarm): Promise<void> {
    this.#slots.set(alarm.agent, alarm);
    this.#o.log?.(
      `alarm ${alarm.agent} ${alarm.id} ${alarm.state} K=${agentLevel(alarm.level)}${
        alarm.state !== "raised" && alarm.resolvedBy !== undefined ? ` by ${alarm.resolvedBy}` : ""
      }`,
    );
    await mkdir(this.#o.dir, { recursive: true });
    const name = encodePeerName(alarm.agent);
    const tmp = join(this.#o.dir, `.tmp-${name}.json`);
    await writeFile(tmp, `${JSON.stringify(alarm, null, 2)}\n`, "utf8");
    await rename(tmp, join(this.#o.dir, `${name}.json`)); // atomic, same dir ⇒ same FS
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }
}

/** The parsed door input: a cry, or a withdrawal. */
type ParsedAlarm =
  | { readonly clear: true }
  | {
      readonly clear: false;
      readonly text: string;
      readonly level: number;
      readonly options?: readonly string[];
    };

/**
 * Validate the agent's input (§22.3). A shape error is INVALID_ARGS; a cap is
 * ALARM_LIMIT — and never a clamp: a level cut to 1 or a text cut short would be
 * a cry the agent did not make. Returns "CODE: reason" on refusal.
 */
export function parseAlarmInput(input: unknown, limits: AlarmLimits): ParsedAlarm | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "INVALID_ARGS: the alarm must be an object";
  }
  const { text, level, options, clear, ...rest } = input as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) return `INVALID_ARGS: unknown field "${unknown[0]}"`;
  if (clear !== undefined) {
    if (clear !== true) return "INVALID_ARGS: clear must be true when given";
    if (text !== undefined || level !== undefined || options !== undefined) {
      return "INVALID_ARGS: clear takes no other fields — it withdraws, it does not raise";
    }
    return { clear: true };
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return "INVALID_ARGS: text (a non-empty string) is required";
  }
  if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
    return "INVALID_ARGS: level must be a number from 0 to 1 — there is no default";
  }
  if (Buffer.byteLength(text, "utf8") > limits.maxText) {
    return `ALARM_LIMIT: text is over ${limits.maxText} bytes`;
  }
  if (options === undefined) return { clear: false, text, level };
  if (!Array.isArray(options) || options.length === 0) {
    return "INVALID_ARGS: options must be a non-empty array of strings when given";
  }
  if (options.length > limits.maxOptions) {
    return `ALARM_LIMIT: at most ${limits.maxOptions} options`;
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (typeof option !== "string" || option.trim().length === 0 || /[\r\n]/.test(option)) {
      return "INVALID_ARGS: every option must be a non-empty one-line string";
    }
    if ([...option].length > limits.maxOptionLength) {
      return `ALARM_LIMIT: an option is over ${limits.maxOptionLength} characters`;
    }
    if (seen.has(option)) return `INVALID_ARGS: duplicate option "${option}"`;
    seen.add(option);
  }
  return { clear: false, text, level, options: options as string[] };
}

/** K as the agent reads it — its own scale, 0…1 (§22.6.1: percents are the panel's). */
const agentLevel = (level: number): string => String(Math.round(level * 100) / 100);

/**
 * The ONE signal a human resolution produces (§22.5): always a notice — the
 * operator's decision §22.11-Q5 — and self-contained, because the alarm lives in
 * no history a `replyTo` could point at, and the agent may have cleared its
 * context since it cried.
 */
export function resolutionSignal(
  alarm: Alarm,
  user: string,
  how: { readonly option: number } | { readonly how: "heard" | "dismissed" },
  ts: number,
): Signal {
  const level = agentLevel(alarm.level);
  const quote = `\nYour alarm was: «${alarm.text}»`;
  let head: string;
  let tag: string;
  if ("option" in how) {
    const options = alarm.options ?? [];
    head = `[muxeon alarm] ${user} answered your alarm ${alarm.id} (level ${level}) with option ${
      how.option + 1
    } of ${options.length}: «${options[how.option]}»`;
    tag = "answer";
  } else if (how.how === "heard") {
    head = `[muxeon alarm] ${user} acknowledged your alarm ${alarm.id} (level ${level}) — you were heard`;
    tag = "ack";
  } else {
    head = `[muxeon alarm] ${user} closed your alarm ${alarm.id} (level ${level}) without choosing an option`;
    tag = "ack";
  }
  return {
    // Deterministic (§10.9): whatever path retries it, one alarm resolves once.
    id: `${alarm.id}:resolution`,
    from: user,
    to: alarm.agent,
    kind: "message",
    ts,
    expectsReply: false,
    origin: `alarm:${alarm.id}:${tag}`,
    payload: `${head}${quote}`,
  };
}
