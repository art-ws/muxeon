import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blobExtension,
  blobsDir,
  ensureBlobDirs,
  readBlob,
  resolveBlobPath,
  writeBlob,
} from "../src/blobs";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "muxeon-blobs-"));
  await ensureBlobDirs(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("blob store + realpath-containment (§5.3, §8.7, §10.11)", () => {
  test("writeBlob returns an opaque id (not a path); readBlob round-trips bytes", async () => {
    const id = await writeBlob(root, new TextEncoder().encode("hello blob"));
    expect(id).not.toContain("/");
    expect(id).not.toContain("..");
    expect(new TextDecoder().decode(await readBlob(root, id))).toBe("hello blob");
  });

  test("distinct writes get distinct ids", async () => {
    const a = await writeBlob(root, new Uint8Array([1]));
    const b = await writeBlob(root, new Uint8Array([1]));
    expect(a).not.toBe(b);
  });

  test("an extension suffixes the id and the stored file (T117); junk ext is dropped", async () => {
    const id = await writeBlob(root, new Uint8Array([2]), "png");
    expect(id.endsWith(".png")).toBe(true);
    expect(new Uint8Array(await readBlob(root, id))).toEqual(new Uint8Array([2]));
    expect(resolveBlobPath(root, id).endsWith(".png")).toBe(true); // the FILE has the ext

    for (const junk of ["", ".", "p/ng", "..", "p.ng", "verylongext"]) {
      const plain = await writeBlob(root, new Uint8Array([3]), junk);
      expect(plain).not.toContain("."); // unsafe ext → the historical shape
    }
  });

  test("blobExtension: the name's extension wins, mime maps, junk → undefined (T117)", () => {
    expect(blobExtension("photo.PNG", "application/pdf")).toBe("png");
    expect(blobExtension("archive.tar.gz")).toBe("gz");
    expect(blobExtension("noext", "image/jpeg")).toBe("jpg");
    expect(blobExtension(undefined, "image/png; charset=binary")).toBe("png");
    expect(blobExtension(".hidden")).toBeUndefined(); // a leading dot is not an extension
    expect(blobExtension("trailing.")).toBeUndefined();
    expect(blobExtension("a.we|rd")).toBeUndefined();
    expect(blobExtension(undefined, "application/x-unknown")).toBeUndefined();
    expect(blobExtension()).toBeUndefined();
  });

  test("dotted ids resolve; hidden/multi-dot ids are rejected (T117)", async () => {
    writeFileSync(join(blobsDir(root), "ok-id.png"), "x");
    expect(resolveBlobPath(root, "ok-id.png")).toContain("ok-id.png");
    for (const bad of [".hidden", "a..png", "a.b.c", "a.", "a.png/../b"]) {
      expect(() => resolveBlobPath(root, bad)).toThrow();
    }
  });

  test("rejects path traversal in the id (..)", async () => {
    writeFileSync(join(root, "secret.txt"), "TOP SECRET");
    expect(() => resolveBlobPath(root, "../secret.txt")).toThrow();
    await expect(readBlob(root, "../secret.txt")).rejects.toThrow();
  });

  test("rejects an absolute-path id", () => {
    expect(() => resolveBlobPath(root, "/etc/passwd")).toThrow();
  });

  test("rejects a separator in the id", () => {
    expect(() => resolveBlobPath(root, "sub/evil")).toThrow();
  });

  test("rejects a symlink blob pointing outside <root>/blobs/ (§10.11)", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOP SECRET");
    symlinkSync(secret, join(blobsDir(root), "evil")); // blobs/evil -> ../secret.txt
    expect(() => resolveBlobPath(root, "evil")).toThrow(/symlink/);
    await expect(readBlob(root, "evil")).rejects.toThrow();
  });

  test("a missing blob id is rejected", async () => {
    await expect(readBlob(root, "no-such-blob")).rejects.toThrow();
  });
});
