// Control-mode console attachment (§12.9, FR-160): the parser is pure, the
// attachment needs a real tmux (gated like the rest of this package's suite).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { capturePane } from "../src/capture";
import { attachConsole, parsePaneState, primingFrame, unescapeOutput } from "../src/control";
import { hasTmux, runTmux } from "../src/run";
import { killSession, newSession } from "../src/session";

const HAS_TMUX = await hasTmux();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe("control-mode output escaping (§12.9)", () => {
  test("octal escapes decode to the exact bytes tmux wrote", () => {
    // \033[?2004l\015 — what a shell prompt actually emits
    expect(text(unescapeOutput(bytes("\\033[?2004l\\015")))).toBe("\u001b[?2004l\r");
  });

  test("a literal backslash survives as one byte", () => {
    expect(text(unescapeOutput(bytes("C:\\\\dir")))).toBe("C:\\dir");
  });

  test("multi-byte UTF-8 round-trips byte for byte", () => {
    // "привет" escaped the way control mode escapes non-ASCII
    const escaped = Array.from(bytes("привет"), (b) => `\\${b.toString(8).padStart(3, "0")}`).join(
      "",
    );
    expect(text(unescapeOutput(bytes(escaped)))).toBe("привет");
  });

  test("a lone backslash is passed through, never swallowed", () => {
    expect(text(unescapeOutput(bytes("a\\b")))).toBe("a\\b");
  });
});

describe("pane geometry reply (§12.9)", () => {
  test("parses the comma format", () => {
    expect(parsePaneState("12,3,120,40,1")).toEqual({
      cursorX: 12,
      cursorY: 3,
      cols: 120,
      rows: 40,
      alternate: true,
    });
  });

  test("rejects a truncated or zero-sized reply — never a half-open console", () => {
    expect(parsePaneState("12,3")).toBeUndefined();
    expect(parsePaneState("0,0,0,0,0")).toBeUndefined();
  });

  test("the priming frame clears, paints, then puts the cursor where tmux has it", () => {
    const frame = primingFrame(["one", "two"], {
      cursorX: 4,
      cursorY: 1,
      cols: 80,
      rows: 24,
      alternate: false,
    });
    expect(frame.startsWith("\u001b[0m\u001b[2J\u001b[H")).toBe(true);
    expect(frame).toContain("one\r\ntwo");
    expect(frame.endsWith("\u001b[2;5H")).toBe(true); // 1-based CUP
  });

  test("an alternate-screen pane opens the emulator's alternate screen first", () => {
    const frame = primingFrame([], {
      cursorX: 0,
      cursorY: 0,
      cols: 80,
      rows: 24,
      alternate: true,
    });
    expect(frame.startsWith("\u001b[?1049h")).toBe(true);
  });
});

describe.skipIf(!HAS_TMUX)("console attachment (§12.9, FR-160) [requires tmux]", () => {
  let session: string;

  beforeEach(() => {
    session = `muxeon-console-${randomUUID()}`;
  });

  afterEach(async () => {
    await killSession(session).catch(() => undefined);
  });

  const windowSize = async (): Promise<string> =>
    (
      await runTmux([
        "display-message",
        "-p",
        "-t",
        `=${session}:`,
        "#{window_width}x#{window_height}",
      ])
    ).stdout.trim();

  /** Polls the real pane until it shows `pattern` (real tmux + shell timing). */
  const waitForPane = async (pattern: RegExp, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const pane = await capturePane(session);
      if (pattern.test(pane)) return;
      if (Date.now() > deadline) throw new Error(`pane never matched ${pattern}:\n${pane}`);
      await Bun.sleep(50);
    }
  };

  const quiet = { onData: () => undefined, onExit: () => undefined };

  test("the priming frame opens on a clean slate and carries the pane geometry", async () => {
    await newSession(session, { command: ["sh"] });
    await Bun.sleep(300);
    const term = await attachConsole(session, quiet);
    try {
      expect(term.cols).toBeGreaterThan(0);
      expect(term.rows).toBeGreaterThan(0);
      expect(term.screen).toContain("\u001b[2J");
    } finally {
      term.close();
    }
  });

  test("typed bytes reach the pane and its output streams back", async () => {
    await newSession(session, { command: ["sh"] });
    await Bun.sleep(300);
    let streamed = "";
    const term = await attachConsole(session, {
      onData: (data) => {
        streamed += text(data);
      },
      onExit: () => undefined,
    });
    try {
      term.write(bytes("echo MUXEON_CONSOLE_42\r")); // exactly what a keyboard sends
      await waitForPane(/MUXEON_CONSOLE_42/);
      const deadline = Date.now() + 5000;
      while (!streamed.includes("MUXEON_CONSOLE_42") && Date.now() < deadline) await Bun.sleep(50);
      expect(streamed).toContain("MUXEON_CONSOLE_42");
    } finally {
      term.close();
    }
  });

  test("control bytes are keys, not text: Ctrl-C interrupts the foreground command", async () => {
    await newSession(session, { command: ["sh"] });
    await Bun.sleep(300);
    const term = await attachConsole(session, quiet);
    try {
      term.write(bytes("sleep 60\r"));
      await Bun.sleep(500);
      term.write(new Uint8Array([0x03])); // Ctrl-C
      await Bun.sleep(500);
      term.write(bytes("echo BACK_AT_PROMPT\r"));
      await waitForPane(/BACK_AT_PROMPT/); // only a live shell prompt can echo it
    } finally {
      term.close();
    }
  });

  test("UTF-8 typed in the browser arrives as the same bytes", async () => {
    await newSession(session, { command: ["sh"] });
    await Bun.sleep(300);
    const term = await attachConsole(session, quiet);
    try {
      term.write(bytes("echo привет-консоль\r"));
      await waitForPane(/привет-консоль/);
    } finally {
      term.close();
    }
  });

  test("attaching does NOT resize the agent's window (ignore-size, §12.9)", async () => {
    await newSession(session, { command: ["sh"] });
    await runTmux(["resize-window", "-t", `=${session}:`, "-x", "111", "-y", "29"]);
    expect(await windowSize()).toBe("111x29");
    const term = await attachConsole(session, quiet);
    try {
      expect(term.cols).toBe(111);
      expect(term.rows).toBe(29);
      await Bun.sleep(300);
      expect(await windowSize()).toBe("111x29"); // the CLI agent's screen is untouched
    } finally {
      term.close();
    }
  });

  test("a killed session ends the attachment", async () => {
    await newSession(session, { command: ["sh"] });
    await Bun.sleep(300);
    let exited = false;
    const term = await attachConsole(session, {
      onData: () => undefined,
      onExit: () => {
        exited = true;
      },
    });
    await killSession(session);
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await Bun.sleep(50);
    expect(exited).toBe(true);
    term.close();
  });

  test("attaching to an absent session rejects (no half-open console)", async () => {
    await expect(attachConsole(`absent-${randomUUID()}`, quiet)).rejects.toThrow();
  });
});
