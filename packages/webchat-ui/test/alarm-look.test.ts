// The K scale of the panel (§22.6.1, FR-206): one pure mapping, continuous, and
// the three reference points the operator named — green, yellow, red.

import { describe, expect, test } from "bun:test";
import {
  alarmBand,
  alarmLook,
  alarmRecordLevel,
  formatLevel,
  loudestFirst,
  shouldSound,
  titleFrame,
} from "../src/alarm-look";

describe("alarmLook — the operator's three points and everything between (§22.6.1)", () => {
  test("hue: K=0 green (120°), K=0.5 yellow (60°), K=1 red (0°)", () => {
    expect(alarmLook(0).hue).toBe(120);
    expect(alarmLook(0.5).hue).toBe(60);
    expect(alarmLook(1).hue).toBe(0);
  });

  test("continuous: hue falls and pulse quickens monotonically with K", () => {
    let previous = alarmLook(0);
    for (let step = 1; step <= 20; step++) {
      const look = alarmLook(step / 20);
      expect(look.hue).toBeLessThanOrEqual(previous.hue);
      expect(look.pulseMs).toBeLessThan(previous.pulseMs);
      expect(look.sound.freq).toBeGreaterThanOrEqual(previous.sound.freq);
      expect(look.sound.gain).toBeGreaterThanOrEqual(previous.sound.gain);
      previous = look;
    }
  });

  test("sound: 440 → 880 Hz, one beep up to three, louder with K", () => {
    expect(alarmLook(0).sound).toMatchObject({ freq: 440, pulses: 1, gain: 0.25 });
    expect(alarmLook(1).sound).toMatchObject({ freq: 880, pulses: 3, gain: 0.75 });
    expect(alarmLook(0.5).sound.pulses).toBe(2);
  });

  test("repeat until someone reacts only from 0.5 up: 60 s → 10 s", () => {
    expect(alarmLook(0.49).repeatMs).toBeNull();
    expect(alarmLook(0.5).repeatMs).toBe(60_000);
    expect(alarmLook(1).repeatMs).toBe(10_000);
    expect(alarmLook(0.75).repeatMs).toBe(35_000);
  });

  test("the OS notification stays on screen from 0.5 up", () => {
    expect(alarmLook(0.4).requireInteraction).toBe(false);
    expect(alarmLook(0.5).requireInteraction).toBe(true);
  });

  test("bands name the level in words — color is never the only carrier", () => {
    expect(alarmBand(0)).toBe("notice");
    expect(alarmBand(0.4)).toBe("warning");
    expect(alarmBand(0.9)).toBe("critical");
    expect(alarmLook(0.9).glyph).toBe("🔴");
  });

  test("junk levels do not break the scale", () => {
    expect(alarmLook(Number.NaN).hue).toBe(120);
    expect(alarmLook(7).hue).toBe(0);
  });
});

describe("formatLevel — percent is what a human reads (T350)", () => {
  test("0.85 → 85%", () => {
    expect(formatLevel(0.85)).toBe("85%");
    expect(formatLevel(0)).toBe("0%");
    expect(formatLevel(1)).toBe("100%");
    expect(formatLevel(0.333)).toBe("33%");
  });
});

describe("shouldSound — replacements do not turn the room into a siren (§22.6.4)", () => {
  const alarm = (id: string, level: number, state = "raised", raisedAt = 0) => ({
    id,
    level,
    state,
    raisedAt,
  });

  test("a new loud alarm sounds; a quiet state never does", () => {
    expect(shouldSound(undefined, alarm("a", 0.2), undefined, 0)).toBe(true);
    expect(shouldSound(alarm("a", 0.2, "seen"), alarm("b", 0.2), 0, 1)).toBe(true);
    expect(shouldSound(undefined, alarm("a", 0.9, "seen"), undefined, 0)).toBe(false);
  });

  test("the same alarm pushed again stays silent", () => {
    expect(shouldSound(alarm("a", 0.9), alarm("a", 0.9), 0, 60_000)).toBe(false);
  });

  test("a replacement sounds on escalation by ≥ 0.1, or after the cooldown", () => {
    expect(shouldSound(alarm("a", 0.75), alarm("b", 0.85), 0, 1_000)).toBe(true);
    expect(shouldSound(alarm("a", 0.8), alarm("b", 0.85), 0, 1_000)).toBe(false);
    expect(shouldSound(alarm("a", 0.8), alarm("b", 0.8), 0, 30_000)).toBe(true);
    expect(shouldSound(alarm("a", 0.9), alarm("b", 0.5), 0, 29_999)).toBe(false);
  });
});

describe("loudestFirst — the modal's order (§22.6.2)", () => {
  test("raised only, level desc, the newer cry wins a tie", () => {
    const list = loudestFirst([
      { id: "a", level: 0.4, state: "raised", raisedAt: 1 },
      { id: "b", level: 0.9, state: "raised", raisedAt: 1 },
      { id: "c", level: 0.4, state: "raised", raisedAt: 5 },
      { id: "d", level: 1, state: "seen", raisedAt: 9 },
    ]);
    expect(list.map((alarm) => alarm.id)).toEqual(["b", "c", "a"]);
  });
});

describe("titleFrame — the tab-title ticker (§22.6.3)", () => {
  const line = "🔴 dev: the migration failed on step three, the database is half-way";

  test("scrolls through a fixed window and shows the ordinary title every tenth frame", () => {
    expect([...titleFrame("Muxeon", line, 0, { width: 20 })]).toHaveLength(20);
    expect(titleFrame("Muxeon", line, 1, { width: 20 })).not.toBe(
      titleFrame("Muxeon", line, 0, { width: 20 }),
    );
    expect(titleFrame("Muxeon", line, 9)).toBe("Muxeon");
  });

  test("a short line does not scroll", () => {
    expect(titleFrame("Muxeon", "🟢 dev: ok", 3)).toBe("🟢 dev: ok");
  });

  test("reduced motion alternates instead of scrolling", () => {
    expect(titleFrame("Muxeon", line, 0, { reduced: true })).toBe(line);
    expect(titleFrame("Muxeon", line, 1, { reduced: true })).toBe("Muxeon");
  });
});

describe("alarmRecordLevel — a trace in the chat wears the alarm's color (§22.6.6)", () => {
  test("reads the level from the protocol line of an alarm record only", () => {
    const payload =
      "[muxeon alarm] alex answered your alarm a1 (level 0.85) with option 1 of 2: «x»";
    expect(alarmRecordLevel({ origin: "alarm:a1:answer", payload })).toBe(0.85);
    expect(alarmRecordLevel({ origin: "webchat", payload })).toBeUndefined();
    expect(alarmRecordLevel({ origin: "alarm:a1:ack", payload: "no level here" })).toBeUndefined();
    expect(alarmRecordLevel({ origin: "alarm:a1:ack", payload: { text: "x" } })).toBeUndefined();
  });
});
