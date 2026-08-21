// The prompt rack over the real connector (§20.3, FR-184): the HTTP shapes the
// panel actually speaks, the auth gate (§10.12), the CSRF gate on the mutating
// verbs (§12.6) and the property that makes isolation structural — no endpoint
// takes an owner, so a foreign rack has no address at all (§10.32).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import { HistoryStore } from "../src/history";
import { PROMPT_LIMITS, PromptStore } from "../src/prompts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muxeon-prompts-http-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ports = {
  listPeers: () => ["muxeon"],
  peerStatus: () => "idle" as const,
  peerType: () => "agent" as const,
  queueDepth: async () => 0,
  messagePhase: async () => undefined,
};

interface Harness {
  connector: WebchatConnector;
  store: PromptStore;
  /** Signed in as `shagin` (admin). */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Signed in as `alex` (the second user, §17). */
  asAlex(path: string, init?: RequestInit): Promise<Response>;
  /** No cookie at all — the auth gate's view. */
  raw(path: string, init?: RequestInit): Promise<Response>;
}

async function harness(options: { prompts?: boolean } = {}): Promise<Harness> {
  const store = new PromptStore({ dir: join(root, "prompts") });
  const user = (name: string) => ({
    name,
    role: "admin" as const,
    password: "hunter2",
    history: new HistoryStore({ dir: join(root, "history", name), operator: name }),
    ports,
  });
  const connector = new WebchatConnector({
    port: 0,
    users: [user("shagin"), user("alex")],
    ...(options.prompts === false ? {} : { prompts: store }),
  });
  await connector.start(async () => undefined);
  const raw = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${connector.port}${path}`, init);
  const signIn = async (name: string): Promise<string> => {
    const login = await raw("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: name, password: "hunter2" }),
    });
    return /muxeon_webchat=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  };
  const shaginToken = await signIn("shagin");
  const alexToken = await signIn("alex");
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}): Promise<Response> =>
      raw(path, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          cookie: `${SESSION_COOKIE}=${token}`,
        },
      });
  return { connector, store, request: as(shaginToken), asAlex: as(alexToken), raw };
}

const body = (payload: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

async function library(request: Harness["request"]): Promise<{
  shelves: { id: string; name: string; prompts: { id: string; name: string; text: string }[] }[];
}> {
  const response = await request("/api/prompts");
  return ((await response.json()) as { library: never }).library;
}

describe("the gates (§10.12, §12.6)", () => {
  test("without a session the rack is 401, not an empty rack", async () => {
    const h = await harness();
    try {
      expect((await h.raw("/api/prompts")).status).toBe(401);
      expect(
        (await h.raw("/api/prompts/shelves", { method: "POST", ...body({ name: "x" }) })).status,
      ).toBe(401);
    } finally {
      h.connector.stop();
    }
  });

  test("a cross-origin PATCH is refused — the CSRF gate covers every mutating verb", async () => {
    const h = await harness();
    try {
      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Полка" }) });
      const id = (await library(h.request)).shelves[0]?.id ?? "";
      const response = await h.request(`/api/prompts/shelves/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ name: "Захвачено" }),
      });
      expect(response.status).toBe(403);
    } finally {
      h.connector.stop();
    }
  });

  test("no store wired ⇒ 503, and the panel simply offers nothing", async () => {
    const h = await harness({ prompts: false });
    try {
      expect((await h.request("/api/prompts")).status).toBe(503);
    } finally {
      h.connector.stop();
    }
  });
});

describe("CRUD over HTTP (§20.3, FR-184)", () => {
  test("every answer carries the rack AFTER the change", async () => {
    const h = await harness();
    try {
      const created = await h.request("/api/prompts/shelves", {
        method: "POST",
        ...body({ name: "Разбор кода" }),
      });
      expect(created.status).toBe(200);
      const shelf = (await created.json()) as { library: { shelves: { id: string }[] } };
      const id = shelf.library.shelves[0]?.id ?? "";
      const withPrompt = await h.request("/api/prompts/items", {
        method: "POST",
        ...body({ shelf: id, name: "Ревью диффа", text: "Посмотри diff." }),
      });
      const after = (await withPrompt.json()) as {
        library: { shelves: { prompts: { name: string; text: string }[] }[] };
      };
      expect(after.library.shelves[0]?.prompts[0]).toMatchObject({
        name: "Ревью диффа",
        text: "Посмотри diff.",
      });
      // …and the same rack comes back on a plain GET, so the page and the menu
      // never draw a client-side merge.
      expect((await library(h.request)).shelves[0]?.prompts).toHaveLength(1);
    } finally {
      h.connector.stop();
    }
  });

  test("PATCH renames, moves between shelves and reorders; DELETE removes", async () => {
    const h = await harness();
    try {
      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Первая" }) });
      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Вторая" }) });
      const shelves = (await library(h.request)).shelves;
      const [first, second] = [shelves[0]?.id ?? "", shelves[1]?.id ?? ""];
      await h.request("/api/prompts/items", {
        method: "POST",
        ...body({ shelf: first, name: "Промпт", text: "тело" }),
      });
      const prompt = (await library(h.request)).shelves[0]?.prompts[0]?.id ?? "";
      await h.request(`/api/prompts/items/${prompt}`, {
        method: "PATCH",
        ...body({ name: "Переименован", shelf: second }),
      });
      const moved = await library(h.request);
      expect(moved.shelves[0]?.prompts).toHaveLength(0);
      expect(moved.shelves[1]?.prompts[0]?.name).toBe("Переименован");
      await h.request(`/api/prompts/shelves/${second}`, {
        method: "PATCH",
        ...body({ position: 0 }),
      });
      expect((await library(h.request)).shelves.map((shelf) => shelf.name)).toEqual([
        "Вторая",
        "Первая",
      ]);
      const removed = await h.request(`/api/prompts/items/${prompt}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect((await library(h.request)).shelves[0]?.prompts).toHaveLength(0);
    } finally {
      h.connector.stop();
    }
  });

  test("refusals carry a code and a field: 404 unknown, 422 duplicate/limit, 400 no body", async () => {
    const h = await harness();
    try {
      const unknown = await h.request("/api/prompts/items/nope", {
        method: "PATCH",
        ...body({ text: "x" }),
      });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()) as { code: string }).toMatchObject({ code: "UNKNOWN_PROMPT" });

      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Полка" }) });
      const duplicate = await h.request("/api/prompts/shelves", {
        method: "POST",
        ...body({ name: "полка" }),
      });
      expect(duplicate.status).toBe(422);
      expect((await duplicate.json()) as { code: string; field: string }).toMatchObject({
        code: "DUPLICATE_NAME",
        field: "name",
      });

      const shelf = (await library(h.request)).shelves[0]?.id ?? "";
      const tooLong = await h.request("/api/prompts/items", {
        method: "POST",
        ...body({ shelf, name: "Длинный", text: "x".repeat(PROMPT_LIMITS.textMax + 1) }),
      });
      expect(tooLong.status).toBe(422);
      expect((await tooLong.json()) as { code: string }).toMatchObject({ code: "LIMIT" });

      const noBody = await h.request("/api/prompts/shelves", { method: "POST" });
      expect(noBody.status).toBe(400);
    } finally {
      h.connector.stop();
    }
  });

  test("the routes are exact: POST with an id and PATCH without one are 404", async () => {
    const h = await harness();
    try {
      expect(
        (await h.request("/api/prompts/shelves/x", { method: "POST", ...body({ name: "a" }) }))
          .status,
      ).toBe(404);
      expect(
        (await h.request("/api/prompts/items", { method: "PATCH", ...body({ text: "a" }) })).status,
      ).toBe(404);
      expect((await h.request("/api/prompts/nonsense")).status).toBe(404);
    } finally {
      h.connector.stop();
    }
  });
});

describe("isolation (§10.32, FR-183)", () => {
  test("two users hold two racks, and neither endpoint takes an owner", async () => {
    const h = await harness();
    try {
      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Моя полка" }) });
      expect((await library(h.asAlex)).shelves).toEqual([]);
      await h.asAlex("/api/prompts/shelves", { method: "POST", ...body({ name: "Полка Алекса" }) });
      expect((await library(h.request)).shelves.map((shelf) => shelf.name)).toEqual(["Моя полка"]);
    } finally {
      h.connector.stop();
    }
  });

  test("another user's shelf id is simply unknown — there is nothing to address", async () => {
    const h = await harness();
    try {
      await h.request("/api/prompts/shelves", { method: "POST", ...body({ name: "Моя полка" }) });
      const mine = (await library(h.request)).shelves[0]?.id ?? "";
      const stolen = await h.asAlex(`/api/prompts/shelves/${mine}`, {
        method: "PATCH",
        ...body({ name: "Захвачено" }),
      });
      expect(stolen.status).toBe(404);
      expect((await library(h.request)).shelves[0]?.name).toBe("Моя полка");
    } finally {
      h.connector.stop();
    }
  });
});
