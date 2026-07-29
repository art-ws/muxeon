// The slash-command key DSL (T118, FR-80): tokens parse into pre/post-capture
// steps, junk fails LOUDLY at parse time (config load, §7.5).

import { describe, expect, test } from "bun:test";
import { parseKeyScript } from "../src/key-script";

describe("key-script DSL (FR-80)", () => {
  test("keys, delays and literals land before the capture by default", () => {
    expect(parseKeyScript('Down Down Enter 500ms "yes" 2s')).toEqual({
      before: [
        { kind: "key", key: "Down" },
        { kind: "key", key: "Down" },
        { kind: "key", key: "Enter" },
        { kind: "delay", ms: 500 },
        { kind: "literal", text: "yes" },
        { kind: "delay", ms: 2000 },
      ],
      after: [],
    });
  });

  test("the capture marker splits the script; esc sugar shape parses", () => {
    expect(parseKeyScript("Down Enter capture Escape")).toEqual({
      before: [
        { kind: "key", key: "Down" },
        { kind: "key", key: "Enter" },
      ],
      after: [{ kind: "key", key: "Escape" }],
    });
    expect(parseKeyScript("capture Escape")).toEqual({
      before: [],
      after: [{ kind: "key", key: "Escape" }],
    });
  });

  test("tmux chords and bare characters are valid key tokens", () => {
    expect(parseKeyScript("C-c M-x F5 y #")).toEqual({
      before: ["C-c", "M-x", "F5", "y", "#"].map((key) => ({ kind: "key", key })),
      after: [],
    });
  });

  test("quoted literals keep inner whitespace and DSL-looking words", () => {
    expect(parseKeyScript('"hello world" "500ms" "capture"')).toEqual({
      before: [
        { kind: "literal", text: "hello world" },
        { kind: "literal", text: "500ms" },
        { kind: "literal", text: "capture" },
      ],
      after: [],
    });
  });

  test.each([
    [""], // empty script
    ["   "], // nothing but whitespace
    ['"unterminated'], // open quote
    ['""'], // empty literal
    ["capture capture"], // two capture points
    ["Enter (bad)"], // junk token charset
    ["20000ms"], // per-delay cap (10s)
    ["10s 10s 10s 10s"], // total delay cap (30s)
    [Array.from({ length: 33 }, () => "Enter").join(" ")], // step cap
  ])("junk script %p is rejected", (script) => {
    expect(() => parseKeyScript(script)).toThrow();
  });

  test("a lone capture with no steps is a valid no-op script", () => {
    expect(parseKeyScript("capture")).toEqual({ before: [], after: [] });
  });
});
