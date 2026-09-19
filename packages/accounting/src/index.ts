/**
 * @cra-agent/accounting
 *
 * The ONLY module in the repo allowed to do arithmetic on raw USDC amounts.
 *
 * Arc represents one USDC balance through two interfaces:
 *   - ERC-20 interface at the USDC contract: 6 decimals  -> `Usdc6`  (1 USDC = 1_000_000n)
 *   - native / gas interface:                 18 decimals -> `Usdc18` (1 USDC = 10n ** 18n)
 * They are NOT two pools. Converting 18 -> 6 truncates the last 12 digits; that dust is real
 * value that still sits in the native balance, so every 18 -> 6 conversion here returns the
 * remainder explicitly (or throws) instead of dropping it silently.
 *
 * Verified against docs.arc.io/arc/references/evm-differences (2026-09-14):
 *   "USDC on Arc has two interfaces that share one balance: a native interface (18 decimals)
 *    and an ERC-20 interface (6 decimals)". ERC-20 balanceOf truncates; zero balanceOf does not
 *    mean zero native balance.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Amount in ERC-20 USDC units (6 decimals). */
export type Usdc6 = Brand<bigint, "Usdc6">;
/** Amount in native / gas USDC units (18 decimals, "wei-like"). */
export type Usdc18 = Brand<bigint, "Usdc18">;

export const USDC6_DECIMALS = 6 as const;
export const USDC18_DECIMALS = 18 as const;
/** 10^12: multiplier from 6-decimal units to 18-decimal units. */
export const SCALE_6_TO_18 = 10n ** 12n;
export const ONE_USDC_6 = 10n ** 6n as Usdc6;
export const ONE_USDC_18 = 10n ** 18n as Usdc18;
export const GWEI = 10n ** 9n;

export class AccountingError extends Error {
  override readonly name = "AccountingError";
}

function assertBigInt(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new AccountingError(`${what}: expected bigint, got ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Constructors (the only way to obtain a branded value from a raw bigint)
// ---------------------------------------------------------------------------

/** Wrap a raw 6-decimal integer amount. Negative values are allowed (ledger deltas). */
export function usdc6(raw: bigint): Usdc6 {
  assertBigInt(raw, "usdc6");
  return raw as Usdc6;
}

/** Wrap a raw 18-decimal integer amount. Negative values are allowed (ledger deltas). */
export function usdc18(raw: bigint): Usdc18 {
  assertBigInt(raw, "usdc18");
  return raw as Usdc18;
}

/** Parse a JSON-RPC hex quantity ("0x1a") into a bigint. Rejects malformed input. */
export function hexQuantityToBigInt(hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new AccountingError(`hexQuantityToBigInt: malformed quantity ${String(hex)}`);
  }
  return BigInt(hex);
}

export function usdc18FromHex(hex: string): Usdc18 {
  return usdc18(hexQuantityToBigInt(hex));
}
export function usdc6FromHex(hex: string): Usdc6 {
  return usdc6(hexQuantityToBigInt(hex));
}

// ---------------------------------------------------------------------------
// Conversions between the two representations
// ---------------------------------------------------------------------------

/** 6 -> 18 decimals. Always exact. */
export function toUsdc18(amount: Usdc6): Usdc18 {
  return (amount * SCALE_6_TO_18) as Usdc18;
}

export interface Usdc6Split {
  /** The part representable with 6 decimals (rounded toward zero). */
  readonly usdc6: Usdc6;
  /** The dust below 1e-6 USDC, still in 18-decimal units. Same sign as the input. |dust| < 1e12. */
  readonly dust18: Usdc18;
}

/**
 * 18 -> 6 decimals, truncating toward zero, returning the dust explicitly.
 * Invariant: toUsdc18(split.usdc6) + split.dust18 === amount.
 */
export function splitUsdc18(amount: Usdc18): Usdc6Split {
  const q = amount / SCALE_6_TO_18; // bigint division truncates toward zero
  const r = amount % SCALE_6_TO_18; // same sign as dividend
  return { usdc6: q as Usdc6, dust18: r as Usdc18 };
}

/** 18 -> 6 decimals; throws if any dust would be lost. */
export function toUsdc6Exact(amount: Usdc18): Usdc6 {
  const { usdc6: q, dust18 } = splitUsdc18(amount);
  if (dust18 !== 0n) {
    throw new AccountingError(`toUsdc6Exact: ${amount} has sub-micro dust ${dust18}`);
  }
  return q;
}

/** 18 -> 6 decimals, truncating toward zero. Use only where dropping dust is intended. */
export function toUsdc6Floor(amount: Usdc18): Usdc6 {
  return splitUsdc18(amount).usdc6;
}

/** 18 -> 6 decimals, rounding half away from zero. */
export function toUsdc6Rounded(amount: Usdc18): Usdc6 {
  const { usdc6: q, dust18 } = splitUsdc18(amount);
  const half = SCALE_6_TO_18 / 2n;
  if (dust18 >= half) return (q + 1n) as Usdc6;
  if (dust18 <= -half) return (q - 1n) as Usdc6;
  return q;
}

// ---------------------------------------------------------------------------
// Arithmetic (kept trivial on purpose; the value is in the branding)
// ---------------------------------------------------------------------------

export function addUsdc6(a: Usdc6, b: Usdc6): Usdc6 {
  return (a + b) as Usdc6;
}
export function subUsdc6(a: Usdc6, b: Usdc6): Usdc6 {
  return (a - b) as Usdc6;
}
/** What is left under a cap once `used` is taken out. Never negative: an overspent cap has nothing left, not a debt. */
export function headroomUsdc6(cap: Usdc6, used: Usdc6): Usdc6 {
  return (cap > used ? cap - used : 0n) as Usdc6;
}
export function addUsdc18(a: Usdc18, b: Usdc18): Usdc18 {
  return (a + b) as Usdc18;
}
export function subUsdc18(a: Usdc18, b: Usdc18): Usdc18 {
  return (a - b) as Usdc18;
}
export function sumUsdc6(values: Iterable<Usdc6>): Usdc6 {
  let acc = 0n;
  for (const v of values) acc += v;
  return acc as Usdc6;
}
export function sumUsdc18(values: Iterable<Usdc18>): Usdc18 {
  let acc = 0n;
  for (const v of values) acc += v;
  return acc as Usdc18;
}
export function compareUsdc6(a: Usdc6, b: Usdc6): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function compareUsdc18(a: Usdc18, b: Usdc18): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare across representations without losing precision: lifts the 6-decimal side to 18.
 */
export function compareMixed(a6: Usdc6, b18: Usdc18): -1 | 0 | 1 {
  return compareUsdc18(toUsdc18(a6), b18);
}

// ---------------------------------------------------------------------------
// Gas / fees. Gas is priced in 18-decimal USDC on Arc (the "wei" of the chain).
// ---------------------------------------------------------------------------

/** Fee actually paid by a transaction: gasUsed * effectiveGasPrice, in 18-decimal USDC. */
export function txFee18(gasUsed: bigint, effectiveGasPrice: bigint): Usdc18 {
  assertBigInt(gasUsed, "txFee18.gasUsed");
  assertBigInt(effectiveGasPrice, "txFee18.effectiveGasPrice");
  if (gasUsed < 0n || effectiveGasPrice < 0n) {
    throw new AccountingError("txFee18: negative gas inputs");
  }
  return (gasUsed * effectiveGasPrice) as Usdc18;
}

/** Same as txFee18 but straight from receipt hex fields. */
export function txFee18FromReceipt(receipt: {
  gasUsed: string;
  effectiveGasPrice: string;
}): Usdc18 {
  return txFee18(
    hexQuantityToBigInt(receipt.gasUsed),
    hexQuantityToBigInt(receipt.effectiveGasPrice),
  );
}

/** Gas price expressed in gwei (1e9 of the 18-decimal unit) -> 18-decimal USDC per gas. */
export function gweiToUsdc18(gwei: bigint): Usdc18 {
  assertBigInt(gwei, "gweiToUsdc18");
  return (gwei * GWEI) as Usdc18;
}

// ---------------------------------------------------------------------------
// Parsing / formatting of human decimal strings. No floats anywhere.
// ---------------------------------------------------------------------------

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

function parseDecimalToUnits(text: string, decimals: number, what: string): bigint {
  if (typeof text !== "string") throw new AccountingError(`${what}: expected string`);
  const m = DECIMAL_RE.exec(text.trim());
  if (!m) throw new AccountingError(`${what}: malformed decimal "${text}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] ?? "0";
  const fracPart = m[3] ?? "";
  if (fracPart.length > decimals) {
    throw new AccountingError(
      `${what}: "${text}" has ${fracPart.length} fractional digits, max ${decimals}`,
    );
  }
  const units = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart.padEnd(decimals, "0") || "0");
  return sign * units;
}

function formatUnitsToDecimal(units: bigint, decimals: number, opts?: FormatOptions): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const intPart = (abs / base).toString();
  let frac = (abs % base).toString().padStart(decimals, "0");
  const minFrac = opts?.minFractionDigits ?? 0;
  const maxFrac = opts?.maxFractionDigits ?? decimals;
  if (maxFrac < decimals) frac = frac.slice(0, maxFrac); // truncate, never round: formatting is display only
  frac = frac.replace(/0+$/, "");
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, "0");
  const body = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  return negative ? `-${body}` : body;
}

export interface FormatOptions {
  readonly minFractionDigits?: number;
  readonly maxFractionDigits?: number;
}

/** "1.25" -> 1_250_000n (Usdc6). Rejects more than 6 fractional digits. */
export function parseUsdc6(text: string): Usdc6 {
  return parseDecimalToUnits(text, USDC6_DECIMALS, "parseUsdc6") as Usdc6;
}
/** "1.25" -> 1_250_000_000_000_000_000n (Usdc18). Accepts up to 18 fractional digits. */
export function parseUsdc18(text: string): Usdc18 {
  return parseDecimalToUnits(text, USDC18_DECIMALS, "parseUsdc18") as Usdc18;
}
/** Usdc6 -> human decimal string, exact (no float). */
export function formatUsdc6(amount: Usdc6, opts?: FormatOptions): string {
  return formatUnitsToDecimal(amount, USDC6_DECIMALS, opts);
}
/** Usdc18 -> human decimal string, exact (no float). Pass maxFractionDigits to shorten. */
export function formatUsdc18(amount: Usdc18, opts?: FormatOptions): string {
  return formatUnitsToDecimal(amount, USDC18_DECIMALS, opts);
}

/** Decimal string for SQL numeric(78,0) columns. */
export function toSqlNumeric(amount: Usdc6 | Usdc18 | bigint): string {
  assertBigInt(amount, "toSqlNumeric");
  return amount.toString(10);
}
