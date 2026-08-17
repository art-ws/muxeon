// Console input reconstruction (§12.9.6, FR-170): what the human typed into an
// agent's pane, recovered from the keystroke stream so the chat keeps a record of
// it. Not a line editor — an HONEST reconstruction:
//
//   - printable bytes accumulate (UTF-8 and pasted text alike);
//   - BS/DEL erase one character;
//   - ESC CR (Shift/Alt-Enter in the CLI agents) inserts a newline;
//   - a bare CR/LF SUBMITS: that is the record;
//   - Ctrl-C/Ctrl-U/Ctrl-W/Tab, a bare ESC and any CSI/SS3 sequence (arrows,
//     history recall) DISCARD the buffer — after cursor motion we cannot know what
//     is left on the line, and writing down something false is worse than writing
//     nothing. The discard is reported so the caller can warn (never silent — the
//     T239 rule).
//
// Bracketed paste is honoured: between ESC[200~ and ESC[201~ a newline is text, not
// a submit, exactly as a terminal treats it.

/** One pass over an input frame (§12.9.6). */
export interface ConsoleInputResult {
  /** Submitted lines, in order — each becomes one history record (FR-170). */
  readonly submitted: readonly string[];
  /** How many non-empty buffers were thrown away as unreconstructable. */
  readonly discarded: number;
}

/** A record is a line of input, not an upload path (§12.9.2 caps the frame at 64 KiB). */
export const CONSOLE_LINE_MAX_BYTES = 16 * 1024;

type State = "text" | "esc" | "csi" | "ss3";

/**
 * Per-SOCKET state (§12.9.6): two people typing into one pane each get their own
 * buffer, so a record is attributed to whoever typed it and their keystrokes never
 * blend into someone else's line.
 */
export class ConsoleLineBuffer {
  #bytes: number[] = [];
  #state: State = "text";
  /** CSI parameter bytes of the sequence being swallowed — paste markers live here. */
  #csi: number[] = [];
  #paste = false;
  /** Set when the current buffer became unreconstructable; cleared on submit/discard. */
  #poisoned = false;

  feed(frame: Uint8Array): ConsoleInputResult {
    const submitted: string[] = [];
    let discarded = 0;
    const discard = (): void => {
      if (this.#bytes.length > 0 || this.#poisoned) discarded += 1;
      this.#bytes = [];
      this.#poisoned = false;
    };
    for (const byte of frame) {
      switch (this.#state) {
        case "esc": {
          if (byte === 0x0d || byte === 0x0a) {
            // ESC CR — the "newline, do not submit" chord of the CLI agents.
            this.#push(0x0a);
            this.#state = "text";
            break;
          }
          if (byte === 0x5b /* [ */) {
            this.#state = "csi";
            this.#csi = [];
            break;
          }
          if (byte === 0x4f /* O */) {
            this.#state = "ss3";
            break;
          }
          // A bare ESC (or ESC <letter>): the CLI treats it as cancel/meta — the
          // line is no longer what we saw.
          discard();
          this.#state = "text";
          break;
        }
        case "csi": {
          // Final byte of a CSI sequence is 0x40..0x7e; everything before it is
          // parameters, which is where the bracketed-paste markers live.
          if (byte >= 0x40 && byte <= 0x7e) {
            const params = String.fromCharCode(...this.#csi);
            if (byte === 0x7e /* ~ */ && params === "200") {
              this.#paste = true;
            } else if (byte === 0x7e && params === "201") {
              this.#paste = false;
            } else {
              // Arrows, Home/End, history recall — cursor moved somewhere we cannot
              // see. Everything typed so far stops being trustworthy.
              discard();
            }
            this.#state = "text";
            this.#csi = [];
            break;
          }
          if (this.#csi.length < 16) this.#csi.push(byte);
          break;
        }
        case "ss3": {
          discard(); // SS3 carries the very same arrows in application mode
          this.#state = "text";
          break;
        }
        default: {
          if (byte === 0x1b) {
            this.#state = "esc";
            break;
          }
          if (byte === 0x0d || byte === 0x0a) {
            if (this.#paste) {
              this.#push(0x0a); // inside a paste a newline is content
              break;
            }
            const line = this.#take();
            if (line !== undefined) submitted.push(line);
            else if (this.#poisoned) discarded += 1;
            this.#bytes = [];
            this.#poisoned = false;
            break;
          }
          if (byte === 0x08 || byte === 0x7f) {
            this.#backspace();
            break;
          }
          if (byte < 0x20) {
            // Ctrl-C / Ctrl-U / Ctrl-W / Tab and friends: cancel, kill-line, kill-word,
            // completion — each rewrites the line invisibly.
            discard();
            break;
          }
          this.#push(byte);
          break;
        }
      }
    }
    return { submitted, discarded };
  }

  #push(byte: number): void {
    if (this.#bytes.length >= CONSOLE_LINE_MAX_BYTES) {
      // A console is a line of input; for a long text there is the composer and its
      // attachments (§12.5). Overflow poisons the buffer instead of silently
      // truncating it — a half-recorded instruction reads as a whole one.
      this.#bytes = [];
      this.#poisoned = true;
      return;
    }
    if (!this.#poisoned) this.#bytes.push(byte);
  }

  /** Erase one CHARACTER: pop the UTF-8 continuation bytes, then the lead byte. */
  #backspace(): void {
    while (this.#bytes.length > 0 && ((this.#bytes.at(-1) ?? 0) & 0xc0) === 0x80) {
      this.#bytes.pop();
    }
    this.#bytes.pop();
  }

  /** The buffer as text, or undefined when there is nothing worth recording. */
  #take(): string | undefined {
    if (this.#poisoned || this.#bytes.length === 0) return undefined;
    const text = new TextDecoder().decode(new Uint8Array(this.#bytes));
    return text.trim().length === 0 ? undefined : text;
  }
}
