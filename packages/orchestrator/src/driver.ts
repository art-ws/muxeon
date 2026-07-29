// TmuxSessionDriver — the real SessionDriver (§8.2): inject via tmux send-keys and
// detect busy→idle per the adapter's strategy (§5.2), implemented exactly as the
// T13 spike FINDINGS prescribe. All transport (capture/send) and the status reader
// are injectable so the detection logic is unit-testable without a live agent.

import { readFile } from "node:fs/promises";
import type { Adapter, NativeStatus } from "@teamai/adapters";
import type { Session } from "@teamai/core";
import { capturePane, sendKeys, sendLiteral } from "@teamai/tmux";
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
const SUBMIT_SETTLE_MS = 200;
const SUBMIT_CONFIRM_MS = 350;
const SUBMIT_CONFIRM_WINDOW_MS = 15_000;
export const SUBMIT_RETRIES = Math.ceil(SUBMIT_CONFIRM_WINDOW_MS / SUBMIT_CONFIRM_MS);

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
    try {
      for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt += 1) {
        await this.#sleep(SUBMIT_CONFIRM_MS);
        const pane = (await this.#capture(this.#session.name)).trimEnd();
        if (!this.#adapter.detect.readyPrompt.test(pane)) return; // busy — submitted
        if (baseline !== undefined && pane !== baseline) {
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
    let sawBusy = false;
    while (signal?.aborted !== true) {
      let pane: string;
      try {
        pane = (await this.#capture(this.#session.name)).trimEnd();
      } catch {
        await this.#sleep(this.#pollIntervalMs); // session gone → let the down-probe own it
        continue;
      }
      const ready = readyPrompt.test(pane);
      if (!ready) sawBusy = true;
      else if (sawBusy) return;
      await this.#sleep(this.#pollIntervalMs);
    }
  }
}
