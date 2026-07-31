// §18.7 (FR-138): the wire codec — queue records to frames and back, the
// export-alias mapping on `from`, and the malformed-peer guard.

import { describe, expect, test } from "bun:test";
import type { LinkRecord } from "@teamai/orchestrator";
import { parseFrame, toLinkRecord, toWireFrame } from "../src";

const wireName = (name: string): string => (name === "alex" ? "alexander" : name);

describe("link wire codec (§18.7)", () => {
  test("an envelope round-trips; the local sender travels under its export alias", () => {
    const record: LinkRecord = {
      id: "m1",
      from: "alex",
      to: "dev@b",
      kind: "message",
      ts: 7,
      payload: "hi",
      replyTo: "r0",
      fed: { to: "dev", hops: 0 },
    };
    const frame = toWireFrame(record, wireName);
    expect(frame).toEqual({
      type: "envelope",
      envelope: {
        id: "m1",
        from: "alexander",
        to: "dev",
        kind: "message",
        ts: 7,
        payload: "hi",
        replyTo: "r0",
        hops: 0,
      },
    });
    const parsed = parseFrame(JSON.stringify(frame));
    expect(parsed).not.toBeNull();
    const inbound = toLinkRecord(parsed as NonNullable<typeof parsed>);
    expect(inbound?.ackRef).toBe("m1");
    expect(inbound?.record).toMatchObject({ from: "alexander", fed: { to: "dev", hops: 0 } });
  });

  test("a transit FQN from passes through unaliased (§18.4)", () => {
    const record: LinkRecord = {
      id: "t1",
      from: "alex@hq",
      to: "bob@c",
      kind: "message",
      ts: 1,
      payload: null,
      fed: { to: "bob", hops: 1 },
    };
    const frame = toWireFrame(record, wireName);
    expect(frame).toMatchObject({ envelope: { from: "alex@hq", hops: 1 } });
  });

  test("a receipt round-trips with its own record id for the transfer ack", () => {
    const record: LinkRecord = {
      id: "m1:receipt",
      from: "dev",
      to: "alex@hq",
      kind: "message",
      ts: 2,
      payload: null,
      fed: { to: "alex", hops: 0, receipt: { ref: "m1", code: "WIP_LIMIT", detail: "limit 3" } },
    };
    const frame = toWireFrame(record, (name) => name);
    expect(frame).toEqual({
      type: "receipt",
      receipt: {
        id: "m1:receipt",
        ref: "m1",
        code: "WIP_LIMIT",
        detail: "limit 3",
        from: "dev",
        to: "alex",
        hops: 0,
      },
    });
    const parsed = parseFrame(JSON.stringify(frame));
    const inbound = toLinkRecord(parsed as NonNullable<typeof parsed>);
    expect(inbound?.ackRef).toBe("m1:receipt");
    expect(inbound?.record.fed.receipt).toEqual({
      ref: "m1",
      code: "WIP_LIMIT",
      detail: "limit 3",
    });
  });

  test("malformed wire input parses to null, never a crash (a bad peer)", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "warp" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "ack" }))).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });
});
