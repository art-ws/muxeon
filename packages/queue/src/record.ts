// Reading a queue record body (§5.3). Pending/cur/done files are always complete
// JSON — enqueue writes to tmp/ and renames atomically — so a parse here reflects a
// fully-written message.

import { readFile } from "node:fs/promises";
import type { Signal } from "@muxeon/core";

export async function readMessage(path: string): Promise<Signal> {
  return JSON.parse(await readFile(path, { encoding: "utf8" })) as Signal;
}
