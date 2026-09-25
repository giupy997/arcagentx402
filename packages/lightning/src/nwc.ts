/**
 * Lightning through Nostr Wallet Connect (NIP-47), with Alby's SDK: a receiver that asks our node for
 * invoices bound to a request, and a payer that pays one and returns its preimage. A connection string is a
 * secret; it is read from a file and never logged.
 */
import { readFileSync } from "node:fs";
import { NWCClient } from "@getalby/sdk/nwc";
import type { PayerAdapter, ReceiverAdapter } from "./lnbtc.js";

/** A connection string from a file that holds only it (a trailing newline is fine). */
export function readConnection(path: string): string {
  const url = readFileSync(path, "utf8").trim();
  if (!url.startsWith("nostr+walletconnect://")) throw new Error(`${path} does not hold a nostr+walletconnect:// connection`);
  return url;
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} timed out`), { code: "TIMEOUT" })), ms))]);

/**
 * Our node, receiving: its key is read once (get_info) and becomes payTo. The client is kept open and made
 * again after a failure, since relays drop connections.
 */
export async function nwcReceiver(connection: string, o: { timeoutMs?: number } = {}): Promise<ReceiverAdapter & { close(): void }> {
  const timeout = o.timeoutMs ?? 10_000;
  let client = new NWCClient({ nostrWalletConnectUrl: connection });
  const info = await within(client.getInfo(), timeout, "get_info");
  if (!info.methods?.includes("make_invoice")) throw new Error("this connection cannot create invoices (make_invoice)");
  if (info.methods.includes("pay_invoice")) throw new Error("this connection can also pay: give the receiver a receive-only connection");
  return {
    pubkey: info.pubkey,
    async createInvoice({ amountMsat, descriptionHash, expirySeconds }) {
      try {
        const made = await within(client.makeInvoice({ amount: Number(amountMsat), description_hash: descriptionHash, expiry: expirySeconds }), timeout, "make_invoice");
        return made.invoice;
      } catch (err) {
        client.close();
        client = new NWCClient({ nostrWalletConnectUrl: connection });
        throw err;
      }
    },
    close: () => client.close(),
  };
}

/**
 * A wallet paying: `paid` with the preimage, `in_flight` when the wallet did not answer in time (the payment
 * may still complete: do not pay again), `failed` when it said no.
 */
export function nwcPayer(connection: string, o: { timeoutMs?: number } = {}): PayerAdapter & { close(): void } {
  const timeout = o.timeoutMs ?? 60_000;
  const client = new NWCClient({ nostrWalletConnectUrl: connection });
  return {
    async payInvoice(invoice) {
      try {
        const r = await within(client.payInvoice({ invoice }), timeout, "pay_invoice");
        return { status: "paid", preimage: r.preimage, ...(r.fees_paid === undefined ? {} : { feesMsat: String(r.fees_paid) }) };
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (code === "TIMEOUT" || /timeout/i.test((err as Error).constructor?.name ?? "")) return { status: "in_flight" };
        return { status: "failed", reason: `${code || "error"}: ${String((err as Error).message ?? err).slice(0, 120)}` };
      }
    },
    close: () => client.close(),
  };
}
