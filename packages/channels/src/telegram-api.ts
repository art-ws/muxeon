// Telegram Bot API client (§3.2) — the production TelegramApi over fetch: long-poll
// getUpdates, sendMessage, sendDocument (multipart), getFile+download for inbound
// media. The token comes from config strictly via $env (§7.3); it is REDACTED from
// every thrown error (§8.7 — secrets never reach logs or operator-facing errors).

import type { TelegramApi, TelegramIncoming } from "./telegram";

export interface TelegramBotApiOptions {
  readonly baseUrl?: string; // default https://api.telegram.org
  readonly fetchImpl?: typeof fetch;
  /** getUpdates long-poll horizon, seconds; default 30. */
  readonly longPollSeconds?: number;
}

export function createTelegramBotApi(
  token: string,
  options: TelegramBotApiOptions = {},
): TelegramApi {
  const baseUrl = options.baseUrl ?? "https://api.telegram.org";
  const fetchImpl = options.fetchImpl ?? fetch;
  const longPollSeconds = options.longPollSeconds ?? 30;

  const redact = (text: string): string => text.replaceAll(token, "***");

  async function call(
    method: string,
    body: string | FormData,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        body,
        ...(typeof body === "string" ? { headers: { "content-type": "application/json" } } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      throw new Error(`telegram ${method} failed: ${redact(String(error))}`);
    }
    const json = (await response.json()) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };
    if (json.ok !== true) {
      throw new Error(
        `telegram ${method} error: ${redact(json.description ?? `HTTP ${response.status}`)}`,
      );
    }
    return json.result;
  }

  return {
    async poll(offset: number, signal: AbortSignal): Promise<readonly TelegramIncoming[]> {
      const result = await call(
        "getUpdates",
        JSON.stringify({ offset, timeout: longPollSeconds, allowed_updates: ["message"] }),
        signal,
      );
      if (!Array.isArray(result)) return [];
      return result.flatMap((update) => decodeUpdate(update));
    },

    async sendText(chatId: number | string, text: string): Promise<void> {
      await call("sendMessage", JSON.stringify({ chat_id: chatId, text }));
    },

    async sendDocument(chatId, document): Promise<void> {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("document", new Blob([document.bytes.slice().buffer]), document.name);
      await call("sendDocument", form);
    },

    async download(fileId: string): Promise<Uint8Array> {
      const file = (await call("getFile", JSON.stringify({ file_id: fileId }))) as {
        file_path?: string;
      };
      if (typeof file.file_path !== "string") throw new Error("telegram getFile: no file_path");
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/file/bot${token}/${file.file_path}`);
      } catch (error) {
        throw new Error(`telegram download failed: ${redact(String(error))}`);
      }
      if (!response.ok) throw new Error(`telegram download error: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

// Bot API update → TelegramIncoming; non-message updates yield nothing.
function decodeUpdate(update: unknown): TelegramIncoming[] {
  if (!isRecord(update) || typeof update.update_id !== "number") return [];
  const message = update.message;
  if (!isRecord(message) || !isRecord(message.chat)) return [];
  const chatId = message.chat.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return [];
  const text =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : undefined;
  const media = decodeMedia(message);
  return [
    {
      updateId: update.update_id,
      chatId,
      ...(text !== undefined ? { text } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
  ];
}

function decodeMedia(message: Record<string, unknown>): { fileId: string; name?: string }[] {
  // document: a single file with a name; photo: take the largest rendition (last).
  if (isRecord(message.document) && typeof message.document.file_id === "string") {
    const name =
      typeof message.document.file_name === "string" ? message.document.file_name : undefined;
    return [{ fileId: message.document.file_id, ...(name !== undefined ? { name } : {}) }];
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    if (isRecord(largest) && typeof largest.file_id === "string") {
      return [{ fileId: largest.file_id }];
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
