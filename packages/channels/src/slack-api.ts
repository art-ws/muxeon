// Slack Web API client (T37/S) — the production SlackApi over fetch, bound to one
// channel: conversations.history polling (cursored by message ts), chat.postMessage,
// the two-step external file upload, and url_private downloads. The bot token comes
// from config strictly via $env (§7.3) and is REDACTED from every thrown error
// (§8.7). The bot's own posts (bot_id) are filtered out so egress never echoes back
// in as inbound.

import type { SlackApi, SlackIncoming } from "./slack";

export interface SlackWebApiOptions {
  /** The Slack channel id this connector serves (one operator — one channel, §5.3). */
  readonly channel: string;
  readonly baseUrl?: string; // default https://slack.com/api
  readonly fetchImpl?: typeof fetch;
}

export function createSlackWebApi(token: string, options: SlackWebApiOptions): SlackApi {
  const baseUrl = options.baseUrl ?? "https://slack.com/api";
  const fetchImpl = options.fetchImpl ?? fetch;
  const channel = options.channel;

  const redact = (text: string): string => text.replaceAll(token, "***");

  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`slack ${method} failed: ${redact(String(error))}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    if (json.ok !== true) {
      throw new Error(`slack ${method} error: ${redact(String(json.error ?? response.status))}`);
    }
    return json;
  }

  return {
    async poll(cursor) {
      const result = await call("conversations.history", {
        channel,
        limit: 100,
        ...(cursor !== undefined ? { oldest: cursor } : {}),
      });
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const incoming: SlackIncoming[] = [];
      let nextCursor = cursor;
      for (const raw of [...messages].reverse()) {
        // oldest → newest
        if (!isRecord(raw) || typeof raw.ts !== "string") continue;
        if (nextCursor === undefined || Number(raw.ts) > Number(nextCursor)) nextCursor = raw.ts;
        if (raw.bot_id !== undefined || raw.subtype !== undefined) continue; // not operator text
        const text = typeof raw.text === "string" ? raw.text : undefined;
        const files = decodeFiles(raw);
        incoming.push({
          eventId: raw.ts,
          ...(text !== undefined ? { text } : {}),
          ...(files.length > 0 ? { files } : {}),
        });
      }
      return { incoming, ...(nextCursor !== undefined ? { cursor: nextCursor } : {}) };
    },

    async sendText(text) {
      await call("chat.postMessage", { channel, text });
    },

    async sendFile(file) {
      // The modern two-step external upload (files.upload is retired).
      const ticket = (await call("files.getUploadURLExternal", {
        filename: file.name,
        length: file.bytes.byteLength,
      })) as { upload_url?: string; file_id?: string };
      if (typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string") {
        throw new Error("slack upload: no upload_url/file_id");
      }
      const put = await fetchImpl(ticket.upload_url, {
        method: "POST",
        body: file.bytes.slice().buffer,
      });
      if (!put.ok) throw new Error(`slack upload error: HTTP ${put.status}`);
      await call("files.completeUploadExternal", {
        files: [{ id: ticket.file_id, title: file.name }],
        channel_id: channel,
      });
    },

    async download(fileId) {
      const info = (await call("files.info", { file: fileId })) as {
        file?: { url_private_download?: string };
      };
      const url = info.file?.url_private_download;
      if (typeof url !== "string") throw new Error("slack files.info: no download url");
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`slack download error: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function decodeFiles(message: Record<string, unknown>): { id: string; name?: string }[] {
  if (!Array.isArray(message.files)) return [];
  const files: { id: string; name?: string }[] = [];
  for (const raw of message.files) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    files.push({ id: raw.id, ...(name !== undefined ? { name } : {}) });
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
