// TmuxSessionDriver — the real SessionDriver (§8.2): inject via tmux send-keys and
// detect busy→idle per the adapter's strategy (§5.2), implemented exactly as the
// T13 spike FINDINGS prescribe. All transport (capture/send) and the status reader
// are injectable so the detection logic is unit-testable without a live agent.

import { readFile } from "node:fs/promises";
import type { Adapter, NativeStatus } from "@muxeon/adapters";
import type { Session } from "@muxeon/core";
import { capturePane, sendKeys, sendLiteral } from "@muxeon/tmux";
import type { SessionDriver } from "./dispatcher";

export interface TmuxDriverOptions {
  readonly session: Session;
  readonly adapter: Adapter;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly capture?: (session: string) => Promise<string>;
  readonly sendLiteral?: (session: string, text: string) => Promise<void>;
  readonly sendKeys?: (session: string, ...keys: string[]) => Promise<void>;
  readonly readStatus?: (path: string) => Promise<NativeStatus | null>;
  /** Clock for the re-press cadence (T359) — injectable like sleep. */
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Submit confirmation (T78, FR-58): CLI agents detect a paste by input timing —
// an Enter landing in the same stdin burst as the literal text becomes a newline
// INSIDE the input box instead of a submit. The message then sits unsubmitted,
// no busy front ever appears (§5.2) and the turn hangs until a human presses
// Enter (live stand: inter-agent traffic froze). So: let the paste settle, press
// Enter as its own burst, then verify the agent actually left the ready prompt;
// while the pane still looks ready, press Enter again (bounded).
//
// T140 cold start: provision flips the agent to idle the instant its tmux session
// exists (provision.ts), but a freshly-launched claude needs several seconds —
// welcome screen + MCP connect — before it accepts a submit. The FIRST message's
// text lands in the input box yet the Enter is swallowed until the CLI is
// input-ready, so the re-press window must outlast a cold boot (~15s), not just a
// paste race (the old ~1.3s window expired first → the operator pressed Enter by
// hand). Safe to keep wide: a surplus Enter on a submitted/empty box is a no-op,
// the loop returns the instant the pane goes busy (a warm submit still costs one
// tick), and a selection/permission prompt now reads as BUSY (CLAUDE_READY, T139)
// — the loop returns instead of answering a dialog.
// Settle before the first Enter, measured on a live codex pane (T359, 2026-10-08):
// with 250ms the paste is still "hot" — Enter is swallowed, the composer keeps
// the text as `[Pasted Content <n> chars]` and the footer offers `tab to queue
// message` (the operator's screenshot, verbatim); with 1s the very same text is
// accepted and queued for the next tool call. The old 200ms sat on the wrong side
// of that window for every large message, which is what filled the composers.
const SUBMIT_SETTLE_MS = 1000;
const SUBMIT_CONFIRM_MS = 350;
const SUBMIT_CONFIRM_WINDOW_MS = 15_000;
export const SUBMIT_RETRIES = Math.ceil(SUBMIT_CONFIRM_WINDOW_MS / SUBMIT_CONFIRM_MS);

// Composer ownership (T359, FR-58 live finding 2026-10-08). The confirmation
// above still gives up after its window — and on the live stand it gave up on a
// message that then sat in the agent's composer for an hour (operator report:
// «залипает отправка… нужно заходить в консоль и прожимать Enter»). The pane it
// gave up on had read `busy` the whole time — but that busy was the agent's OWN
// turn, and codex ignores Enter while a turn runs, so "busy ⇒ submitted" was
// simply false there; the message was never submitted at all. The fix is to stop
// inferring and start looking: an adapter that declares its composer (see
// Detect.composer) lets the driver see the message still parked in it. Then
//   1. a turn does NOT complete while the composer still shows our paste, and
//   2. the driver keeps pressing Enter on the ready pane — the exact manual
//      action the operator was performing — until the CLI takes the message.
// Both are bounded by nothing but the turn's own lifetime (OOS-7: a turn that
// never ends is not this detector's to time out), and both are no-ops for
// adapters that declare no composer.
/** Lines from the pane bottom that may hold the composer (T359). */
const COMPOSER_REGION_LINES = 8;
/** Min gap between automatic re-presses while our message sits in the composer. */
const SUBMIT_REPRESS_MS = 1000;
// How long a DECLARED adapter's "composer not identifiable" state may hold a
// finished turn before the plain front wins (T361). The gate of T359 demands
// positive evidence that the composer is empty, because a repaint frame can hide
// the composer while a paste is still parked in it; those frames resolve within
// about a second (measured live, T359: ~1.1s false-ready windows), while a pane
// of a runtime the adapter does not know — opencode/pi behind `auto`, which
// declare no empty marker at all (their composer renders blank, with no
// placeholder to probe) — would otherwise never complete a single turn. Five
// seconds is a 5x margin over the measured hazard and costs only that much
// latency on the runtimes that cannot be probed.
const COMPOSER_UNKNOWN_GRACE_MS = 5_000;

async function defaultReadStatus(path: string): Promise<NativeStatus | null> {
  try {
    return JSON.parse(await readFile(path, { encoding: "utf8" })) as NativeStatus;
  } catch {
    return null; // file missing or mid-write — treat as no status yet
  }
}

export class TmuxSessionDriver implements SessionDriver {
  readonly #session: Session;
  readonly #adapter: Adapter;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #capture: (session: string) => Promise<string>;
  readonly #sendLiteral: (session: string, text: string) => Promise<void>;
  readonly #sendKeys: (session: string, ...keys: string[]) => Promise<void>;
  readonly #readStatus: (path: string) => Promise<NativeStatus | null>;
  readonly #now: () => number;
  /**
   * Consecutive "front reached + composer cleared" polls a turn needs (T359).
   * A declared composer gets 2: the second poll is what rules out a torn frame
   * completing a turn that is only now starting (T78's race). Adapters that
   * declare nothing keep the single-poll front — their behavior is deliberately
   * untouched, since no UI evidence about them exists.
   */
  readonly #clearedPolls: number;
  /**
   * Set by inject() when the agent answered INSIDE the submit-confirmation window
   * — a turn shorter than SUBMIT_CONFIRM_MS is already over before awaitTurn gets
   * to look, and the output front (busy→ready) it waits for has been and gone.
   * Consumed once by awaitTurn, which would otherwise wait for a front that will
   * never come again and strand the message in cur/ (§10.1).
   */
  #turnObservedDuringInject = false;

  constructor(options: TmuxDriverOptions) {
    this.#session = options.session;
    this.#adapter = options.adapter;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#capture = options.capture ?? capturePane;
    this.#sendLiteral = options.sendLiteral ?? sendLiteral;
    this.#sendKeys = options.sendKeys ?? sendKeys;
    this.#readStatus = options.readStatus ?? defaultReadStatus;
    this.#now = options.now ?? Date.now;
    this.#clearedPolls = options.adapter.detect.composer === undefined ? 1 : 2;
  }

  /**
   * Composer state (§5.2, FR-58, T359): does the adapter's declared composer
   * hold an unsent paste ("pending"), sit empty ("empty") — or is it not
   * declared / not visible in this pane ("unknown")? Matched against the pane's
   * bottom region only: the composer lives there, and the transcript above it
   * carries `›`-prefixed echoes that must never be read as composer content.
   */
  #composerState(pane: string): "pending" | "empty" | "unknown" {
    const composer = this.#adapter.detect.composer;
    if (composer === undefined) return "unknown";
    const region = pane.split("\n").slice(-COMPOSER_REGION_LINES).join("\n");
    if (composer.pending?.test(region) === true) return "pending";
    if (composer.empty.test(region)) return "empty";
    return "unknown";
  }

  /**
   * Positive proof that this turn's input is out of the composer (T359): the
   * adapter's empty-composer marker is VISIBLY there. Deliberately not "not
   * pending" — a pane mid-repaint can hide the composer for a frame while the
   * paste is still sitting in it (the live false-ready windows above), and that
   * frame is exactly what made the old detector complete a message nobody had
   * received. An adapter that declares no composer keeps the old reading.
   */
  #composerCleared(pane: string): boolean {
    if (this.#adapter.detect.composer === undefined) return true;
    return this.#composerState(pane) === "empty";
  }

  async inject(text: string): Promise<void> {
    this.#turnObservedDuringInject = false; // never let a previous turn's flag leak
    await this.#sendLiteral(this.#session.name, text);
    await this.#sleep(SUBMIT_SETTLE_MS);
    // Baseline: the pane with the text typed but NOT yet submitted. "Ready" alone
    // cannot prove the Enter was swallowed — an agent whose turn is SHORTER than
    // SUBMIT_CONFIRM_MS has already answered and returned to its prompt by the
    // time we look. Re-pressing there submits an EMPTY turn, and since no busy
    // front ever follows the real one, awaitTurn waits forever and the message
    // stays in cur/ (§10.1). A swallowed Enter leaves the pane frozen, so it is
    // the pane CHANGING — not the prompt vanishing — that proves submission.
    // Best-effort: if the capture fails we fall back to the prompt-only check.
    let baseline: string | undefined;
    try {
      baseline = (await this.#capture(this.#session.name)).trimEnd();
    } catch {
      baseline = undefined;
    }
    await this.#sendKeys(this.#session.name, "Enter");
    // Best-effort confirmation (T78): a capture/send hiccup must not fail an
    // already-typed injection — from here the §5.2 detectors own the turn, and
    // a dead session is the down-probe's business (§5.1), not inject's.
    let unknownSince: number | undefined; // T361: composer unidentifiable since
    try {
      for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt += 1) {
        await this.#sleep(SUBMIT_CONFIRM_MS);
        const pane = (await this.#capture(this.#session.name)).trimEnd();
        if (!this.#adapter.detect.readyPrompt.test(pane)) return; // busy — submitted
        // The composer still holds OUR paste: the Enter was refused (codex
        // ignores it while a turn runs), so the pane looking "ready" here says
        // nothing about submission — press again and keep looking (T359). The
        // waiter below owns this state past this window; this branch just keeps
        // the warm path warm.
        const composer = this.#composerState(pane);
        if (composer === "pending") {
          unknownSince = undefined;
          await this.#sendKeys(this.#session.name, "Enter");
          continue;
        }
        // Consumed proof (T359): the composer is VISIBLY empty, or the adapter
        // declares none at all. A declared adapter whose composer shows no
        // marker — a runtime it cannot probe (T361) — counts as consumed only
        // after the same grace the waiter uses, so a torn repaint frame in
        // between cannot fake a completed turn.
        let consumed = this.#composerCleared(pane);
        if (!consumed && composer === "unknown") {
          const at = this.#now();
          unknownSince ??= at;
          consumed = at - unknownSince >= COMPOSER_UNKNOWN_GRACE_MS;
        }
        if (baseline !== undefined && pane !== baseline && consumed) {
          // Output appeared AND the prompt is back: the whole turn happened inside
          // this window. Tell awaitTurn, or it waits for a front already spent.
          this.#turnObservedDuringInject = true;
          return;
        }
        await this.#sendKeys(this.#session.name, "Enter");
      }
    } catch {
      // swallow — detection decides the turn either way
    }
  }

  async awaitTurn(turnToken: string, signal?: AbortSignal): Promise<void> {
    if (this.#turnObservedDuringInject) {
      this.#turnObservedDuringInject = false; // one turn, one consumption
      return;
    }
    const detect = this.#adapter.detect;
    const statusPath = detect.statusFile?.(this.#session);
    if (statusPath === undefined || signal?.aborted === true) {
      await this.#awaitOutput(detect.readyPrompt, signal);
      return;
    }
    // Both paths in parallel (§5.2, FR-11): output front is the reliable path
    // (zero agent cooperation), the native edge an opportunistic accelerator —
    // the first to fire wins, and the loser's polling is stopped via the linked
    // controller so it does not outlive the turn. An absent/stale status file
    // therefore never blocks the turn (the old native-only wait hung forever).
    const race = new AbortController();
    const onAbort = (): void => race.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([
        this.#awaitNative(statusPath, turnToken, race.signal),
        this.#awaitOutput(detect.readyPrompt, race.signal),
      ]);
    } finally {
      race.abort();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Native edge: accept idle ONLY at the current turn token; a stale idle level from
  // a previous turn is ignored (§5.2). Stops polling if the turn is aborted (the
  // down-probe won the race, T17).
  async #awaitNative(statusPath: string, token: string, signal?: AbortSignal): Promise<void> {
    while (signal?.aborted !== true) {
      const status = await this.#readStatus(statusPath);
      if (status?.status === "idle" && status.turn === token) return;
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  // Output front: wait for the ready prompt to disappear (idle→busy) before counting
  // its reappearance as busy→idle — avoids a false idle before the input is swallowed
  // (§5.2). Stops polling on abort (T17).
  //
  // A capture that THROWS is a vanished session, not a turn signal: killing/losing the
  // session mid-turn makes `tmux capture-pane` fail (`can't find session`), and that is
  // the down-probe's business (§5.1/FR-16b), NOT this detector's — it must not reject.
  // A propagated reject here would win/lose the processOne race and escape the
  // fire-and-forget dispatcher loop as an unhandled rejection (Bun then kills the whole
  // server — T145 live finding: killing a busy agent crashed the stand). So swallow it
  // and keep polling; the down-probe wins the race and aborts this loop via the signal.
  async #awaitOutput(readyPrompt: RegExp, signal?: AbortSignal): Promise<void> {
    const declared = this.#adapter.detect.composer !== undefined;
    let sawBusy = false;
    let cleared = 0; // consecutive polls of "front reached + composer visibly empty"
    let unknownSince: number | undefined; // first poll of an unidentifiable composer
    let lastSubmit = Number.NEGATIVE_INFINITY; // last automatic re-press (T359) — none yet
    while (signal?.aborted !== true) {
      let pane: string;
      try {
        pane = (await this.#capture(this.#session.name)).trimEnd();
      } catch {
        await this.#sleep(this.#pollIntervalMs); // session gone → let the down-probe own it
        continue;
      }
      const ready = readyPrompt.test(pane);
      const composer = ready ? this.#composerState(pane) : "unknown";
      if (!ready) {
        sawBusy = true;
        cleared = 0;
        unknownSince = undefined;
      } else if (sawBusy) {
        if (!declared) {
          // Adapter declares no composer: the pre-T359 front decides, as before.
          return;
        }
        if (composer === "empty") {
          // Front reached AND the composer is visibly empty: our input went
          // through, the turn is over — confirmed on a second consecutive poll so
          // a torn frame (the composer drawn a beat before the agent goes busy,
          // T78's old race) cannot complete a turn that is just starting. While
          // the composer still shows the paste, the "ready" is the agent's own
          // turn ending with our message never submitted — completing there is
          // exactly the false done of T359 (§10.1).
          cleared += 1;
          unknownSince = undefined;
          if (cleared >= this.#clearedPolls) return;
        } else if (composer === "pending") {
          cleared = 0;
          unknownSince = undefined;
        } else {
          // Declared, but no composer marker on screen: either a repaint frame
          // (resolves on the next poll) or a runtime this adapter does not know
          // (T361). The grace keeps the first from completing a turn whose paste
          // is parked while never hanging the second.
          cleared = 0;
          const at = this.#now();
          if (unknownSince === undefined) {
            unknownSince = at;
          } else if (at - unknownSince >= COMPOSER_UNKNOWN_GRACE_MS) {
            return;
          }
        }
      } else {
        cleared = 0;
      }
      // Our message is parked in the composer and the agent is at the prompt:
      // the same Enter a human presses by hand, on a cadence, until the CLI
      // takes it (T359). Never while busy (codex ignores Enter mid-turn) and
      // never into a selection dialog — a dialog reads busy (T139).
      const now = this.#now();
      if (ready && composer === "pending" && now - lastSubmit >= SUBMIT_REPRESS_MS) {
        lastSubmit = now;
        try {
          await this.#sendKeys(this.#session.name, "Enter");
        } catch {
          // a dead session is the down-probe's to report — keep polling
        }
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }
}
