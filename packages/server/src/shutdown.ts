// @muxeon/server — shutdown path: graceful stop under a hard watchdog (FR-136).
// Live finding (Q05): a deploy's SIGINT could hang forever inside stop() — the
// operator had to `kill -KILL` the pid and recreate the tmux session. The
// graceful path stays primary; the watchdog guarantees an upper bound so a
// stuck stop phase can never wedge a deploy again. Exit codes follow the shell
// convention (128 + signal number); a clean stop exits 0.

export const SHUTDOWN_WATCHDOG_MS = 15_000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

const SIGNAL_EXIT_CODES: Record<ShutdownSignal, number> = { SIGINT: 130, SIGTERM: 143 };

export interface ShutdownOptions {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly warn: (message: string) => void;
  readonly watchdogMs?: number;
}

/**
 * Build the process-signal handler: first signal starts the graceful stop and
 * arms the watchdog; a repeated signal while stopping forces exit immediately
 * (double Ctrl-C). Clean stop → exit 0; watchdog fire, stop() rejection or a
 * repeat signal → exit 128+signo, never a hang.
 */
export function createShutdownHandler(options: ShutdownOptions): (signal: ShutdownSignal) => void {
  const watchdogMs = options.watchdogMs ?? SHUTDOWN_WATCHDOG_MS;
  let engaged = false;
  return (signal) => {
    if (engaged) {
      options.warn("second signal during shutdown — forcing exit now");
      options.exit(SIGNAL_EXIT_CODES[signal]);
      return;
    }
    engaged = true;
    const watchdog = setTimeout(() => {
      options.warn(`shutdown watchdog fired after ${watchdogMs}ms — forcing exit`);
      options.exit(SIGNAL_EXIT_CODES[signal]);
    }, watchdogMs);
    void options.stop().then(
      () => {
        clearTimeout(watchdog);
        options.exit(0);
      },
      (error: unknown) => {
        clearTimeout(watchdog);
        options.warn(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        options.exit(SIGNAL_EXIT_CODES[signal]);
      },
    );
  };
}
