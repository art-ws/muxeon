// Exchange (§13, FR-52): dir resolution, inbox materialization (tmp+rename,
// idempotent by id), .gitignore ownership, cleanup, and the orphan sweep guard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message } from "@muxeon/core";
import { createExchange, resolveExchangeDir, settleExchangeDir } from "../src/exchange";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "muxeon-exchange-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function msg(id: string): Message {
  return { id, from: "writer", to: "researcher", kind: "message", ts: 1, payload: `p-${id}` };
}

describe("resolveExchangeDir (§13.1)", () => {
  test("explicit exchangeDir wins; relative resolves from configDir", () => {
    expect(
      resolveExchangeDir({
        exchangeDir: "./x/muxeon",
        cwd: "/work",
        configDir: "/cfg",
        root: "/q",
        session: "s",
      }),
    ).toBe("/cfg/x/muxeon");
    expect(
      resolveExchangeDir({
        exchangeDir: "/abs/x",
        cwd: "/work",
        configDir: "/cfg",
        root: "/q",
        session: "s",
      }),
    ).toBe("/abs/x");
  });

  test("cwd → <cwd>/.muxeon; no cwd → <root>/<session>/exchange", () => {
    expect(resolveExchangeDir({ cwd: "/work", configDir: "/cfg", root: "/q", session: "s" })).toBe(
      "/work/.muxeon",
    );
    expect(resolveExchangeDir({ configDir: "/cfg", root: "/q", session: "s" })).toBe(
      "/q/s/exchange",
    );
  });
});

// --- settleExchangeDir (T122, FR-83) ------------------------------------------
// The §13.2 hint must name the dir the way the AGENT sees it: a cwd reached via
// a symlink resolves to the real folder, so both sides watch one place.

describe("settleExchangeDir (FR-83)", () => {
  test("a symlinked cwd settles to the realpath; the dir is created", async () => {
    const realCwd = join(base, "real", "agent-makar");
    await mkdir(realCwd, { recursive: true });
    const linkCwd = join(base, "agent-makar-link");
    symlinkSync(realCwd, linkCwd);
    const dir = await settleExchangeDir({
      cwd: linkCwd,
      configDir: base,
      root: join(base, "q"),
      session: "makar",
    });
    expect(dir).toBe(join(realpathSync(realCwd), ".muxeon")); // realpath spelling
    expect(existsSync(dir)).toBe(true); // created up front
  });

  test("a plain dir settles to itself (modulo the tmpdir's own symlinks)", async () => {
    const cwd = join(base, "agent-plain");
    await mkdir(cwd, { recursive: true });
    const dir = await settleExchangeDir({
      cwd,
      configDir: base,
      root: join(base, "q"),
      session: "plain",
    });
    expect(dir).toBe(join(realpathSync(cwd), ".muxeon"));
  });

  test("an uncreatable dir falls back to the resolved spelling — boot survives", async () => {
    const file = join(base, "not-a-dir");
    await writeFile(file, "x");
    const dir = await settleExchangeDir({
      cwd: file, // mkdir <file>/.muxeon must fail
      configDir: base,
      root: join(base, "q"),
      session: "broken",
    });
    expect(dir).toBe(join(file, ".muxeon"));
  });
});

describe("inbox materialization (FR-52, §13.2)", () => {
  test("creates inbox/<id>/message.json with the full Signal + system .gitignore", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    const { messageFile } = await exchange.materialize(msg("m1"));
    expect(messageFile).toBe(join(base, ".muxeon", "inbox", "m1", "message.json"));
    const parsed = JSON.parse(readFileSync(messageFile, "utf8"));
    expect(parsed).toEqual(msg("m1"));
    expect(readFileSync(join(base, ".muxeon", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(base, ".muxeon", "outbox"))).toBe(true);
    // no tmp leftovers (§5.3 tmp+rename); the hidden Signal sidecar (FR-74)
    // sits next to message.json and survives the agent's delete
    expect(readdirSync(join(base, ".muxeon", "inbox", "m1")).sort()).toEqual([
      ".signal.json",
      "message.json",
    ]);
    expect(
      JSON.parse(readFileSync(join(base, ".muxeon", "inbox", "m1", ".signal.json"), "utf8")),
    ).toEqual(msg("m1"));
  });

  test("is idempotent by id — a re-send overwrites the same file (§10.9)", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    await exchange.materialize(msg("m1"));
    const again = await exchange.materialize(msg("m1")); // crash → re-send path
    expect(JSON.parse(readFileSync(again.messageFile, "utf8")).id).toBe("m1");
  });

  test("an existing agent .gitignore is not overwritten", async () => {
    const dir = join(base, ".muxeon");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitignore"), "custom\n");
    const exchange = createExchange({ dir });
    await exchange.materialize(msg("m1"));
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom\n");
  });

  test("a path-hostile id cannot escape inbox/ (§8.7)", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    const { messageFile } = await exchange.materialize(msg("../../evil"));
    expect(messageFile.startsWith(join(base, ".muxeon", "inbox"))).toBe(true);
    expect(messageFile).not.toContain("..");
  });

  test("cleanup removes the message dir", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    await exchange.materialize(msg("m1"));
    await exchange.cleanup(msg("m1"));
    expect(existsSync(join(base, ".muxeon", "inbox", "m1"))).toBe(false);
  });
});

describe("file-detect awaitDone (FR-53, §13.3)", () => {
  test("resolves when the agent deletes message.json", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 5 });
    const { messageFile } = await exchange.materialize(msg("m1"));
    const abort = new AbortController();
    let done = false;
    const wait = exchange.awaitDone(msg("m1"), abort.signal).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(done).toBe(false); // file still there — still busy
    rmSync(messageFile);
    await wait;
    expect(done).toBe(true);
  });

  test("deleting the whole message dir also counts as done", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 5 });
    await exchange.materialize(msg("m1"));
    const abort = new AbortController();
    const wait = exchange.awaitDone(msg("m1"), abort.signal);
    rmSync(join(base, ".muxeon", "inbox", "m1"), { recursive: true });
    await wait; // resolves — the dir (and so the file) is gone
  });

  test("returns quietly on abort without touching the file", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 5 });
    const { messageFile } = await exchange.materialize(msg("m1"));
    const abort = new AbortController();
    const wait = exchange.awaitDone(msg("m1"), abort.signal);
    abort.abort();
    await wait;
    expect(existsSync(messageFile)).toBe(true); // another detector won; file intact
  });
});

describe("reply collection (FR-54, §13.3)", () => {
  test("reply.md text + artifacts; hidden files, subdirs and message.json ignored", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    await exchange.materialize(msg("m1"));
    const dir = join(base, ".muxeon", "inbox", "m1");
    await writeFile(join(dir, "reply.md"), "  готово, отчёт во вложении  \n");
    await writeFile(join(dir, "report.txt"), "data");
    await writeFile(join(dir, ".hidden"), "x");
    await mkdir(join(dir, "subdir"));

    const collected = await exchange.collect(msg("m1"));
    expect(collected?.text).toBe("готово, отчёт во вложении");
    expect(collected?.files.map((f) => f.name)).toEqual(["report.txt"]);
  });

  test("artifacts without reply.md still collect; empty reply.md is no text", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    await exchange.materialize(msg("m1"));
    const dir = join(base, ".muxeon", "inbox", "m1");
    await writeFile(join(dir, "reply.md"), "   \n");
    await writeFile(join(dir, "out.bin"), "b");
    const collected = await exchange.collect(msg("m1"));
    expect(collected?.text).toBeUndefined();
    expect(collected?.files.map((f) => f.name)).toEqual(["out.bin"]);
  });

  test("nothing file-borne → null (the FR-47/45 chain takes over)", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    await exchange.materialize(msg("m1"));
    expect(await exchange.collect(msg("m1"))).toBeNull(); // only message.json
    await exchange.cleanup(msg("m1"));
    expect(await exchange.collect(msg("m1"))).toBeNull(); // dir gone entirely
  });

  test("collection works when the agent deleted ONLY message.json (file-detect path)", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon") });
    const { messageFile } = await exchange.materialize(msg("m1"));
    const dir = join(base, ".muxeon", "inbox", "m1");
    await writeFile(join(dir, "reply.md"), "ответ");
    rmSync(messageFile); // the done signal (§13.3)
    expect((await exchange.collect(msg("m1")))?.text).toBe("ответ");
  });
});

// T239: file-detect is not the only way a turn ends. When the OUTPUT detector
// wins mid-write, collection used to read whatever bytes were on disk and then
// authorize the dir's removal — a silently truncated answer.
describe("hot-path settle guard (T239, §13.3)", () => {
  test("a reply.md still being written is read only after it holds still", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 50 });
    await exchange.materialize(msg("m1"));
    const reply = join(base, ".muxeon", "inbox", "m1", "reply.md");
    await writeFile(reply, "часть"); // what a mid-write collect would have grabbed

    const collecting = exchange.collect(msg("m1"));
    await sleep(10); // inside the first sampling interval
    await writeFile(reply, "часть ответа, дописанная целиком");

    expect((await collecting)?.text).toBe("часть ответа, дописанная целиком");
  });

  test("an artifact that is still growing holds the whole collection back", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 50 });
    await exchange.materialize(msg("m1"));
    const dir = join(base, ".muxeon", "inbox", "m1");
    await writeFile(join(dir, "reply.md"), "смотри вложение");
    await writeFile(join(dir, "report.csv"), "a");

    const collecting = exchange.collect(msg("m1"));
    await sleep(10);
    await writeFile(join(dir, "report.csv"), "a,b,c,d,e");

    const collected = await collecting;
    expect(collected?.files.map((f) => f.name)).toEqual(["report.csv"]);
    expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("a,b,c,d,e");
  });

  // Ticks above the internal cap can never be reached — the deterministic way to
  // exercise "still changing when the cap runs out": nothing is read, and the dir
  // is left intact for the late harvest (FR-74) instead of a truncated delivery.
  test("unsettled at the cap → null, and the files are left untouched", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      pollIntervalMs: 1,
      replySettleTicks: 1_000,
    });
    await exchange.materialize(msg("m1"));
    const dir = join(base, ".muxeon", "inbox", "m1");
    await writeFile(join(dir, "reply.md"), "ответ");

    expect(await exchange.collect(msg("m1"))).toBeNull();
    expect(readFileSync(join(dir, "reply.md"), "utf8")).toBe("ответ");
  });

  test("replySettleTicks: 1 disables the wait entirely", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      pollIntervalMs: 60_000, // any wait at all would hang this test
      replySettleTicks: 1,
    });
    await exchange.materialize(msg("m1"));
    await writeFile(join(base, ".muxeon", "inbox", "m1", "reply.md"), "сразу");
    expect((await exchange.collect(msg("m1")))?.text).toBe("сразу");
  });

  test("a turn with no answer files pays nothing — no sampling at all", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), pollIntervalMs: 60_000 });
    await exchange.materialize(msg("m1")); // only message.json + the sidecar
    expect(await exchange.collect(msg("m1"))).toBeNull();
  });
});

describe("orphan sweep (§13.3, §5.4)", () => {
  test("removes old orphans; keeps the active id and fresh dirs", async () => {
    const exchange = createExchange({ dir: join(base, ".muxeon"), orphanMinAgeMs: 60_000 });
    await exchange.materialize(msg("active"));
    await exchange.materialize(msg("orphan"));
    await exchange.materialize(msg("fresh"));
    // age the active and orphan dirs past the guard
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(join(base, ".muxeon", "inbox", "active"), old, old);
    utimesSync(join(base, ".muxeon", "inbox", "orphan"), old, old);

    await exchange.sweepOrphans(new Set(["active"]));

    const left = readdirSync(join(base, ".muxeon", "inbox")).sort();
    expect(left).toEqual(["active", "fresh"]); // orphan gone, active kept, fresh guarded
  });
});

describe("late-reply harvest (FR-74, §13.3)", () => {
  const age = (dir: string, agoMs: number): void => {
    const then = (Date.now() - agoMs) / 1000;
    utimesSync(dir, then, then);
  };

  test("a reply.md written AFTER the contract-breaking delete is harvested, dir removed", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      orphanMinAgeMs: 600_000,
      harvestSettleMs: 1_000,
    });
    await exchange.materialize(msg("late"));
    const dir = join(base, ".muxeon", "inbox", "late");
    rmSync(join(dir, "message.json")); // the agent ends the turn FIRST (broken order)
    await writeFile(join(dir, "reply.md"), "опоздавший ответ");
    age(dir, 5_000); // settled, far below the orphan age

    const harvested: Message[] = [];
    await exchange.sweepOrphans(new Set(), async (original) => {
      harvested.push(original as Message);
      return true; // "collected and routed"
    });

    expect(harvested.map((m) => m.id)).toEqual(["late"]);
    expect(harvested[0]?.from).toBe("writer"); // the sidecar carried the sender
    expect(existsSync(dir)).toBe(false); // routed → removed at once
  });

  test("an unsettled dir is not offered yet; a false callback keeps the dir for the age path", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      orphanMinAgeMs: 600_000,
      harvestSettleMs: 60_000,
    });
    await exchange.materialize(msg("fresh-reply"));
    const freshDir = join(base, ".muxeon", "inbox", "fresh-reply");
    rmSync(join(freshDir, "message.json"));
    await writeFile(join(freshDir, "reply.md"), "ещё пишется");
    // mtime is NOW — inside the settle window

    await exchange.materialize(msg("refused"));
    const refusedDir = join(base, ".muxeon", "inbox", "refused");
    rmSync(join(refusedDir, "message.json"));
    await writeFile(join(refusedDir, "reply.md"), "n");
    age(refusedDir, 120_000); // settled

    const offered: string[] = [];
    await exchange.sweepOrphans(new Set(), async (original) => {
      offered.push(original.id);
      return false; // e.g. routing failed — do not destroy the files
    });

    expect(offered).toEqual(["refused"]); // the fresh dir was not offered
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(refusedDir)).toBe(true); // false ⇒ kept for the age-gated path
  });

  test("a still-present message.json (redeliverable turn §10.9) is never harvested", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      orphanMinAgeMs: 600_000,
      harvestSettleMs: 1_000,
    });
    await exchange.materialize(msg("unclaimed"));
    const dir = join(base, ".muxeon", "inbox", "unclaimed");
    await writeFile(join(dir, "reply.md"), "файлы будущего ре-рана");
    age(dir, 5_000);

    const offered: string[] = [];
    await exchange.sweepOrphans(new Set(), async (original) => {
      offered.push(original.id);
      return true;
    });

    expect(offered).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("a sidecar-less dir (pre-FR-74) falls back to the plain age-gated deletion", async () => {
    const exchange = createExchange({
      dir: join(base, ".muxeon"),
      orphanMinAgeMs: 60_000,
      harvestSettleMs: 1_000,
    });
    const dir = join(base, ".muxeon", "inbox", "old-style");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "reply.md"), "потерянный до FR-74");
    age(dir, 120_000);

    const offered: string[] = [];
    await exchange.sweepOrphans(new Set(), async (original) => {
      offered.push(original.id);
      return true;
    });

    expect(offered).toEqual([]); // nothing to identify the sender — not offered
    expect(existsSync(dir)).toBe(false); // but the age path still cleans it
  });
});

// T239: the age path is where an undelivered answer finally dies. It used to do
// that in complete silence — a live delivery gap then had no trace at all.
describe("age-deleted answers are never silent (T239, §13.3)", () => {
  const age = (dir: string, agoMs: number): void => {
    const then = (Date.now() - agoMs) / 1000;
    utimesSync(dir, then, then);
  };

  const kit = (): { warnings: string[]; exchange: ReturnType<typeof createExchange> } => {
    const warnings: string[] = [];
    return {
      warnings,
      exchange: createExchange({
        dir: join(base, ".muxeon"),
        orphanMinAgeMs: 60_000,
        warn: (text) => warnings.push(text),
      }),
    };
  };

  test("a reply.md + artifacts dying with the dir is reported, with the reason", async () => {
    const { warnings, exchange } = kit();
    await exchange.materialize(msg("lost"));
    const dir = join(base, ".muxeon", "inbox", "lost");
    rmSync(join(dir, "message.json")); // the turn DID end — delivery never worked
    await writeFile(join(dir, "reply.md"), "ответ, который никто не забрал");
    await writeFile(join(dir, "report.csv"), "a,b");
    age(dir, 120_000);

    await exchange.sweepOrphans(new Set());

    expect(existsSync(dir)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('inbox dir "lost"');
    expect(warnings[0]).toContain("UNDELIVERED");
    expect(warnings[0]).toContain("reply.md + 1 artifact file(s)");
    expect(warnings[0]).toContain("no delivery attempt succeeded");
  });

  test("a never-closed turn names THAT as the reason (FR-53), not a delivery failure", async () => {
    const { warnings, exchange } = kit();
    await exchange.materialize(msg("open"));
    const dir = join(base, ".muxeon", "inbox", "open");
    await writeFile(join(dir, "reply.md"), "написал, но ход не закрыл");
    age(dir, 120_000); // message.json still there — file-detect never fired

    await exchange.sweepOrphans(new Set());

    expect(existsSync(dir)).toBe(false);
    expect(warnings[0]).toContain("message.json was never deleted");
  });

  test("an ordinary empty orphan stays silent — only lost ANSWERS warn", async () => {
    const { warnings, exchange } = kit();
    await exchange.materialize(msg("crashed"));
    const dir = join(base, ".muxeon", "inbox", "crashed");
    rmSync(join(dir, "message.json"));
    age(dir, 120_000);

    await exchange.sweepOrphans(new Set());

    expect(existsSync(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("an EMPTY reply.md is not an answer — no warning for it alone", async () => {
    const { warnings, exchange } = kit();
    await exchange.materialize(msg("blank"));
    const dir = join(base, ".muxeon", "inbox", "blank");
    rmSync(join(dir, "message.json"));
    await writeFile(join(dir, "reply.md"), "   \n");
    age(dir, 120_000);

    await exchange.sweepOrphans(new Set());

    expect(warnings).toEqual([]);
  });
});
