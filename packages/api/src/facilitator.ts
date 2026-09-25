/**
 * The facilitator, opened to sellers who register.
 *
 * The facilitator itself listens on localhost and knows nothing about signatures; it takes an
 * address from this process and settles for it, within a daily allowance, because every
 * settlement costs it gas. What this module adds is the proof: a seller registers by signing a
 * message with the wallet that gets paid, so nobody can enrol someone else's address. The three
 * protocol routes are reached from outside through /facilitator/*, passed through unchanged.
 *
 * Lightning (`exact` on `lnbtc`) is settled here, in this process, for anyone: it needs no gas and no
 * key, only the proof check and the replay store in our database (facilitator-lnbtc.ts).
 */
import type { Context, Hono } from "hono";
import type { Logger } from "pino";
import { verifyMessage } from "viem";
import { PgReplayStore } from "@cra-agent/lightning";
import type { Db } from "./db.js";
import { registrationMessage, REGISTRATION_MAX_AGE_MS } from "./facilitator-message.js";
import { isLnbtcBody, lnbtcFacilitator, type LnbtcFacilitator } from "./facilitator-lnbtc.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Upstream = (path: string, init?: RequestInit) => Promise<Response>;

/** Where a client comes from, as our reverse proxy says: the key for pacing. */
const clientOf = (c: Context): string => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";

/**
 * The protocol from outside: /supported, /verify and /settle. A Lightning body is answered here; any other
 * goes to the facilitator on this host, when there is one. Only small bodies, not too often.
 */
export function mountFacilitatorProtocol(app: Hono, o: { upstream: Upstream | null; lnbtc: LnbtcFacilitator | null }): void {
  const calls = new Map<string, number[]>();
  const tooMany = (c: Context): boolean => {
    const ip = clientOf(c);
    const recent = (calls.get(ip) ?? []).filter((t) => Date.now() - t < 60_000);
    if (calls.size > 10_000) calls.clear();
    calls.set(ip, [...recent, Date.now()]);
    return recent.length >= 240;
  };
  const forward = async (path: string, init?: RequestInit): Promise<Response> => {
    if (!o.upstream) return Response.json({ error: "only Lightning (lnbtc) is settled here" }, { status: 404 });
    try {
      const res = await o.upstream(path, init);
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    } catch {
      return Response.json({ error: "the facilitator is not answering" }, { status: 503 });
    }
  };

  app.get("/facilitator/supported", async (c) => {
    if (tooMany(c)) return c.json({ error: "too many requests" }, 429);
    let arc: { kinds?: unknown[]; extensions?: unknown[]; signers?: Record<string, unknown> } = {};
    if (o.upstream) {
      try {
        const res = await o.upstream("/supported");
        if (res.ok) arc = (await res.json()) as typeof arc;
      } catch {
        arc = {};
      }
    }
    // Lightning is listed even when the Arc facilitator is down: nothing it needs is there.
    return c.json({ kinds: [...(arc.kinds ?? []), ...(o.lnbtc?.kinds ?? [])], extensions: arc.extensions ?? [], signers: arc.signers ?? {} });
  });

  for (const route of ["verify", "settle"] as const) {
    app.post(`/facilitator/${route}`, async (c) => {
      if (tooMany(c)) return c.json({ error: "too many requests" }, 429);
      const body = await c.req.text();
      if (body.length > 65_536) return c.json({ error: "body too large" }, 413);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      if (o.lnbtc && isLnbtcBody(parsed)) {
        const a = route === "verify" ? o.lnbtc.verify() : await o.lnbtc.settle(parsed, clientOf(c));
        return c.json(a.json, a.status);
      }
      return forward(`/${route}`, { method: "POST", body, headers: { "content-type": "application/json" } });
    });
  }
}

export function mountFacilitator(app: Hono, db: Db, network: string, log: Logger): void {
  const local = process.env.DIRECT_FACILITATOR_URL?.replace(/\/+$/, "") || null;
  const lnbtc = process.env.LNBTC_FACILITATOR === "off" ? null : openLnbtc(db, log);
  if (!local && !lnbtc) return;
  mountFacilitatorProtocol(app, { upstream: local ? (path, init) => fetch(`${local}${path}`, { ...init, signal: AbortSignal.timeout(45_000) }) : null, lnbtc });
  if (lnbtc) mountLnbtcInfo(app, db, lnbtc);
  if (!local) return;
  const caip2 = network === "mainnet" ? "eip155:5042" : "eip155:5042002";
  const upstream = (path: string, init?: RequestInit): Promise<Response> => fetch(`${local}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });

  /** Tells the facilitator about a seller. Best effort: the row in the database is the record. */
  const push = async (payTo: string): Promise<boolean> => {
    try {
      const res = await upstream("/sellers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payTo }) });
      return res.ok;
    } catch (err) {
      log.warn({ err, payTo }, "facilitator: could not push seller");
      return false;
    }
  };
  /** After a restart of either process, the facilitator's file and our table agree again. */
  const sync = async (): Promise<void> => {
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.facilitator_sellers')::text AS t");
    if (!exists.rows[0]?.t) return;
    const rows = await db.query<{ pay_to: string }>("SELECT pay_to FROM facilitator_sellers");
    let ok = 0;
    for (const r of rows.rows) if (await push(r.pay_to)) ok++;
    log.info({ sellers: rows.rows.length, pushed: ok }, "facilitator: sellers synced");
  };
  void sync();

  /**
   * A wallet costs nothing to make, so registrations are paced: a few an hour from one address, and
   * a ceiling on how many sellers there are at all until the demand says otherwise. The gas itself
   * is bounded in the facilitator; this keeps the list from being flooded.
   */
  const maxSellers = Number(process.env.FACILITATOR_MAX_SELLERS ?? 200);
  const attempts = new Map<string, number[]>();
  const paced = (c: Context): boolean => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const recent = (attempts.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (attempts.size > 10_000) attempts.clear();
    attempts.set(ip, [...recent, Date.now()]);
    return recent.length >= 5;
  };

  app.get("/v1/facilitator", async (c) => {
    const origin = new URL(c.req.url).origin;
    let health: Record<string, unknown> | null = null;
    try {
      health = (await (await upstream("/health")).json()) as Record<string, unknown>;
    } catch {
      health = null;
    }
    return c.json({
      url: `${origin}/facilitator`,
      network: caip2,
      scheme: "exact",
      asset: "0x3600000000000000000000000000000000000000",
      dailyCap: health?.dailyCap ?? null,
      sharedDailyCap: health?.sharedDailyCap ?? null,
      sharedSettledToday: health?.sharedSettledToday ?? null,
      registeredSellers: health?.registeredSellers ?? null,
      ok: health?.ok ?? false,
      register: `${origin.replace("api.", "")}/register`,
      lightning: lnbtc ? `${origin}/v1/facilitator/lightning` : null,
      note: "Settles EIP-3009 USDC authorizations on Arc for registered sellers, paying the gas. A seller registers by signing a message with the wallet that gets paid. Each seller has a daily allowance of settlements, all registered sellers share a second one, and a gas reserve is kept for our own routes; past any of them, buyers pay through Circle Gateway.",
    });
  });

  app.post("/v1/facilitator/sellers", async (c) => {
    if (paced(c)) return c.json({ error: "too many registrations from here, try again in an hour" }, 429);
    const b = (await c.req.json().catch(() => null)) as { payTo?: unknown; issuedAt?: unknown; signature?: unknown } | null;
    if (typeof b?.payTo !== "string" || !ADDRESS.test(b.payTo)) return c.json({ error: "payTo must be a 0x address" }, 400);
    if (typeof b.issuedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(b.issuedAt)) return c.json({ error: "issuedAt must be an ISO time in UTC" }, 400);
    if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) return c.json({ error: "signature must be a 65-byte hex signature" }, 400);
    const age = Date.now() - Date.parse(b.issuedAt);
    if (!(age > -60_000 && age < REGISTRATION_MAX_AGE_MS)) return c.json({ error: "the signed message is too old: sign a fresh one" }, 400);
    let valid = false;
    try {
      valid = await verifyMessage({ address: b.payTo as `0x${string}`, message: registrationMessage(b.payTo, b.issuedAt), signature: b.signature as `0x${string}` });
    } catch {
      valid = false;
    }
    if (!valid) return c.json({ error: "the signature was not made by that wallet over that message" }, 400);
    const known = await db.query<{ n: string; mine: string }>("SELECT count(*) AS n, count(*) FILTER (WHERE pay_to = $1) AS mine FROM facilitator_sellers", [b.payTo.toLowerCase()]);
    if (Number(known.rows[0]!.mine) === 0 && Number(known.rows[0]!.n) >= maxSellers) return c.json({ error: "registration is full for now: write to us at x.com/Craagentarc" }, 503);
    await db.query("INSERT INTO facilitator_sellers (pay_to, issued_at, signature) VALUES ($1, $2, $3) ON CONFLICT (pay_to) DO NOTHING", [b.payTo.toLowerCase(), b.issuedAt, b.signature]);
    const pushed = await push(b.payTo.toLowerCase());
    log.info({ payTo: b.payTo.toLowerCase(), pushed }, "facilitator: seller registered");
    return c.json({ registered: true, payTo: b.payTo.toLowerCase(), active: pushed, facilitatorUrl: `${new URL(c.req.url).origin}/facilitator` });
  });

  app.get("/v1/facilitator/sellers/:address", async (c) => {
    const a = c.req.param("address");
    if (!ADDRESS.test(a)) return c.json({ error: "not an address" }, 400);
    try {
      const res = await upstream(`/sellers/${a}`);
      return c.json((await res.json()) as object, res.status as 200);
    } catch {
      return c.json({ error: "the facilitator is not answering" }, 503);
    }
  });
}

/** Our replay store, opened to every seller, with its settlements counted in facilitator_lnbtc. */
function openLnbtc(db: Db, log: Logger): LnbtcFacilitator {
  const replay = new PgReplayStore(db);
  // Claims are kept a day past the time they could matter, then removed: the table stays small.
  const prune = () => void replay.prune().then((n) => n && log.info({ removed: n }, "lnbtc: expired claims pruned")).catch((err: unknown) => log.warn({ err }, "lnbtc: prune failed"));
  setInterval(prune, 3_600_000).unref();
  setTimeout(prune, 60_000).unref();
  return lnbtcFacilitator({
    replay,
    maxTimeoutSeconds: Number(process.env.LNBTC_FACILITATOR_MAX_TIMEOUT ?? 3600),
    perMinute: Number(process.env.LNBTC_FACILITATOR_PER_MINUTE ?? 60),
    dailyCap: Number(process.env.LNBTC_FACILITATOR_DAILY_CAP ?? 20_000),
    settledEarlierToday: async () => Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM facilitator_lnbtc WHERE settled_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'")).rows[0]?.n ?? 0),
    onSettled: async (e) => {
      await db
        .query("INSERT INTO facilitator_lnbtc (network, payment_hash, pay_to, amount_msat) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [e.network, e.paymentHash, e.payTo, e.amountMsat])
        .catch((err: unknown) => log.warn({ err: (err as Error).message, hash: e.paymentHash }, "lnbtc: facilitator settlement not recorded"));
    },
  });
}

/** What the Lightning facilitator is and what it has done, counted apart from our own node. */
function mountLnbtcInfo(app: Hono, db: Db, lnbtc: LnbtcFacilitator): void {
  app.get("/v1/facilitator/lightning", async (c) => {
    const origin = new URL(c.req.url).origin;
    // Our node is the one our own API records Lightning payments to: settlements for it are ours, not use.
    const counts = await db
      .query<{ total: string; today: string; nodes: string; ours: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE settled_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') AS today,
                count(DISTINCT pay_to) AS nodes,
                count(*) FILTER (WHERE pay_to IN (SELECT DISTINCT pay_to FROM settlements WHERE rail = 'lightning')) AS ours
           FROM facilitator_lnbtc`,
      )
      .then((r) => r.rows[0] ?? null)
      .catch(() => null);
    return c.json({
      url: `${origin}/facilitator`,
      scheme: "exact",
      networks: lnbtc.kinds.map((k) => k.network),
      spec: "https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md",
      registration: "none",
      routes: { supported: "GET /facilitator/supported", settle: "POST /facilitator/settle" },
      limits: { ...lnbtc.limits, settledToday: await lnbtc.settledToday() },
      settled: counts ? { total: Number(counts.total), today: Number(counts.today), nodes: Number(counts.nodes), forOurOwnNode: Number(counts.ours) } : null,
      note: "Checks an x402 exact/lnbtc proof against the seller's requirements, in the spec's order and with its error strings, and claims network:payment_hash once in a durable store shared with our own Lightning routes. Nothing moves: the sats reached the seller's node before the buyer had the preimage. There is no /verify in this flow: settle, then serve. No payer is returned, and no preimage is kept or logged.",
    });
  });
}
