import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileReplayStore } from "../src/file-replay.js";

const dir = () => join(mkdtempSync(join(tmpdir(), "lnbtc-replay-")), "sub", "replay.jsonl");

describe("remembering settled proofs in a file", () => {
  it("claims a key once, and still refuses it after a restart", async () => {
    const path = dir();
    const a = new FileReplayStore(path, () => 1_000);
    expect(await a.claim("lnbtc:x:aa", 5_000)).toBe(true);
    expect(await a.claim("lnbtc:x:aa", 5_000)).toBe(false);
    const b = new FileReplayStore(path, () => 2_000);
    expect(await b.claim("lnbtc:x:aa", 5_000)).toBe(false);
    expect(await b.claim("lnbtc:x:bb", 5_000)).toBe(true);
  });

  it("forgets a key only after its keep-until time, and skips a line a crash cut short", async () => {
    const path = dir();
    const a = new FileReplayStore(path, () => 1_000);
    await a.claim("old", 1_500);
    await a.claim("new", 9_000);
    appendFileSync(path, '{"key":"half');
    const b = new FileReplayStore(path, () => 2_000);
    expect(b.size).toBe(1);
    expect(await b.claim("new", 9_000)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"key":"new","keepUntil":9000}\n');
  });
});
