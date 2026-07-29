// The operator pseudo-session egress dispatcher (§5.3, §8.2, FR-37). The same
// orchestrator loop as the agent Dispatcher, specialized as egress: no tmux/adapter
// and no busy→idle wait — dequeue the oldest pending, push it through the INJECTED
// `deliver` port (the channel connector's egress sink, §8.4), then complete to done/
// IMMEDIATELY after a successful push (cur/ is transitory). Exactly ONE egress
// dispatcher serves a pseudo-session → constructive |cur|≤1 (§10.8).
//
// The deliver port is registered when the connector starts (wired by the server,
// keyed by operator — §7.5 guarantees at most one channel per operator); until then
// pending/ simply accumulates on disk (no loss, NFR-4). A deliver that throws leaves
// the record in cur/ for re-send (at-least-once, §10.9) — a duplicate push to a chat
// is acceptable; a crash between the push and the done/ rename is re-sent on restart
// the same way (recovery, §5.3).

import type { Signal } from "@teamai/core";
import { type DequeuedItem, type QueuePaths, complete, dequeue, readCur } from "@teamai/queue";
import { ControlLane } from "./control";

/** Egress sink: push one message to the operator's channel (§8.4). */
export type DeliverPort = (signal: Signal) => Promise<void>;

export interface EgressDispatcherOptions {
  readonly paths: QueuePaths;
  /** Logical ids already in done/ (dedup window, §10.9); maintained as pushes complete. */
  readonly doneIds: Set<string>;
  /** Poll cadence when empty/unregistered/failing in run() (NFR-10); default 100ms. */
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Operator control-op lane (§8.5), drained by this loop between pushes. */
  readonly control?: ControlLane;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class EgressDispatcher {
  readonly #paths: QueuePaths;
  readonly #doneIds: Set<string>;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #control: ControlLane;
  #deliver: DeliverPort | undefined;

  constructor(options: EgressDispatcherOptions) {
    this.#paths = options.paths;
    this.#doneIds = options.doneIds;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#control = options.control ?? new ControlLane();
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

  /**
   * Registers the connector's deliver port (server wiring, §8.2). One operator —
   * one serving channel (§7.5/OOS-8): a second registration is a wiring bug.
   */
  registerDeliver(deliver: DeliverPort): void {
    if (this.#deliver !== undefined) {
      throw new Error(`deliver port already registered for "${this.#paths.session}"`);
    }
    this.#deliver = deliver;
  }

  get hasDeliver(): boolean {
    return this.#deliver !== undefined;
  }

  /**
   * Re-sends the in-flight cur/ record: a crash between the claim and the done/
   * rename, or a deliver that threw, leaves it there (at-least-once, §10.9).
   */
  async recover(): Promise<void> {
    if (this.#deliver === undefined) return;
    const item = await readCur(this.#paths);
    if (item !== null) await this.#push(item);
  }

  /** Drain pending/ through the deliver port. Returns the count delivered. */
  async pump(): Promise<number> {
    let delivered = 0;
    while (this.#deliver !== undefined) {
      const item = await dequeue(this.#paths, { skipIds: this.#doneIds });
      if (item === null) break; // empty — or cur/ occupied by a failing push
      if (!(await this.#push(item))) break; // stays in cur/ for re-send (§10.9)
      delivered += 1;
    }
    return delivered;
  }

  /** Push one cur-resident record; done/ IMMEDIATELY on success (cur transitory, §5.3). */
  async #push(item: DequeuedItem): Promise<boolean> {
    const deliver = this.#deliver;
    if (deliver === undefined) return false;
    try {
      await deliver(item.message);
    } catch {
      return false; // cur/ keeps the record under re-send (at-least-once, §10.9)
    }
    await complete(this.#paths, item.filename, "done");
    this.#doneIds.add(item.message.id); // maintain the dedup window (§10.9)
    return true;
  }

  /**
   * Production loop: recover-then-pump until aborted, sleeping while there is
   * nothing to push (unregistered port, empty pending/, or a failing channel —
   * recover() retries the stuck cur/ record each iteration).
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.#control.drain(); // queue edits apply between pushes (§8.5)
      await this.recover();
      if ((await this.pump()) === 0) await this.#sleep(this.#pollIntervalMs);
    }
  }
}
