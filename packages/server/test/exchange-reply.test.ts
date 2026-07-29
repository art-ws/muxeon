// File-borne reply delivery (FR-54, §13.3): reply.md → payload, artifacts → blob
// refs (§12.5), routed back to the sender with the deterministic `<id>:reply` id.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Signal } from "@teamai/core";
import { mimeByName, routeExchangeReply } from "../src/exchange-reply";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "teamai-xreply-"));
  await mkdir(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "operator-web", to: "researcher", kind: "message", ts: 1, payload: "go" };
}

function deps(collected: { text?: string; files: { name: string; path: string }[] } | null) {
  const routed: Signal[] = [];
  const written: number[] = [];
  return {
    routed,
    written,
    deps: {
      agent: "researcher",
      exchange: { collect: async () => collected },
      blobs: {
        write: async (bytes: Uint8Array) => {
          written.push(bytes.length);
          return `blob-${written.length}`;
        },
        read: async () => new Uint8Array(),
      },
      route: async (reply: Signal) => {
        routed.push(reply);
        return { ok: true };
      },
      now: () => 42,
      warn: () => undefined,
    },
  };
}

describe("routeExchangeReply (FR-54)", () => {
  test("text-only reply routes to the sender with deterministic id + replyTo", async () => {
    const kit = deps({ text: "готово", files: [] });
    expect(await routeExchangeReply(msg("m1"), kit.deps)).toBe(true);
    expect(kit.routed).toEqual([
      {
        id: "m1:reply",
        from: "researcher",
        to: "operator-web",
        kind: "message",
        ts: 42,
        replyTo: "m1",
        payload: "готово",
        origin: "exchange",
      },
    ]);
  });

  test("artifacts become §12.5 blob refs with name/mime/size", async () => {
    const file = join(dir, "report.png");
    await writeFile(file, "12345");
    const kit = deps({ text: "см. файл", files: [{ name: "report.png", path: file }] });
    await routeExchangeReply(msg("m1"), kit.deps);
    expect(kit.routed[0]?.payload).toEqual({
      text: "см. файл",
      blobs: [{ blob: "blob-1", name: "report.png", mime: "image/png", size: 5 }],
    });
  });

  test("artifacts-only (no reply.md) still route; nothing at all → false", async () => {
    const file = join(dir, "out.bin");
    await writeFile(file, "x");
    const kit = deps({ files: [{ name: "out.bin", path: file }] });
    expect(await routeExchangeReply(msg("m1"), kit.deps)).toBe(true);
    expect(kit.routed[0]?.payload).toEqual({
      blobs: [{ blob: "blob-1", name: "out.bin", mime: "application/octet-stream", size: 1 }],
    });

    const empty = deps(null);
    expect(await routeExchangeReply(msg("m2"), empty.deps)).toBe(false);
    expect(empty.routed).toHaveLength(0);
  });

  test("a vanished artifact file is skipped, the reply still goes out", async () => {
    const kit = deps({ text: "ок", files: [{ name: "gone.txt", path: join(dir, "gone.txt") }] });
    expect(await routeExchangeReply(msg("m1"), kit.deps)).toBe(true);
    expect(kit.routed[0]?.payload).toBe("ок"); // no refs — text-only shape
  });
});

describe("mimeByName (FR-46)", () => {
  test("known extensions map; unknown → octet-stream", () => {
    expect(mimeByName("a.PNG")).toBe("image/png");
    expect(mimeByName("report.md")).toBe("text/markdown");
    expect(mimeByName("noext")).toBe("application/octet-stream");
  });
});
