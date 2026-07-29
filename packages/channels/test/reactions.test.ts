// Reactions (T38/S, FR-25b, §3.2/§5.3): a distinct forward-compat kind. A
// connector renders a reaction as a small notice; an UNSUPPORTED kind is ignored
// without throwing — so the egress dispatcher completes the record and an unknown
// kind can never block the operator queue (§10.9). Baseline "message" is untouched.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@teamai/core";
import { createBlobStore } from "@teamai/orchestrator";
import { SlackConnector } from "../src/slack";
import { TelegramConnector, type TelegramIncoming } from "../src/telegram";

function signal(kind: Signal["kind"], payload: unknown = "👍"): Signal {
  return { id: "r1", from: "researcher", to: "operator", kind, ts: 0, payload };
}

async function makeTelegram(): Promise<{
  connector: TelegramConnector;
  texts: string[];
  stop: () => Promise<void>;
}> {
  const texts: string[] = [];
  const blobs = await createBlobStore(mkdtempSync(join(tmpdir(), "teamai-reactions-")));
  const connector = new TelegramConnector({
    bindOperator: "operator",
    api: {
      poll: async (): Promise<readonly TelegramIncoming[]> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ updateId: 1, chatId: 5, text: "@researcher hi" }];
      },
      sendText: async (_chat, text) => {
        texts.push(text);
      },
      sendDocument: async () => undefined,
      download: async () => new Uint8Array(),
    },
    knownAgents: ["researcher"],
    blobs,
  });
  await connector.start(async () => undefined);
  // let one inbound land so the chat is known
  const deadline = Date.now() + 5000;
  while (texts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (Date.now() > deadline) throw new Error("timeout");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { connector, texts, stop: () => connector.stop() };
}

describe("reaction kind across connectors (FR-25b)", () => {
  test("telegram renders a reaction as a notice; baseline message still works", async () => {
    const { connector, texts, stop } = await makeTelegram();
    try {
      await connector.deliver(signal("reaction"));
      expect(texts).toContain("[researcher] reacted: 👍");
      await connector.deliver(signal("message", "plain text"));
      expect(texts).toContain("[researcher] plain text");
    } finally {
      await stop();
    }
  });

  test("an unsupported kind is ignored WITHOUT throwing — never blocks egress (§10.9)", async () => {
    const { connector, stop } = await makeTelegram();
    try {
      const unknown = { ...signal("message"), kind: "future-kind" } as unknown as Signal;
      await expect(connector.deliver(unknown)).resolves.toBeUndefined();
    } finally {
      await stop();
    }
  });

  test("slack renders a reaction and ignores unknown kinds the same way", async () => {
    const texts: string[] = [];
    const blobs = await createBlobStore(mkdtempSync(join(tmpdir(), "teamai-reactions-")));
    const connector = new SlackConnector({
      bindOperator: "operator",
      api: {
        poll: async () => ({ incoming: [] }),
        sendText: async (text) => {
          texts.push(text);
        },
        sendFile: async () => undefined,
        download: async () => new Uint8Array(),
      },
      knownAgents: ["researcher"],
      blobs,
      pollIdleMs: 5,
    });
    await connector.deliver(signal("reaction", { emoji: "🎉" }));
    expect(texts).toEqual(['[researcher] reacted: {"emoji":"🎉"}']);
    const unknown = { ...signal("message"), kind: "future-kind" } as unknown as Signal;
    await expect(connector.deliver(unknown)).resolves.toBeUndefined();
    await connector.stop();
  });
});
