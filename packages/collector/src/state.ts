import type { RpcPool } from "./rpc/pool.js";

/** In-memory runtime status shared by workers and the health server. */
export class RuntimeState {
  chainHead: number | null = null;
  chainHeadAt: number | null = null;
  headCursor: number | null = null; // highest block the head worker has fully committed (contiguous from its start)
  headStart: number | null = null;
  lastIngestAt: number | null = null;
  blocksIngested = 0;
  txsIngested = 0;
  backfill: { cursor: number; target: number; active: boolean } | null = null;
  gapsOpen = 0;
  revertsPending = 0;
  startedAt = Date.now();
  genesisHash: string | null = null;
  errors = 0;

  constructor(readonly pool: RpcPool) {}

  lag(): number | null {
    if (this.chainHead === null || this.headCursor === null) return null;
    return this.chainHead - this.headCursor;
  }
}
