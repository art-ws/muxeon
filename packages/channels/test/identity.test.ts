// Channel identity + addressing in users mode (§17.6, FR-125/FR-126): the sender
// is resolved to exactly one user through the bindings (§10.21 — no guests), and
// the target falls back to SELF when no mention matches (§17.6-2c).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, createBlobStore } from "@muxeon/orchestrator";
import { type ChannelIdentity, resolveUserTarget } from "../src/identity";
import { type TelegramApi, TelegramConnector, type TelegramIncoming } from "../src/telegram";

const identity: ChannelIdentity = {
  userOf: (alias) => ({ alex_tg: "alex", kim_tg: "kim" })[alias],
  aliasOf: (user) => ({ alex: "alex_tg", kim: "kim_tg" })[user],
  peersOf: (user) => (user === "alex" ? ["dev", "kim", "managers"] : ["dev"]),
};

describe("resolveUserTarget (§17.6-2)", () => {
  test("a channel-native mention of another bound user wins", () => {
    expect(resolveUserTarget("hi @kim_tg", "alex", identity)).toEqual({
      target: "kim",
      self: false,
    });
  });

  test("a plain @name token resolves against the sender's visible peers", () => {
    expect(resolveUserTarget("@dev please look", "alex", identity)).toEqual({
      target: "dev",
      self: false,
    });
  });

  test("a group/tag node the sender is wired to is addressable too (§10.17)", () => {
    expect(resolveUserTarget("@managers standup", "alex", identity).target).toBe("managers");
  });

  test("the FIRST matching token from the left wins (§3.2)", () => {
    expect(resolveUserTarget("@nobody @dev @kim_tg", "alex", identity).target).toBe("dev");
  });

  test("no match at all ⇒ self-delivery, never an error (§17.6-2c)", () => {
    expect(resolveUserTarget("just a thought", "alex", identity)).toEqual({
      target: "alex",
      self: true,
    });
  });

  test("mentioning YOURSELF is still a note to self", () => {
    expect(resolveUserTarget("@alex_tg reminder", "alex", identity).self).toBe(true);
  });

  test("a peer that is not visible to this sender does not resolve", () => {
    expect(resolveUserTarget("@kim", "kim", identity)).toEqual({ target: "kim", self: true });
  });
});

/** A fake Bot API: `push` feeds one poll batch, `sent` records the egress. */
class FakeApi implements TelegramApi {
  batches: TelegramIncoming[][] = [];
  sent: { chatId: number | string; text: string }[] = [];

  push(...incoming: TelegramIncoming[]): void {
    this.batches.push(incoming);
  }

  async poll(): Promise<readonly TelegramIncoming[]> {
    const batch = this.batches.shift();
    if (batch !== undefined) return batch;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [];
  }

  async sendText(chatId: number | string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async sendDocument(): Promise<void> {
    return undefined;
  }

  async download(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let root: string;
let blobs: BlobStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-tg-users-"));
  blobs = await createBlobStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function incoming(extra: Partial<TelegramIncoming>): TelegramIncoming {
  return { updateId: 1, chatId: 42, ...extra };
}

describe("telegram in users mode (§17.6, FR-125/FR-126)", () => {
  let api: FakeApi;
  let connector: TelegramConnector;
  let routed: { from: string; to: string }[];

  const connect = async (id: ChannelIdentity = identity): Promise<void> => {
    api = new FakeApi();
    routed = [];
    connector = new TelegramConnector({ identity: id, api, knownAgents: ["dev"], blobs });
    await connector.start(async (message) => {
      routed.push({ from: message.from, to: message.to });
    });
  };

  afterEach(async () => {
    await connector?.stop();
  });

  test("an unbound telegram identity is refused politely and never routed (§10.21)", async () => {
    await connect();
    api.push(incoming({ text: "@dev hi", sender: { username: "stranger" } }));
    await waitFor(() => api.sent.length > 0);
    expect(routed).toEqual([]);
    expect(api.sent[0]?.text).toMatch(/not linked to a Muxeon user/);
  });

  test("a bound sender is attributed to their user, target from the mention", async () => {
    await connect();
    api.push(incoming({ text: "@dev hi", sender: { username: "alex_tg" } }));
    await waitFor(() => routed.length > 0);
    expect(routed).toEqual([{ from: "alex", to: "dev" }]);
  });

  test("no mention ⇒ the message is a note to self (§17.6-2c)", async () => {
    await connect();
    api.push(incoming({ text: "note", sender: { username: "alex_tg" } }));
    await waitFor(() => routed.length > 0);
    expect(routed).toEqual([{ from: "alex", to: "alex" }]);
  });

  test("the numeric user id resolves the sender when the username is absent", async () => {
    await connect({
      ...identity,
      userOf: (alias) => (alias === "12345" ? "alex" : undefined),
    });
    api.push(incoming({ text: "@dev hi", sender: { userId: 12345 } }));
    await waitFor(() => routed.length > 0);
    expect(routed).toEqual([{ from: "alex", to: "dev" }]);
  });

  test("pushTo delivers to the chat that alias last wrote from (§17.5)", async () => {
    await connect();
    api.push(incoming({ chatId: 77, text: "@dev hi", sender: { username: "alex_tg" } }));
    await waitFor(() => routed.length > 0);
    await connector.pushTo("alex_tg", {
      id: "r1",
      from: "dev",
      to: "alex",
      kind: "message",
      ts: 0,
      payload: "done",
    });
    expect(api.sent.at(-1)).toEqual({ chatId: 77, text: "[dev] done" });
  });

  test("pushTo of an unseen alias throws — the caller warns, nothing is re-queued", async () => {
    await connect();
    await expect(
      connector.pushTo("kim_tg", {
        id: "r2",
        from: "dev",
        to: "kim",
        kind: "message",
        ts: 0,
        payload: "hey",
      }),
    ).rejects.toThrow(/no telegram chat known/);
  });

  test("a self-delivered record is NOT echoed back into its source chat (§17.6-2c)", async () => {
    await connect();
    api.push(incoming({ chatId: 77, text: "note", sender: { username: "alex_tg" } }));
    await waitFor(() => routed.length > 0);
    const echoed = api.sent.length;
    // the pseudo-session fans the same record back out over every bound channel
    await connector.pushTo("alex_tg", {
      id: "telegram-1",
      from: "alex",
      to: "alex",
      kind: "message",
      ts: 0,
      payload: "note",
    });
    expect(api.sent.length).toBe(echoed); // the source chat already shows it
  });
});
