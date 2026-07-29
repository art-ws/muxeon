// The per-session dispatcher (§8.2) — the execution loop. When idle it claims the
// oldest pending into cur/ (constructive |cur|≤1 because there is exactly ONE
// dispatcher per session, §10.8), renders + injects it, waits for busy→idle (§5.2),
// then completes to done/. A render/inject error completes to failed/ (FR-35b); an
// in-flight cur/ file after a crash is re-sent in place (recovery, §10.9).
//
// Detection is abstracted behind SessionDriver so the loop is independent of HOW a
// turn is injected and detected (TmuxSessionDriver is the real one). Per-session
// detection state lives in the driver, not here.

import type { Signal } from "@teamai/core";
import {
  type DequeuedItem,
  type QueuePaths,
  complete,
  dequeue,
  listPendingOrdered,
  readCur,
} from "@teamai/queue";
import { ControlLane } from "./control";
import type { AgentState } from "./status";

export interface SessionDriver {
  /** Inject the rendered text and submit it; throws on injection failure → failed/. */
  inject(text: string): Promise<void>;
  /**
   * Wait for the agent to finish the turn (busy→idle, §5.2). `turnToken` drives
   * native edge detection (the injected message id); output detection ignores it. A
   * rejection means the turn was aborted (busy→down, T17) → the message is re-sent,
   * not failed.
   */
  awaitTurn(turnToken: string, signal?: AbortSignal): Promise<void>;
}

/** The result of a single turn (§5.2/§5.1). "aborted" — shutdown during the
 * turn (T66): cur/ stays in place and re-sends on restart, like "down". */
export type TurnOutcome = "done" | "failed" | "down" | "aborted";

/** Render context for the file-exchange instruction (§13.2); absent without exchange. */
export interface TurnRenderContext {
  readonly messageFile?: string;
}

/**
 * The dispatcher-facing slice of the agent's file exchange (§13, FR-52) —
 * optional: the operator egress pseudo-session has none. materialize runs at
 * claim time BEFORE render/inject (the instruction needs the file path);
 * awaitDone is the file-detect racer (FR-53) — raced ONLY when materialization
 * succeeded, or an absent file would be an instant false "done"; cleanup
 * removes the message dir after the turn resolves (done or failed).
 *
 * materialize returning `null` means THIS turn has no inbox projection — the
 * render falls back to its no-context form and file-detect is skipped. Raw mode
 * (FR-88, §14) takes that path: a verbatim terminal turn has no message.json.
 */
export interface TurnExchangePort {
  materialize(message: Signal): Promise<{ messageFile: string } | null>;
  awaitDone?(message: Signal, signal: AbortSignal): Promise<void>;
  cleanup(message: Signal): Promise<void>;
}

export interface DispatcherOptions {
  readonly paths: QueuePaths;
  readonly driver: SessionDriver;
  readonly render: (signal: Signal, ctx?: TurnRenderContext) => string;
  readonly state: AgentState;
  /** Logical ids already in done/ (dedup window, §10.9); maintained as turns complete. */
  readonly doneIds: Set<string>;
  /**
   * Resolves when the session is confirmed gone DURING a turn (busy→down, §5.1,
   * FR-16b) — wire to waitForSessionDown. Default: never (no down detection, e.g. the
   * operator egress pseudo-session or tests without a probe).
   */
  readonly awaitDown?: (signal: AbortSignal) => Promise<void>;
  /** Poll cadence when idle/empty in run() (NFR-10); default 100ms. */
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Operator control-op lane (§8.5), drained by this loop between turns. */
  readonly control?: ControlLane;
  /**
   * Turn-lifecycle hooks (FR-45, T58): beforeInject opens the reply-nudge window,
   * afterTurn (done turns only, after complete) checks it and may enqueue the
   * nudge. Generic seams — the nudge logic itself lives in ReplyNudger.
   */
  readonly beforeInject?: (message: Signal) => void;
  readonly afterTurn?: (message: Signal) => Promise<void>;
  /**
   * Lazy auto-revive (FR-51, §5.1): called by run() when the session is down WITH
   * work queued (cur/ or pending/ non-empty). The hook owns the attempt budget
   * ("once per down-episode, with a stop" — Reviver in @teamai/lifecycle), so the
   * loop may call it every poll tick; a spent budget makes it a cheap no-op.
   * Default: none (operator-only recovery, e.g. attach-only agents or egress).
   */
  readonly reviveDown?: () => Promise<void>;
  /** The agent's file exchange (§13, FR-52); absent → plain payload injection. */
  readonly exchange?: TurnExchangePort;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const never: (signal: AbortSignal) => Promise<void> = () => new Promise<void>(() => undefined);

export class Dispatcher {
  readonly #paths: QueuePaths;
  readonly #driver: SessionDriver;
  readonly #render: (signal: Signal, ctx?: TurnRenderContext) => string;
  readonly #state: AgentState;
  readonly #doneIds: Set<string>;
  readonly #awaitDown: (signal: AbortSignal) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #control: ControlLane;
  readonly #beforeInject: ((message: Signal) => void) | undefined;
  readonly #afterTurn: ((message: Signal) => Promise<void>) | undefined;
  readonly #reviveDown: (() => Promise<void>) | undefined;
  readonly #exchange: TurnExchangePort | undefined;

  constructor(options: DispatcherOptions) {
    this.#paths = options.paths;
    this.#driver = options.driver;
    this.#render = options.render;
    this.#state = options.state;
    this.#doneIds = options.doneIds;
    this.#awaitDown = options.awaitDown ?? never;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#control = options.control ?? new ControlLane();
    this.#beforeInject = options.beforeInject;
    this.#afterTurn = options.afterTurn;
    this.#reviveDown = options.reviveDown;
    this.#exchange = options.exchange;
  }

  /** The control-op lane this loop drains (§8.5); admin submits, never executes. */
  get control(): ControlLane {
    return this.#control;
  }

  /** The live dedup window (done/ logical ids, §10.9) — read-only for admin (§8.5). */
  get doneIds(): ReadonlySet<string> {
    return this.#doneIds;
  }

  /** Shrink the dedup window after done/ pruning (§5.4/§10.9 — retention only). */
  forgetDone(ids: Iterable<string>): void {
    for (const id of ids) this.#doneIds.delete(id);
  }

  /** Re-send an in-flight cur/ file after a crash (at-least-once, §10.9). */
  async recover(signal?: AbortSignal): Promise<void> {
    if (this.#state.status !== "idle") return;
    const item = await readCur(this.#paths);
    if (item !== null) await this.processOne(item, signal);
  }

  /** Drain pending while idle, one message at a time. Returns the count processed. */
  async pump(signal?: AbortSignal): Promise<number> {
    let processed = 0;
    while (this.#state.status === "idle") {
      await this.#control.drain(); // control ops apply between turns (§8.5)
      const item = await dequeue(this.#paths, { skipIds: this.#doneIds });
      if (item === null) break; // empty, or cur busy
      if ((await this.processOne(item, signal)) === "aborted") break; // shutdown (T66)
      processed += 1;
    }
    return processed;
  }

  /**
   * Process a cur-resident item: render → inject → race(awaitTurn, awaitDown,
   * shutdown) → complete. If the session is lost mid-turn (busy→down, §5.1/FR-16b),
   * cur/ is left in place (re-sent on restart, §10.9) and the status goes down — no
   * failed/, no hang. A shutdown abort mid-turn (T66) resolves the same way — cur/
   * stays for the restart re-send — so stop() never waits out a stuck turn (live
   * finding: a never-idle detection hung SIGINT shutdown forever).
   */
  async processOne(item: DequeuedItem, signal?: AbortSignal): Promise<TurnOutcome> {
    if (signal?.aborted === true) return "aborted"; // shutdown — don't start a turn
    this.#state.to("busy");
    // Materialize the inbox projection BEFORE render (FR-52, §13.2) — the
    // instruction needs the message.json path. A materialization failure must
    // not fail the message: the render degrades to the no-exchange instruction.
    let renderCtx: TurnRenderContext | undefined;
    if (this.#exchange !== undefined) {
      try {
        // null ⇒ no inbox projection this turn (raw mode, FR-88) — the render
        // degrades to its no-context form and file-detect is skipped below.
        const materialized = await this.#exchange.materialize(item.message);
        renderCtx = materialized === null ? undefined : { messageFile: materialized.messageFile };
      } catch {
        renderCtx = undefined;
      }
    }
    this.#beforeInject?.(item.message); // open the reply-nudge window (FR-45)
    try {
      await this.#driver.inject(this.#render(item.message, renderCtx));
    } catch {
      // render or injection failed on a live session → failed/ (FR-35b).
      await complete(this.#paths, item.filename, "failed");
      await this.#cleanupExchange(item.message); // the projection of a dead turn
      this.#state.to("idle");
      return "failed";
    }
    const turnAbort = new AbortController();
    const downAbort = new AbortController();
    const fileAbort = new AbortController();
    // The shutdown racer's listener is removed after the race — the signal is the
    // server-lifetime abort, a leaked once-listener per turn would accumulate.
    let onAbort: (() => void) | undefined;
    const racers = [
      this.#driver.awaitTurn(item.message.id, turnAbort.signal).then((): TurnOutcome => "done"),
      this.#awaitDown(downAbort.signal).then((): TurnOutcome => "down"),
    ];
    // File-detect (FR-53, §13.3): the agent deleting message.json declares the
    // turn done. Guarded on a SUCCESSFUL materialization (renderCtx) — without
    // the file on disk the racer would fire an instant false "done".
    if (this.#exchange?.awaitDone !== undefined && renderCtx?.messageFile !== undefined) {
      racers.push(
        this.#exchange.awaitDone(item.message, fileAbort.signal).then((): TurnOutcome => "done"),
      );
    }
    if (signal !== undefined) {
      racers.push(
        new Promise<TurnOutcome>((resolve) => {
          onAbort = (): void => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    let outcome: TurnOutcome;
    try {
      outcome = await Promise.race(racers);
    } catch {
      // Defense in depth (T145): the racers are abort-driven and must never reject,
      // but if one does (e.g. a vanished session slips past the driver's capture
      // guard), a propagated reject escapes this fire-and-forget loop as an unhandled
      // rejection and Bun kills the whole server. Treat it as the session being lost:
      // leave cur/ in place for the restart re-send (§10.9) and drop to down.
      outcome = "down";
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
    if (outcome === "down" || outcome === "aborted") {
      turnAbort.abort(); // stop the turn detector; cur/ stays for re-send (§10.9)
      downAbort.abort();
      fileAbort.abort();
      this.#state.to(outcome === "down" ? "down" : "idle");
      return outcome;
    }
    turnAbort.abort(); // stop the losing detectors — file-detect may have won (FR-53)
    downAbort.abort();
    fileAbort.abort();
    await complete(this.#paths, item.filename, "done");
    this.#doneIds.add(item.message.id); // maintain the dedup window (§10.9)
    // Reply-nudge check (FR-45) AFTER complete: a crash here loses at most the
    // nudge, never the original's completion. Errors must not poison the loop.
    if (this.#afterTurn !== undefined) {
      try {
        await this.#afterTurn(item.message);
      } catch {
        // nudge delivery is best-effort (§8.2) — the turn itself is already done
      }
    }
    await this.#cleanupExchange(item.message); // remove the turn's inbox dir (§13.3)
    this.#state.to("idle");
    return "done";
  }

  /** Best-effort exchange cleanup — a leftover dir is the orphan sweep's job (§5.4). */
  async #cleanupExchange(message: Signal): Promise<void> {
    if (this.#exchange === undefined) return;
    try {
      await this.#exchange.cleanup(message);
    } catch {
      // orphaned dirs are swept by retention (§13.3)
    }
  }

  /**
   * Production loop: recover, then pump-and-poll until aborted. recover() runs every
   * iteration (cheap: a no-op unless idle with a cur/ file) so an operator restart —
   * which brings the session down→idle via provision (§5.1, FR-9) — re-sends the
   * in-flight cur/ it left behind (at-least-once, §10.9) and drains the pending/ that
   * piled up while down. The loop stays the single owner of pending/cur (§10.8): no
   * other code path dequeues, so restart only flips status and lets the loop catch up.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.#control.drain(); // runs even while down (e.g. a provision op, §8.5)
      if (this.#state.status === "down") await this.maybeRevive();
      await this.recover(signal);
      if ((await this.pump(signal)) === 0 && !signal.aborted) {
        await this.#sleep(this.#pollIntervalMs);
      }
    }
  }

  /**
   * Lazy auto-revive (FR-51, §5.1): a down session with queued work — an in-flight
   * cur/ awaiting re-send or anything pending — earns one budget-gated reviveDown
   * call. A revive that brings the agent up lets the SAME loop iteration recover
   * cur/ and drain pending immediately (no extra poll-tick latency).
   */
  async maybeRevive(): Promise<void> {
    if (this.#reviveDown === undefined) return;
    const hasWork =
      (await readCur(this.#paths)) !== null || (await listPendingOrdered(this.#paths)).length > 0;
    if (hasWork) await this.#reviveDown();
  }
}
