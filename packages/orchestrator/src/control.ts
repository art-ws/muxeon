// Control lane (§8.5): operator-plane operations that must not race the dispatcher
// (queue mutations — no TOCTOU with dequeue; provision/restart — no status races
// mid-turn) are SUBMITTED here and executed by the session's own loop between
// turns. The dispatcher stays the single owner of pending/cur (§10.8): admin code
// never touches the queue from an HTTP handler, it only enqueues a closure.

interface QueuedOp {
  readonly run: () => Promise<void>;
}

export class ControlLane {
  readonly #ops: QueuedOp[] = [];

  /** Queue an operation; resolves with its result once the owning loop runs it. */
  submit<T>(op: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#ops.push({
        run: async () => {
          try {
            resolve(await op());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  get size(): number {
    return this.#ops.length;
  }

  /** Run every queued op in submission order (called by the owning loop only). */
  async drain(): Promise<number> {
    let ran = 0;
    for (;;) {
      const op = this.#ops.shift();
      if (op === undefined) break;
      await op.run();
      ran += 1;
    }
    return ran;
  }
}
