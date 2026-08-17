// Console input reconstruction (§12.9.6, FR-170): what the human typed into an
// agent's pane, recovered from the keystroke stream. The rule under test is the
// honesty rule — a line we cannot reconstruct is DROPPED (and reported), never
// recorded wrongly.

import { describe, expect, test } from "bun:test";
import { CONSOLE_LINE_MAX_BYTES, ConsoleLineBuffer } from "../src/console-input";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const CR = new Uint8Array([0x0d]);
const feed = (buffer: ConsoleLineBuffer, ...frames: Uint8Array[]) => {
  let submitted: string[] = [];
  let discarded = 0;
  for (const frame of frames) {
    const result = buffer.feed(frame);
    submitted = [...submitted, ...result.submitted];
    discarded += result.discarded;
  }
  return { submitted, discarded };
};

describe("submission", () => {
  test("printable bytes accumulate and CR submits one line", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, bytes("проверь тесты"), CR)).toEqual({
      submitted: ["проверь тесты"],
      discarded: 0,
    });
  });

  test("byte-at-a-time typing reconstructs the same line (UTF-8 split across frames)", () => {
    const buffer = new ConsoleLineBuffer();
    const submitted: string[] = [];
    for (const byte of bytes("привет")) {
      submitted.push(...buffer.feed(new Uint8Array([byte])).submitted);
    }
    expect(submitted).toEqual([]);
    expect(buffer.feed(CR).submitted).toEqual(["привет"]);
  });

  test("LF submits like CR; an empty or blank submit records nothing", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, bytes("ok"), new Uint8Array([0x0a]))).toEqual({
      submitted: ["ok"],
      discarded: 0,
    });
    expect(feed(buffer, CR)).toEqual({ submitted: [], discarded: 0 });
    expect(feed(buffer, bytes("   "), CR)).toEqual({ submitted: [], discarded: 0 });
  });

  test("two lines in one frame are two records, in order", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, bytes("one\rtwo\r")).submitted).toEqual(["one", "two"]);
  });
});

describe("editing we can follow", () => {
  test("BS/DEL erase one CHARACTER, multi-byte included", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, bytes("тест"), new Uint8Array([0x7f]), bytes("ы"), CR).submitted).toEqual([
      "тесы",
    ]);
    expect(feed(buffer, bytes("ab"), new Uint8Array([0x08]), CR).submitted).toEqual(["a"]);
  });

  test("ESC CR inserts a newline instead of submitting (Shift/Alt-Enter)", () => {
    const buffer = new ConsoleLineBuffer();
    const result = feed(buffer, bytes("first"), new Uint8Array([0x1b, 0x0d]), bytes("second"), CR);
    expect(result.submitted).toEqual(["first\nsecond"]);
  });

  test("bracketed paste keeps its newlines as content, then submits once", () => {
    const buffer = new ConsoleLineBuffer();
    const result = feed(buffer, bytes("\u001b[200~line one\rline two\u001b[201~"), CR);
    expect(result.submitted).toEqual(["line one\nline two"]);
  });
});

describe("what we refuse to guess (the honesty rule)", () => {
  test("an arrow key discards the buffer and reports it — no false record", () => {
    const buffer = new ConsoleLineBuffer();
    const result = feed(buffer, bytes("half typed"), bytes("\u001b[A"), bytes("tail"), CR);
    expect(result.submitted).toEqual(["tail"]); // what came AFTER the jump is clean
    expect(result.discarded).toBe(1);
  });

  test("the CSI final byte is swallowed — no stray letter leaks into the text", () => {
    const buffer = new ConsoleLineBuffer();
    // Home, End, a parametrised sequence: none of their letters may appear.
    const result = feed(buffer, bytes("\u001b[H\u001b[F\u001b[1;5Dtext"), CR);
    expect(result.submitted).toEqual(["text"]);
  });

  test("Ctrl-C / Ctrl-U / Ctrl-W / Tab each drop the line", () => {
    for (const control of [0x03, 0x15, 0x17, 0x09]) {
      const buffer = new ConsoleLineBuffer();
      const result = feed(buffer, bytes("typed"), new Uint8Array([control]), CR);
      expect(result.submitted).toEqual([]);
      expect(result.discarded).toBe(1);
    }
  });

  test("SS3 arrows (application mode) discard too", () => {
    const buffer = new ConsoleLineBuffer();
    const result = feed(buffer, bytes("typed"), bytes("\u001bOA"), CR);
    expect(result.submitted).toEqual([]);
    expect(result.discarded).toBe(1);
  });

  test("a bare ESC drops the line (the CLI reads it as cancel)", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, bytes("typed"), new Uint8Array([0x1b, 0x41]), CR).discarded).toBe(1);
  });

  test("overflow drops the line instead of truncating it (§12.9.6 cap)", () => {
    const buffer = new ConsoleLineBuffer();
    const result = feed(buffer, bytes("x".repeat(CONSOLE_LINE_MAX_BYTES + 10)), CR);
    expect(result.submitted).toEqual([]);
    expect(result.discarded).toBe(1);
    // …and the next line is clean again.
    expect(feed(buffer, bytes("after"), CR).submitted).toEqual(["after"]);
  });

  test("a discard of an EMPTY buffer is not reported — nothing was lost", () => {
    const buffer = new ConsoleLineBuffer();
    expect(feed(buffer, new Uint8Array([0x03])).discarded).toBe(0);
  });
});
