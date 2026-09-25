/**
 * USYC on Arc, read from the chain.
 *
 * USYC is Circle's tokenized money market fund, live on Arc since 25 Sep 2026. Its Teller mints and redeems
 * it for USDC at the price an oracle publishes once a business day, and only allowlisted institutions outside
 * the US can hold it. For an agent that comes down to three facts: what one USYC is worth, how fast that
 * grows, and how much USYC exists on Arc. All three are read from the contracts Arc's docs list; the oracle
 * is whichever one the Teller points to, so a change of oracle is followed without a deploy.
 */
import { createPublicClient, fallback, http, parseAbi, type PublicClient } from "viem";

export const USYC_ARC = {
  token: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490",
  teller: "0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b",
  entitlements: "0xb69ecb156Dc0028198028c501340d5367845ca72",
  source: "https://docs.arc.io/arc/references/contract-addresses",
} as const;

const ACCESS = "USYC is open only to institutions outside the United States, allowlisted by Circle, with a $100,000 minimum. The Teller mints and redeems it for USDC at the oracle's price.";

export interface Round {
  readonly round: number;
  /** Unix seconds. */
  readonly at: number;
  /** In the oracle's decimals. */
  readonly price: bigint;
}

export interface UsycView {
  readonly asset: "USYC";
  readonly network: "eip155:5042";
  readonly price: { usd: string; exact: string; round: number; updatedAt: number; oracle: string; description: string } | null;
  readonly growth: { annualized7d: number | null; annualized30d: number | null; sinceFirstRound: { annualized: number; days: number; fromUsd: string } | null; note: string };
  readonly supplyOnArc: string;
  readonly history: ReadonlyArray<{ round: number; at: number; usd: string }>;
  readonly contracts: { token: string; teller: string; entitlements: string; oracle: string };
  readonly access: string;
  readonly source: string;
  readonly readAt: number;
}

/** A fixed-point amount as a decimal string, cut (not rounded) to `places`. */
export function decimal(value: bigint, decimals: number, places = decimals): string {
  const neg = value < 0n;
  const s = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** The change between two rounds, compounded to a year, in percent with two decimals. */
export function annualized(from: Round, to: Round): number | null {
  const seconds = to.at - from.at;
  if (seconds <= 0 || from.price <= 0n) return null;
  const ratio = Number((to.price * 1_000_000_000_000n) / from.price) / 1e12;
  return Math.round(((ratio ** ((365 * 86_400) / seconds)) - 1) * 10_000) / 100;
}

/** The latest round that is at least `days` older than the last one. */
export function roundBefore(rounds: readonly Round[], days: number): Round | null {
  const last = rounds.at(-1);
  if (!last) return null;
  for (let i = rounds.length - 2; i >= 0; i--) if (last.at - rounds[i]!.at >= days * 86_400) return rounds[i]!;
  return null;
}

export function summarize(o: { rounds: readonly Round[]; decimals: number; supply: bigint; tokenDecimals: number; oracle: string; description: string; now: number }): UsycView {
  const rounds = [...o.rounds].sort((a, b) => a.round - b.round);
  const last = rounds.at(-1) ?? null;
  const first = rounds[0] ?? null;
  const over = (days: number) => {
    const from = roundBefore(rounds, days);
    return from && last ? annualized(from, last) : null;
  };
  const since = first && last && last.at > first.at ? annualized(first, last) : null;
  return {
    asset: "USYC",
    network: "eip155:5042",
    price: last ? { usd: decimal(last.price, o.decimals, 6), exact: decimal(last.price, o.decimals), round: last.round, updatedAt: last.at, oracle: o.oracle, description: o.description } : null,
    growth: {
      annualized7d: over(7),
      annualized30d: over(30),
      sinceFirstRound: since !== null && first && last ? { annualized: since, days: Math.round(((last.at - first.at) / 86_400) * 10) / 10, fromUsd: decimal(first.price, o.decimals, 6) } : null,
      note: "How fast the price grew over the window, compounded to a year, in percent: the fund's return after its fees, as the price shows it. Past growth, not a promise.",
    },
    supplyOnArc: decimal(o.supply, o.tokenDecimals),
    history: rounds.map((r) => ({ round: r.round, at: r.at, usd: decimal(r.price, o.decimals, 9) })),
    contracts: { token: USYC_ARC.token, teller: USYC_ARC.teller, entitlements: USYC_ARC.entitlements, oracle: o.oracle },
    access: ACCESS,
    source: USYC_ARC.source,
    readAt: o.now,
  };
}

const TELLER = parseAbi(["function oracle() view returns (address)"]);
const ORACLE = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)"]);
const ERC20 = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);

/**
 * Reads USYC on Arc at most every `ttlMs`. Rounds already published never change, so they are kept and only
 * new ones are asked for; a read that fails leaves the last good view in place.
 */
export function usycReader(rpcUrls: readonly string[], o: { ttlMs?: number; client?: PublicClient } = {}) {
  const client = o.client ?? (createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 15_000, retryCount: 1 }))) }) as PublicClient);
  const ttl = o.ttlMs ?? 300_000;
  const rounds = new Map<string, Map<number, Round>>();
  let view: UsycView | null = null;
  let at = 0;
  let pending: Promise<UsycView> | null = null;

  const load = async (): Promise<UsycView> => {
    const oracle = await client.readContract({ address: USYC_ARC.teller, abi: TELLER, functionName: "oracle" });
    const [latest, decimals, description, supply, tokenDecimals] = await Promise.all([
      client.readContract({ address: oracle, abi: ORACLE, functionName: "latestRoundData" }),
      client.readContract({ address: oracle, abi: ORACLE, functionName: "decimals" }),
      client.readContract({ address: oracle, abi: ORACLE, functionName: "description" }).catch(() => "USYC / USD"),
      client.readContract({ address: USYC_ARC.token, abi: ERC20, functionName: "totalSupply" }),
      client.readContract({ address: USYC_ARC.token, abi: ERC20, functionName: "decimals" }),
    ]);
    const known = rounds.get(oracle) ?? new Map<number, Round>();
    rounds.set(oracle, known);
    const last = Number(latest[0]);
    const missing: number[] = [];
    for (let r = 1; r <= last; r++) if (!known.has(r)) missing.push(r);
    // A few at a time: the public endpoints refuse bursts.
    for (let i = 0; i < missing.length; i += 8) {
      const got = await Promise.all(missing.slice(i, i + 8).map((r) => client.readContract({ address: oracle, abi: ORACLE, functionName: "getRoundData", args: [BigInt(r)] }).catch(() => null)));
      for (const d of got) if (d && d[3] > 0n && d[1] > 0n) known.set(Number(d[0]), { round: Number(d[0]), at: Number(d[3]), price: d[1] });
    }
    return summarize({ rounds: [...known.values()], decimals: Number(decimals), supply, tokenDecimals: Number(tokenDecimals), oracle, description, now: Math.floor(Date.now() / 1000) });
  };

  return {
    async read(): Promise<UsycView> {
      if (view && Date.now() - at < ttl) return view;
      pending ??= load()
        .then((v) => {
          view = v;
          at = Date.now();
          return v;
        })
        .finally(() => {
          pending = null;
        });
      // A stale view beats none while the chain is slow to answer.
      return view ? pending.catch(() => view!) : pending;
    },
  };
}

export type UsycReader = ReturnType<typeof usycReader>;
