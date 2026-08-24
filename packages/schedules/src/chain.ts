// Deferred self-chains (§21, FR-190/FR-193) — the pure half: the shape an agent
// submits, the caps it must fit, and the clock arithmetic that turns delays into
// due times. No I/O, no scheduler, no router: `bun test` covers the rules that
// decide what a terminal will be typed into, without a coordinator running.
//
// The chain's address is the agent that submitted it — there is no `to` here and
// never will be (§10.33): a chain into someone else's terminal is not refused,
// it is unrepresentable.

import { type SessionAction, isSessionAction } from "@muxeon/core";

export type ItemKind = "message" | "command" | "control";

/** What an agent hands over — one of three forms per item (§21.2). */
export interface ChainItemInput {
  /** Wait since the previous item. Optional only together with `after` (⇒ "0s"). */
  readonly delay?: string;
  /**
   * Wait for a CONDITION instead of (or after) the clock (§21.10, FR-200):
   * `"quiet"` — until the agent is observably done — or `"quiet:45s"` to name the
   * window it must stay still for. The clock says when an item MAY fire; this says
   * when it is SAFE to, which is what keeps a command from landing in the middle
   * of a prompt the agent is still answering.
   */
  readonly after?: string;
  /** Cap on the conditional wait (`after` only); expiry FAILS the item, chain continues. */
  readonly timeout?: string;
  readonly text?: string;
  readonly command?: string;
  readonly control?: string;
}

export interface ChainInput {
  readonly id?: string;
  readonly items: readonly ChainItemInput[];
}

export type ItemState = "pending" | "fired" | "failed" | "dropped" | "cancelled";

export interface ChainItem {
  readonly index: number;
  readonly kind: ItemKind;
  /** Absolute due time (unix ms), already resolved from the cumulative delays. */
  readonly at: number;
  readonly text?: string;
  readonly command?: string;
  readonly control?: SessionAction;
  /**
   * Resolved `after: "quiet[:w]"` (§21.10, FR-200): how long the agent must be
   * observably still before this item fires. Absent ⇒ the item is purely timed.
   */
  readonly quietMs?: number;
  /** Cap on that wait, from the moment the item came due; expiry ⇒ `failed`. */
  readonly timeoutMs?: number;
  readonly state: ItemState;
  /** Why it is not `fired` — set together with `failed`/`dropped` (§21.5). */
  readonly error?: string;
}

export interface Chain {
  readonly id: string;
  /** The agent that submitted it — and the only one it can ever act on. */
  readonly agent: string;
  readonly created: number;
  readonly items: readonly ChainItem[];
}

export interface ScheduleLimits {
  readonly maxChainsPerAgent: number;
  readonly maxItems: number;
  /** Floor for a NON-ZERO delay; "0s" is always allowed (§21.9-Q5). */
  readonly minDelayMs: number;
  /** Horizon of the WHOLE chain — the sum of its delays (§21.9-Q5). */
  readonly maxDelayMs: number;
  /** Bytes of item text. */
  readonly maxText: number;
  /** How long a command/control item waits for `idle` before failing (§21.5). */
  readonly idleWaitMs: number;
  /** Default stillness window for `after: "quiet"` when the item names none (§21.10). */
  readonly quietWindowMs: number;
  /** Default cap on a conditional wait when the item names no `timeout` (§21.10). */
  readonly quietTimeoutMs: number;
  /** Tolerated lateness after the coordinator was down (§21.5). */
  readonly catchUpGraceMs: number;
}

export const DEFAULT_LIMITS: ScheduleLimits = {
  maxChainsPerAgent: 8,
  maxItems: 16,
  minDelayMs: 5_000,
  maxDelayMs: 86_400_000,
  maxText: 32_768,
  idleWaitMs: 60_000,
  quietWindowMs: 45_000,
  quietTimeoutMs: 1_800_000,
  catchUpGraceMs: 600_000,
};

export type ScheduleErrorCode =
  | "INVALID_ARGS"
  | "SCHEDULE_LIMIT"
  | "UNKNOWN_SCHEDULE"
  | "SCHEDULES_DISABLED";

/** A refusal that names itself — never a silent success (§8.6 error contract). */
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}

// The duration grammar of the config (§7.1, `retain.age`) — same tokens, one
// difference: zero is legal here, because "right after the previous item" is a
// thing an agent wants to say and a schedule can honour (§21.9-Q5).
const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `"45s"` → 45000. Throws INVALID_ARGS rather than defaulting to zero. */
export function parseDelay(text: unknown): number {
  if (typeof text !== "string") {
    throw new ScheduleError(
      "INVALID_ARGS",
      `delay must be a string like "30s", got ${typeof text}`,
    );
  }
  const match = DURATION.exec(text.trim());
  if (match === null) {
    throw new ScheduleError("INVALID_ARGS", `invalid delay "${text}" (expected <n>ms|s|m|h|d)`);
  }
  const [, amount = "0", unit = "ms"] = match;
  return Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
}

// The condition grammar (§21.10, FR-200). One condition exists — "the agent is
// observably still" — with an optional window: `quiet` or `quiet:45s`. A closed
// grammar rather than a free expression: an agent must not be able to describe a
// wait the coordinator cannot honour.
const AFTER = /^quiet(?::(\d+)(ms|s|m|h))?$/;

/** `"quiet:45s"` → 45000, `"quiet"` → the caller's default. Throws INVALID_ARGS. */
export function parseAfter(text: unknown, defaultWindowMs: number): number {
  if (typeof text !== "string") {
    throw new ScheduleError("INVALID_ARGS", `after must be a string like "quiet:45s"`);
  }
  const match = AFTER.exec(text.trim());
  if (match === null) {
    throw new ScheduleError(
      "INVALID_ARGS",
      `invalid after "${text}" (expected "quiet" or "quiet:<n>ms|s|m|h")`,
    );
  }
  const [, amount, unit] = match;
  if (amount === undefined || unit === undefined) return defaultWindowMs;
  const window = Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS];
  if (window <= 0) {
    throw new ScheduleError("INVALID_ARGS", `after "${text}": the window must be positive`);
  }
  return window;
}

// A chain id becomes a FILE NAME (§21.5), so it is validated as one — not
// sanitized. Silently rewriting an id would hand the agent back a name it cannot
// use to cancel with.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateChainId(id: string): string {
  if (!ID.test(id)) {
    throw new ScheduleError(
      "INVALID_ARGS",
      `invalid schedule id "${id}" (letters, digits, ".", "_", "-"; up to 64 chars)`,
    );
  }
  return id;
}

/** Exactly one form per item — a half-read item is refused, not half-run. */
function kindOf(item: ChainItemInput, index: number): ItemKind {
  const forms = (["text", "command", "control"] as const).filter(
    (field) => item[field] !== undefined,
  );
  if (forms.length !== 1) {
    throw new ScheduleError(
      "INVALID_ARGS",
      forms.length === 0
        ? `item ${index}: one of text/command/control is required`
        : `item ${index}: exactly one of text/command/control, got ${forms.join(" + ")}`,
    );
  }
  return forms[0] === "text" ? "message" : (forms[0] as ItemKind);
}

export interface PlanOptions {
  readonly agent: string;
  /** T0 — the moment the coordinator ACCEPTED the chain (§21.2). */
  readonly now: number;
  readonly limits: ScheduleLimits;
  /** Ids of this agent's live chains — a new one may not collide with them. */
  readonly liveIds?: readonly string[];
  /** Generates an id when the agent did not name one. */
  readonly newId: () => string;
}

/**
 * Turns a submitted chain into a planned one: validates it against the caps and
 * resolves the CUMULATIVE delays into absolute due times (§21.9-Q1) —
 * `at_1 = T0 + delay_1`, then `at_i = at_{i-1} + delay_i`. Order of execution is
 * the order of declaration, monotone by construction: there is nothing to sort,
 * and no delay can move an item ahead of the one before it.
 */
export function planChain(input: ChainInput, options: PlanOptions): Chain {
  const { agent, now, limits } = options;
  const live = options.liveIds ?? [];
  if (live.length >= limits.maxChainsPerAgent) {
    throw new ScheduleError(
      "SCHEDULE_LIMIT",
      `${agent} already has ${live.length} live chains (max ${limits.maxChainsPerAgent})`,
    );
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ScheduleError("INVALID_ARGS", "items must be a non-empty array");
  }
  if (input.items.length > limits.maxItems) {
    throw new ScheduleError(
      "SCHEDULE_LIMIT",
      `${input.items.length} items (max ${limits.maxItems})`,
    );
  }
  const id = input.id === undefined ? options.newId() : validateChainId(input.id);
  if (live.includes(id)) {
    throw new ScheduleError("INVALID_ARGS", `schedule "${id}" already exists`);
  }

  let elapsed = 0;
  const items = input.items.map((item, index): ChainItem => {
    const kind = kindOf(item, index);
    // `delay` is what the clock owes the item; with a condition it may be omitted
    // ("fire as soon as it is safe") but stays legal ("wait 5m, THEN for quiet").
    const delay = item.delay === undefined && item.after !== undefined ? 0 : parseDelay(item.delay);
    const quietMs =
      item.after === undefined ? undefined : parseAfter(item.after, limits.quietWindowMs);
    if (item.timeout !== undefined && quietMs === undefined) {
      throw new ScheduleError(
        "INVALID_ARGS",
        `item ${index}: timeout is only meaningful with "after" — a purely timed item never waits`,
      );
    }
    const timeoutMs =
      quietMs === undefined
        ? undefined
        : item.timeout === undefined
          ? limits.quietTimeoutMs
          : parseDelay(item.timeout);
    if (quietMs !== undefined && timeoutMs !== undefined && timeoutMs < quietMs) {
      throw new ScheduleError(
        "INVALID_ARGS",
        `item ${index}: timeout ${timeoutMs}ms is shorter than the quiet window ${quietMs}ms — it could never be met`,
      );
    }
    if (delay !== 0 && delay < limits.minDelayMs) {
      throw new ScheduleError(
        "INVALID_ARGS",
        `item ${index}: delay ${item.delay} is below the ${limits.minDelayMs}ms floor ("0s" excepted)`,
      );
    }
    elapsed += delay;
    if (elapsed > limits.maxDelayMs) {
      throw new ScheduleError(
        "SCHEDULE_LIMIT",
        `item ${index}: the chain reaches ${elapsed}ms, past the ${limits.maxDelayMs}ms horizon`,
      );
    }
    const base = {
      index,
      kind,
      at: now + elapsed,
      state: "pending" as const,
      ...(quietMs !== undefined ? { quietMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    if (kind === "message") {
      const text = item.text as string;
      if (text.trim() === "") {
        throw new ScheduleError("INVALID_ARGS", `item ${index}: text is empty`);
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > limits.maxText) {
        throw new ScheduleError(
          "SCHEDULE_LIMIT",
          `item ${index}: text is ${bytes} bytes (max ${limits.maxText})`,
        );
      }
      return { ...base, text };
    }
    if (kind === "command") {
      const command = (item.command as string).trim();
      if (command === "") {
        throw new ScheduleError("INVALID_ARGS", `item ${index}: command is empty`);
      }
      // The catalog stores slashes WITHOUT the leading "/" (FR-66); accepting it
      // here would look up "/clear" and refuse a command the agent really has.
      if (command.startsWith("/")) {
        throw new ScheduleError(
          "INVALID_ARGS",
          `item ${index}: command must not carry the leading "/" (got "${command}")`,
        );
      }
      return { ...base, command };
    }
    const control = item.control as string;
    if (!isSessionAction(control)) {
      throw new ScheduleError("INVALID_ARGS", `item ${index}: unknown control action "${control}"`);
    }
    return { ...base, control };
  });

  return { id, agent, created: now, items };
}

/** Is anything still waiting to happen? A chain of only settled items is done. */
export const isLive = (chain: Chain): boolean =>
  chain.items.some((item) => item.state === "pending");
