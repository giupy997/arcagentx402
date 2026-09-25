/**
 * The replay store for a seller without a database: settled proofs in a local file, one line each, written
 * before the proof is accepted and read back at start, so a restart does not let a proof in twice. Keys are
 * dropped only once their keep-until time has passed, when the file is rewritten.
 *
 * One process per file: a second process would not see the first one's claims while both run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReplayStore } from "./lnbtc.js";

const nowUnix = () => Math.floor(Date.now() / 1000);

export class FileReplayStore implements ReplayStore {
  private readonly keys = new Map<string, number>();
  private sinceCompaction = 0;

  constructor(
    readonly path: string,
    private readonly now: () => number = nowUnix,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const { key, keepUntil } = JSON.parse(line) as { key?: unknown; keepUntil?: unknown };
          if (typeof key === "string" && typeof keepUntil === "number") this.keys.set(key, Math.max(keepUntil, this.keys.get(key) ?? 0));
        } catch {
          // A line cut short by a crash names no proof that was accepted: its claim never returned.
        }
      }
    }
    this.compact();
  }

  async claim(key: string, keepUntilUnix: number): Promise<boolean> {
    // No await between the check and the write: within this process, two claims of one key cannot both pass.
    if (this.keys.has(key)) return false;
    appendFileSync(this.path, `${JSON.stringify({ key, keepUntil: keepUntilUnix })}\n`, { mode: 0o600 });
    this.keys.set(key, keepUntilUnix);
    if (++this.sinceCompaction >= 1000) this.compact();
    return true;
  }

  /** How many proofs are remembered. */
  get size(): number {
    return this.keys.size;
  }

  private compact(): void {
    const now = this.now();
    for (const [k, until] of this.keys) if (until < now) this.keys.delete(k);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, [...this.keys].map(([key, keepUntil]) => `${JSON.stringify({ key, keepUntil })}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.sinceCompaction = 0;
  }
}
