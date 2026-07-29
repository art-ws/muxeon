// Composer draft logic (T50, §12.5) — the DOM-free half of the media path.

import { describe, expect, test } from "bun:test";
import {
  CLIP_MIME_CANDIDATES,
  VOICE_MIME_CANDIDATES,
  addAttachment,
  captureName,
  pickRecorderMime,
  removeAttachment,
} from "../src/draft";

const meta = (id: string) => ({ id, name: `${id}.jpg`, mime: "image/jpeg", size: 10 });

describe("attachment list", () => {
  test("add dedups by blob id; remove drops the chip", () => {
    let list = addAttachment([], meta("b-1"));
    list = addAttachment(list, meta("b-2"));
    list = addAttachment(list, meta("b-1")); // duplicate upload result
    expect(list.map((a) => a.id)).toEqual(["b-1", "b-2"]);
    expect(removeAttachment(list, "b-1").map((a) => a.id)).toEqual(["b-2"]);
  });

  test("the chip label is the stored file name", () => {
    expect(addAttachment([], meta("b-1"))[0]?.label).toBe("b-1.jpg");
  });
});

describe("capture naming (§12.5)", () => {
  test("voice/photo/clip names are kind-prefixed, time-stamped, extension-correct", () => {
    const ts = Date.UTC(2026, 5, 4, 12, 30, 45);
    expect(captureName("voice", ts, "audio/webm;codecs=opus")).toBe(
      "voice-2026-06-04T12-30-45.webm",
    );
    expect(captureName("photo", ts, "image/jpeg")).toBe("photo-2026-06-04T12-30-45.jpg");
    expect(captureName("clip", ts, "video/webm")).toBe("clip-2026-06-04T12-30-45.webm");
  });
});

describe("recorder mime negotiation", () => {
  test("first supported candidate wins; none supported → undefined (browser default)", () => {
    expect(pickRecorderMime(VOICE_MIME_CANDIDATES, (mime) => mime === "audio/webm")).toBe(
      "audio/webm",
    );
    expect(pickRecorderMime(CLIP_MIME_CANDIDATES, () => true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderMime(VOICE_MIME_CANDIDATES, () => false)).toBeUndefined();
  });
});
