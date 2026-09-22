/**
 * Makes a Solana key, or reads one, and prints only its address.
 *   npx tsx scripts/solana-key.mts .secrets/solana-seller.key
 * The file holds the 32-byte seed as hex, mode 600, and is never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

export async function solanaSigner(path: string) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  }
  return createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(readFileSync(path, "utf8").trim(), "hex")));
}

if (process.argv[1]?.endsWith("solana-key.mts")) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: solana-key.mts <key file>");
  console.log((await solanaSigner(path)).address);
}
