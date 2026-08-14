import { describe, expect, test } from "bun:test";
import type { Message } from "@muxeon/core";
import { defaultRender, makeDefaultRender, renderAttribution, renderRaw } from "../src/contract";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "abc-123",
    from: "researcher",
    to: "writer",
    kind: "message",
    ts: 0,
    payload: "hello",
    ...overrides,
  };
}

describe("default render / attribution (§8.3, FR-6)", () => {
  test("attribution carries from + id so the agent can reply", () => {
    expect(renderAttribution(msg())).toBe("[muxeon] from=researcher id=abc-123");
  });

  test("attribution includes replyTo when present", () => {
    expect(renderAttribution(msg({ replyTo: "xyz" }))).toBe(
      "[muxeon] from=researcher id=abc-123 replyTo=xyz",
    );
  });

  test("defaultRender is attribution + reply hint + payload (T57)", () => {
    const text = defaultRender(msg({ payload: "do the thing" }));
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("do the thing");
    expect(text).toMatch(/from=researcher/);
    // The reply hint names the EXACT call — live finding: bare attribution is
    // not enough, the model answers in the terminal and never calls the tool.
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).toContain("plain-text payload");
  });

  test("payload rendering: string, {text}, and JSON fallback", () => {
    expect(defaultRender(msg({ payload: "raw" }))).toContain("raw");
    expect(defaultRender(msg({ payload: { text: "nested" } }))).toContain("nested");
    expect(defaultRender(msg({ payload: { n: 1 } }))).toContain('{"n":1}');
  });
});

describe("renderRaw (FR-88, §14.1)", () => {
  test("the payload text reaches the terminal VERBATIM — no preamble/hint", () => {
    const text = renderRaw(msg({ payload: "ls -la", raw: true }));
    expect(text).toBe("ls -la");
    expect(text).not.toContain("[muxeon]"); // no attribution (§14.1)
    expect(text).not.toContain("send("); // no reply hint
  });

  test("an object payload degrades to its text part (attachments dropped)", () => {
    expect(renderRaw(msg({ payload: { text: "echo hi", blobs: [{ blob: "x" }] } }))).toBe(
      "echo hi",
    );
    // a blobs-only payload has no text to inject → empty (raw mode has no media)
    expect(renderRaw(msg({ payload: { blobs: [{ blob: "x" }] } }))).toBe("");
  });
});

// --- T70 (FR-52, §13.2): the hybrid file-contract instruction ------------------

describe("exchange render (FR-52, §13.2)", () => {
  const FILE = "/work/.muxeon/inbox/abc-123/message.json";

  test("short payload: inlined text + the file contract LAST (T57)", () => {
    const text = defaultRender(msg({ payload: "привет" }), { messageFile: FILE });
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("привет"); // readable live chat in tmux
    expect(text).toContain(`full message: ${FILE}`);
    expect(text).toContain("reply.md");
    expect(text).toContain("DELETE message.json");
    // T75 live finding: deletion must be spelled out as the FINAL step — an
    // agent that deletes first ends the turn before its reply is written.
    expect(text).toContain("FIRST write your answer");
    expect(text).toContain("VERY LAST action");
    // T76: the reply mirrors the request language (the instruction itself is EN)
    expect(text).toContain("SAME LANGUAGE as the message");
    expect(text).toContain("mirror the request language");
    // T239 live finding: the folder is the COORDINATOR's to remove — an agent
    // that polls it after its own delete sees the collection window and thinks
    // the exchange dropped the answer.
    expect(text).toContain("REMOVES that folder itself");
    expect(text).toContain("do NOT inspect it afterwards");
    expect(text).toContain("do NOT duplicate your answer through another channel");
    expect(text).not.toContain("READ the message file first"); // it was inlined
    expect(text).not.toContain("send(to="); // file contract replaces the MCP hint
    // the action contract is the TAIL of the input (T57)
    expect(text.trim().endsWith("]")).toBe(true);
    expect(text.indexOf("привет")).toBeLessThan(text.indexOf("full message:"));
  });

  test("long payload: text NOT inlined, explicit read-the-file marker", () => {
    const long = "х".repeat(2000);
    const text = defaultRender(msg({ payload: long }), { messageFile: FILE });
    expect(text).not.toContain(long);
    expect(text).toContain("READ the message file first");
    expect(text).toContain(`full message: ${FILE}`);
  });

  test("the inline threshold is configurable (adapter detail)", () => {
    const render = makeDefaultRender({ inlineMaxChars: 3 });
    expect(render(msg({ payload: "abcd" }), { messageFile: FILE })).toContain(
      "READ the message file first",
    );
    expect(render(msg({ payload: "abc" }), { messageFile: FILE })).toContain("abc");
  });

  test("attachment lines always render inline — message.json has opaque refs (FR-43)", () => {
    const render = makeDefaultRender({ blobsDir: "/q/blobs" });
    const payload = { text: "х".repeat(2000), blobs: [{ blob: "b1", name: "a.png" }] };
    const text = render(msg({ payload }), { messageFile: FILE });
    expect(text).toContain("[attachment] a.png → /q/blobs/b1"); // resolved path inline
    expect(text).toContain("READ the message file first"); // text itself is in the file
  });

  test("without a render context the legacy MCP-hint shape is unchanged", () => {
    const text = defaultRender(msg({ payload: "hello" }));
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).not.toContain("reply.md");
  });
});

// --- T261 (FR-156/FR-157, §13.6): the compact MCP reply contract ---------------

describe("compact MCP reply contract (§13.6, FR-156)", () => {
  const FILE = "/work/.muxeon/inbox/abc-123/message.json";

  test("replyVia mcp: one send call, and it is stated to end the turn", () => {
    const text = defaultRender(msg({ payload: "привет" }), {
      messageFile: FILE,
      replyVia: "mcp",
    });
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("привет");
    // The file is still named: message.json is materialized in BOTH forms, and a
    // long payload lives only there (the hybrid rule §13.2).
    expect(text).toContain(`full message: ${FILE}`);
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).toContain("ENDS YOUR TURN");
    // T76 holds in both forms — the wrapper is EN, the answer mirrors the request.
    expect(text).toContain("SAME LANGUAGE as the message");
    // the action contract is still the TAIL of the input (T57)
    expect(text.trim().endsWith("]")).toBe(true);
    expect(text.indexOf("привет")).toBeLessThan(text.indexOf("full message:"));
  });

  test("exactly ONE reply path is named — the file steps are forbidden, not offered", () => {
    const text = defaultRender(msg(), { messageFile: FILE, replyVia: "mcp" });
    // T239: an instruction offering a fallback gets both paths used and the
    // sender receives the answer twice (§10.29). reply.md and the deletion may
    // appear ONLY as prohibitions.
    expect(text).toContain("Do NOT write reply.md");
    expect(text).toContain("do NOT delete message.json");
    expect(text).not.toContain("FIRST write your answer");
    expect(text).not.toContain("VERY LAST action");
  });

  test("the compact form is materially shorter than the file contract", () => {
    const mcp = defaultRender(msg(), { messageFile: FILE, replyVia: "mcp" });
    const file = defaultRender(msg(), { messageFile: FILE });
    expect(mcp.length).toBeLessThan(file.length);
  });

  test("a long payload still gets the read-the-file marker", () => {
    const text = defaultRender(msg({ payload: "х".repeat(2000) }), {
      messageFile: FILE,
      replyVia: "mcp",
    });
    expect(text).toContain("READ the message file first");
    expect(text).toContain('send(to="researcher"');
  });

  test("absent or explicit exchange ⇒ the file contract, unchanged", () => {
    for (const ctx of [{ messageFile: FILE }, { messageFile: FILE, replyVia: "exchange" as const }])
      expect(defaultRender(msg(), ctx)).toBe(defaultRender(msg(), { messageFile: FILE }));
    expect(defaultRender(msg(), { messageFile: FILE })).toContain("DELETE message.json");
  });
});

// --- T48 (FR-43, §12.5): blob refs render as local paths -----------------------

describe("blob attachment rendering (T48, FR-43, §12.5)", () => {
  const blobPayload = {
    text: "see the photo",
    blobs: [{ blob: "b-1", name: "photo.jpg", mime: "image/jpeg", size: 11 }],
  };

  test("with blobsDir the ref renders as a resolved local path + name/mime", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: blobPayload }));
    expect(text).toContain("see the photo");
    expect(text).toContain("[attachment] photo.jpg (image/jpeg) → /queue/blobs/b-1");
  });

  test("without blobsDir the ref stays an opaque id (baseline shape)", () => {
    const text = defaultRender(msg({ payload: blobPayload }));
    expect(text).toContain("[attachment] photo.jpg (image/jpeg) → b-1");
    expect(text).not.toContain("/queue/blobs");
  });

  test("blobs-only payload renders attachment lines without a text part", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: { blobs: [{ blob: "b-2" }] } }));
    expect(text).toContain("[attachment] b-2 → /queue/blobs/b-2");
  });

  test("string refs and malformed refs degrade safely", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    expect(render(msg({ payload: { blobs: ["plain-id"] } }))).toContain("/queue/blobs/plain-id");
    expect(render(msg({ payload: { blobs: [42, null] } }))).not.toContain("[attachment]");
  });

  test("a hostile id never becomes a path — printed as-is (§8.7 defense)", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: { blobs: [{ blob: "../../etc/passwd" }] } }));
    expect(text).toContain("→ ../../etc/passwd"); // the raw ref, NOT a joined path
    expect(text).not.toContain("/queue/blobs/..");
    const hidden = render(msg({ payload: { blobs: [{ blob: ".ssh" }] } }));
    expect(hidden).not.toContain("/queue/blobs/.ssh");
  });

  test("text-only messages are untouched by the extension (baseline regression)", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    expect(render(msg({ payload: "just text" }))).toBe(
      defaultRender(msg({ payload: "just text" })),
    );
  });
});
