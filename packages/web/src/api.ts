export const API_BASE: string = (window as unknown as { ARCRAIL_API?: string }).ARCRAIL_API ?? "";

/** Thrown when there is no API behind the site (e.g. static hosting without ARCRAIL_API_URL). */
export class ApiUnavailable extends Error {
  override readonly name = "ApiUnavailable";
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiUnavailable("network error");
  }
  const type = res.headers.get("content-type") ?? "";
  // Static hosts answer unknown paths with an HTML 404 page: that means "no API here", not a data error.
  if (res.status === 404 || !type.includes("application/json")) throw new ApiUnavailable(`${path}: no API`);
  if (!res.ok && res.status !== 503) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Network {
  network: string;
  chainId: number;
  head: { number: number; timestamp: number; ageSeconds: number } | null;
  chainHead: number | null;
  lagBlocks: number | null;
  blockTimeSeconds: number | null;
  txPerSecond: number | null;
  finality: { p50Seconds: number | null; p95Seconds: number | null; samples: number };
  totals: { blocks: number; transactions: number; deploys: number };
  collector: { lastBlockAgeSeconds: number | null; gapsOpen: number };
}
export interface Fees {
  current: { baseFeeGwei: number; nextBaseFeeGwei: number | null; blockNumber: number } | null;
  floorGwei: number;
  costNow: { nativeTransferUsdc: string; erc20TransferUsdc: string } | null;
  last24h: { minGwei: number | null; maxGwei: number | null; avgUtilization: number | null } | null;
  series: Array<{ t: number; baseFeeGwei: number; utilization: number; blocks: number }>;
  byOperation: Array<{ op: string; count: number; medianFeeUsdc: string | null; p90FeeUsdc: string | null; failed: number }>;
}
export interface Activity {
  windowMinutes: number;
  txPerMinute: Array<{ t: number; txs: number; blocks: number }>;
  failureRate: number | null;
  txCount: number;
  topSelectors: Array<{ selector: string | null; count: number; name: string | null }>;
  topLogEmitters: Array<{ address: string | null; label: string | null; protocol: string | null; count: number }>;
}
export interface Deploys {
  recent: Array<{ address: string; deployer: string; blockNumber: number; timestamp: number; txHash: string; initCodeSize: number; runtimeCodeSize: number | null; success: boolean; label: string | null; protocol: string | null }>;
  perHour: Array<{ t: number; deploys: number; deployers: number }>;
}
export type Rpc = Array<{ endpoint: string; probes: number; rttAvgMs: number; rttP95Ms: number; probeErrors: number; callErrors: number; avgLagBlocks: number | null; maxLatest: number | null; lastSeen: string }>;

export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
export const fmtCompact = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n));
export const fmtUsdc = (s: string | null | undefined): string => {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};
export const fmtGwei = (g: number | null | undefined): string => (g === null || g === undefined ? "—" : `${g < 100 ? g.toFixed(g % 1 === 0 ? 0 : 2) : Math.round(g).toLocaleString("en-US")} gwei`);
export const fmtSec = (s: number | null | undefined, d = 2): string => (s === null || s === undefined ? "—" : `${s.toFixed(d)} s`);
export const fmtPct = (r: number | null | undefined, d = 1): string => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(d)}%`);
export const short = (h: string | null | undefined, n = 6): string => (h ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : "—");
export const ago = (unixSec: number): string => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const timeHM = (unixSec: number): string => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function setNetPill(n: Network | null, err = false): void {
  const dot = document.getElementById("netdot");
  const label = document.getElementById("netlabel");
  if (!dot || !label) return;
  if (err || !n) {
    dot.className = "dot bad";
    label.textContent = "API unreachable";
    return;
  }
  const age = n.collector.lastBlockAgeSeconds ?? 9999;
  dot.className = `dot ${age < 30 ? "ok" : age < 300 ? "warn" : "bad"}`;
  label.textContent = `Arc ${n.network}${age >= 30 ? ` · ${age}s old` : " · live"}`;
}
