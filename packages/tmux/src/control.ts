// Interactive console attachment (§12.9, FR-160): tmux CONTROL MODE as a
// bidirectional bridge between an agent's pane and the panel's terminal emulator.
//
// `tmux -C attach-session` speaks a line protocol on stdout (`%output`, `%exit`,
// …) and takes tmux COMMANDS on stdin — no pty needed, which is what makes this
// possible under bun at all (there is no node-pty here, and none is wanted: R1/R3).
//
// Two deliberate properties:
//
//   * `-f ignore-size,read-only` — the attachment is INVISIBLE to the agent's
//     session: it never joins the window-size calculation (a browser attaching
//     must not reflow the CLI agent's screen, §12.9) and the client itself can
//     inject nothing. Keystrokes go through explicit `send-keys` commands, i.e.
//     the SAME injection path the dispatcher already uses (§4, §5.2) — the
//     console adds no new way into the pane, only a new place to type from.
//   * the priming capture is issued THROUGH the control client, so it is
//     serialized with the output stream: everything before the capture is in the
//     capture, everything after it arrives as `%output`. No gap, no double paint.

import { exactTarget, tmuxOrThrow } from "./run";

/** Scrollback lines primed into a freshly opened console (same cap as FR-147). */
export const CONSOLE_PRIME_HISTORY_LINES = 500;

/** Input is split into `send-keys -H` commands of at most this many BYTES. */
const INPUT_CHUNK_BYTES = 256;

const ESC = "\u001b";

export interface TmuxConsoleHandlers {
  /** Pane output as raw bytes — feed straight to the terminal emulator. */
  readonly onData: (bytes: Uint8Array) => void;
  /** The attachment ended: session gone, tmux exited, or `close()` was called. */
  readonly onExit: () => void;
}

export interface TmuxConsoleAttachment {
  /** Pane geometry at attach time — the browser MIRRORS it (§12.9), never sets it. */
  readonly cols: number;
  readonly rows: number;
  /** Opening frame: scrollback + visible screen + cursor, ready to be written as-is. */
  readonly screen: string;
  /** Type bytes into the pane exactly as a keyboard would (verbatim, no rendering). */
  write(bytes: Uint8Array): void;
  /** Detach: kills the control client; `onExit` fires. Idempotent. */
  close(): void;
}

export interface AttachConsoleOptions {
  /** Scrollback lines above the visible screen in the priming frame. */
  readonly historyLines?: number;
}

/** Reassembles the control stream into lines without decoding bytes (§12.9). */
class LineSplitter {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== 0x0a) continue;
      // strip a trailing CR — control mode is line-based, the CR is framing
      const end = i > start && merged[i - 1] === 0x0d ? i - 1 : i;
      lines.push(merged.subarray(start, end));
      start = i + 1;
    }
    this.#buffer = merged.slice(start);
    return lines;
  }
}

/** ASCII view of a control-line prefix — keywords and pane ids are ASCII. */
const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
const isOctal = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x30 && byte <= 0x37;

/**
 * Decodes one `%output` payload: tmux escapes a backslash as `\\` and every
 * non-printable byte as `\ooo` (three octal digits), everything else is literal.
 */
export function unescapeOutput(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length);
  let n = 0;
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i] as number;
    if (byte !== 0x5c) {
      out[n++] = byte;
      continue;
    }
    const next = payload[i + 1];
    if (next === 0x5c) {
      out[n++] = 0x5c;
      i += 1;
    } else if (isOctal(next) && isOctal(payload[i + 2]) && isOctal(payload[i + 3])) {
      out[n++] =
        (((next as number) - 0x30) << 6) |
        (((payload[i + 2] as number) - 0x30) << 3) |
        ((payload[i + 3] as number) - 0x30);
      i += 3;
    } else {
      out[n++] = byte; // a lone backslash: pass it through rather than guess
    }
  }
  return out.subarray(0, n);
}

/** Reply of the `cursor_x,cursor_y,window_width,window_height,alternate_on` format. */
interface PaneState {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cols: number;
  readonly rows: number;
  readonly alternate: boolean;
}

export function parsePaneState(line: string): PaneState | undefined {
  const parts = line.trim().split(",");
  if (parts.length < 5) return undefined;
  const nums = parts.slice(0, 5).map((value) => Number.parseInt(value, 10));
  if (nums.some((value) => !Number.isFinite(value))) return undefined;
  const [cursorX, cursorY, cols, rows, alternate] = nums as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (cols <= 0 || rows <= 0) return undefined;
  return { cursorX, cursorY, cols, rows, alternate: alternate === 1 };
}

/**
 * Builds the frame that brings a fresh emulator to the pane's current state:
 * scrollback and screen as text (with SGR attributes, `capture-pane -e`), then
 * the cursor put where tmux has it. CUP is viewport-relative, so the visible
 * screen must be the LAST `rows` lines — which is exactly what the capture gives.
 */
export function primingFrame(capture: readonly string[], state: PaneState): string {
  const alternate = state.alternate ? `${ESC}[?1049h` : "";
  const cursor = `${ESC}[${state.cursorY + 1};${state.cursorX + 1}H`;
  // reset attributes first: the capture paints onto a clean slate
  return `${alternate}${ESC}[0m${ESC}[2J${ESC}[H${capture.join("\r\n")}${cursor}`;
}

/**
 * Attaches to `session`'s active pane and returns a live console (§12.9, FR-160).
 * Rejects when the session is gone or tmux refuses the attach — the caller turns
 * that into the socket's error frame; a half-open console is never returned.
 */
export async function attachConsole(
  session: string,
  handlers: TmuxConsoleHandlers,
  options: AttachConsoleOptions = {},
): Promise<TmuxConsoleAttachment> {
  const sessionTarget = exactTarget(session);
  // The pane id is resolved BEFORE the attach: `%output` carries a pane, and a
  // session with more than one pane must not spill a neighbouring pane's bytes
  // into this view (the rest of Muxeon reads the active pane too — §5.2).
  const pane = (
    await tmuxOrThrow(["display-message", "-p", "-t", sessionTarget, "#{pane_id}"])
  ).trim();
  if (!/^%\d+$/.test(pane)) throw new Error(`tmux gave no pane for session "${session}"`);

  const proc = Bun.spawn(
    ["tmux", "-C", "attach-session", "-t", sessionTarget, "-f", "ignore-size,read-only"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // `attach-session` is the ONE tmux command that cares whether the caller is
      // itself inside tmux: with `$TMUX` set it refuses as a nested attach
      // ("sessions should be nested with care"). capture-pane/send-keys do not,
      // so a server started from a tmux pane would work everywhere EXCEPT the
      // console. Dropping the variable for this child costs nothing and makes
      // the console independent of how the server was launched.
      env: { ...process.env, TMUX: undefined },
    },
  );

  const command = (line: string): void => {
    try {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    } catch {
      // the client died — the exit path below is what reports it
    }
  };

  const history = Math.max(0, options.historyLines ?? CONSOLE_PRIME_HISTORY_LINES);
  // Both replies are read off the SAME stream, in order (see the file header).
  // Single quotes are literal to tmux's parser — `#` would otherwise open a
  // comment and eat the format string.
  command(
    `display-message -p -t ${pane} -F '#{cursor_x},#{cursor_y},#{window_width},#{window_height},#{alternate_on}'`,
  );
  command(`capture-pane -p -e -t ${pane}${history > 0 ? ` -S -${history}` : ""}`);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    proc.kill();
  };

  return await new Promise<TmuxConsoleAttachment>((resolve, reject) => {
    const splitter = new LineSplitter();
    const utf8 = new TextDecoder();
    // One `onData` per stdout chunk, not per `%output` line: a repaint arrives as
    // dozens of lines in one read, and the consumer (a WS frame per call) should
    // not pay for that. Batching here costs no latency — it adds no waiting.
    let batch: Uint8Array[] = [];
    let ready = false;
    let block: string[] | undefined; // lines of the %begin…%end reply being read
    // The attach itself answers with an (empty) block before our two commands do,
    // so the replies are recognized by SHAPE rather than counted: the first block
    // that parses as geometry is ours, and the next one is the capture.
    let geometry: PaneState | undefined;

    const settle = (reason: string): void => {
      if (ready) {
        handlers.onExit();
        return;
      }
      ready = true;
      close();
      reject(new Error(reason.trim().length > 0 ? reason.trim() : "tmux console attach failed"));
    };

    const attachment = (state: PaneState, capture: string[]): void => {
      ready = true;
      resolve({
        cols: state.cols,
        rows: state.rows,
        screen: primingFrame(capture, state),
        write: (bytes) => {
          if (closed || bytes.length === 0) return;
          for (let at = 0; at < bytes.length; at += INPUT_CHUNK_BYTES) {
            const slice = bytes.subarray(at, at + INPUT_CHUNK_BYTES);
            const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
            command(`send-keys -t ${pane} -H ${hex}`);
          }
        },
        close,
      });
    };

    const consume = (line: Uint8Array): void => {
      const head = ascii(line.subarray(0, 8));
      if (block !== undefined) {
        if (head.startsWith("%error")) {
          settle(block.join(" "));
          block = undefined;
          return;
        }
        if (head.startsWith("%end")) {
          const reply = block;
          block = undefined;
          if (ready) return;
          if (geometry === undefined) geometry = parsePaneState(reply[0] ?? "");
          else attachment(geometry, reply);
          return;
        }
        block.push(utf8.decode(line));
        return;
      }
      if (head.startsWith("%begin")) {
        block = [];
        return;
      }
      if (head.startsWith("%output ")) {
        if (!ready) return; // still inside the priming capture (see header)
        const space = line.indexOf(0x20, 8);
        if (space < 0) return;
        if (ascii(line.subarray(8, space)) !== pane) return; // another pane
        batch.push(unescapeOutput(line.subarray(space + 1)));
        return;
      }
      if (head.startsWith("%exit")) close();
    };

    void (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        for (const line of splitter.push(chunk)) consume(line);
        if (batch.length === 0) continue;
        const total = batch.reduce((sum, part) => sum + part.length, 0);
        const merged = new Uint8Array(total);
        let at = 0;
        for (const part of batch) {
          merged.set(part, at);
          at += part.length;
        }
        batch = [];
        handlers.onData(merged);
      }
    })();
    void proc.exited.then(async () => {
      closed = true;
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      settle(stderr);
    });
  });
}
