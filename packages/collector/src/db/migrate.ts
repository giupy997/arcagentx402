import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { KNOWN_CONTRACTS } from "../seeds/known-contracts.js";
import { createDb, hexToBytes, type Db } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "sql");

export async function migrate(db: Db, network: string): Promise<void> {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => Number(r.version)));
  for (const f of files) {
    const version = Number(f.split("_")[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(SQL_DIR, f), "utf8");
    log.info({ file: f }, "applying migration");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  // Seed labels (idempotent). Only labels: nothing here changes what is collected.
  for (const c of KNOWN_CONTRACTS.filter((c) => c.network === network)) {
    await db.query(
      "INSERT INTO known_contracts (network, address, label, protocol, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (network, address) DO UPDATE SET label = EXCLUDED.label, protocol = EXCLUDED.protocol, source = EXCLUDED.source",
      [c.network, hexToBytes(c.address.toLowerCase()), c.label, c.protocol, c.source],
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl, log);
  migrate(db, cfg.network)
    .then(() => {
      log.info("migrations complete");
      return db.end();
    })
    .catch((err) => {
      log.error({ err }, "migration failed");
      process.exit(1);
    });
}
