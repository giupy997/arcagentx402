import { getState, setState, type Db } from "./db/index.js";
import type { Logger } from "./log.js";
import type { RpcPool } from "./rpc/pool.js";
import type { RpcBlock } from "./rpc/types.js";

/**
 * Safety checks before ingesting anything:
 *  1. every endpoint must answer eth_chainId == configured chain id, or it is disabled
 *     (a misconfigured provider URL silently serving testnet would poison a mainnet dataset);
 *  2. all healthy endpoints must agree on the genesis (block 0) hash;
 *  3. the DB, once bound to a genesis hash, refuses any other chain.
 */
export async function verifyChain(pool: RpcPool, db: Db, expectedChainId: number, log: Logger): Promise<{ genesisHash: string }> {
  const genesisHashes = new Map<string, string>();
  await Promise.all(
    pool.endpoints.map(async (e) => {
      try {
        const r = await pool.batch<string | RpcBlock | null>(
          [
            { method: "eth_chainId", params: [] },
            { method: "eth_getBlockByNumber", params: ["0x0", false] },
          ],
          { only: e.url, maxAttempts: 2 },
        );
        const cid = r.outcomes[0]!;
        const gen = r.outcomes[1]!;
        if (!cid.ok) throw new Error(`eth_chainId error: ${cid.error.message}`);
        const got = Number(BigInt(cid.result as string));
        if (got !== expectedChainId) {
          pool.disable(e.url, `chain id mismatch: endpoint says ${got}, expected ${expectedChainId}`);
          return;
        }
        if (!gen.ok || !gen.result) throw new Error("genesis block unavailable");
        genesisHashes.set(e.url, (gen.result as RpcBlock).hash.toLowerCase());
        log.info({ endpoint: e.name, chainId: got, genesis: (gen.result as RpcBlock).hash }, "endpoint verified");
      } catch (err) {
        log.warn({ endpoint: e.name, err: (err as Error).message }, "endpoint verification failed (kept, will be retried by the pool)");
      }
    }),
  );
  const distinct = new Set(genesisHashes.values());
  if (distinct.size === 0) throw new Error("no endpoint could be verified: refusing to start");
  if (distinct.size > 1) {
    throw new Error(`endpoints disagree on genesis hash: ${JSON.stringify([...genesisHashes.entries()].map(([u, h]) => [pool.endpoints.find((e) => e.url === u)?.name, h]))}`);
  }
  const genesisHash = [...distinct][0]!;
  // Endpoints that answered the chain id but not the genesis are fine; endpoints that answered
  // a different genesis are impossible here (distinct.size === 1), so nothing else to disable.
  const bound = await getState<{ genesisHash: string; chainId: number }>(db, "chain");
  if (bound) {
    if (bound.genesisHash !== genesisHash || bound.chainId !== expectedChainId) {
      throw new Error(`database is bound to chain ${bound.chainId} genesis ${bound.genesisHash}, but RPCs serve chain ${expectedChainId} genesis ${genesisHash}. Refusing to mix chains.`);
    }
  } else {
    await setState(db, "chain", { genesisHash, chainId: expectedChainId, boundAt: new Date().toISOString() });
    log.info({ genesisHash, chainId: expectedChainId }, "database bound to chain");
  }
  return { genesisHash };
}
