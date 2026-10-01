/**
 * Pays for one URL from a Solana key, choosing the Solana option in the seller's 402.
 *   npx tsx scripts/pay-on-solana.mts .secrets/solana-test-buyer.key "https://api.cra-agent.tech/v1/paid/fx/execution?symbol=cirBTC"
 * PayAI completes the transaction and pays its fee, so the key needs USDC on Solana and no SOL.
 * A route billed by use (upto) is paid the same way: the ceiling goes into an escrow and only the charge is
 * claimed, the rest refunded. MAX_USD (default 0.01) is the most this script lets one payment ask for.
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { solanaSigner } from "./solana-key.mts";

const [keyFile, url] = process.argv.slice(2);
if (!keyFile || !url) throw new Error("usage: pay-on-solana.mts <key file> <url>");
const signer = await solanaSigner(keyFile);
const maxUsd = process.env.MAX_USD ?? "0.01";
if (!/^\d+(\.\d{1,6})?$/.test(maxUsd) || Number(maxUsd) > 0.25) throw new Error("MAX_USD is an amount in dollars, at most 0.25");
const client = new x402Client((_v, accepts) => accepts.find((a) => a.network.startsWith("solana:"))!)
  .register("solana:*", new ExactSvmScheme(toClientSvmSigner(signer)))
  .register("solana:*", new UptoSvmScheme(toClientSvmSigner(signer)));
client.setSpendControls({ maxAmountPerPayment: `$${maxUsd}` });
const paidFetch = wrapFetchWithPayment(fetch, client);
const started = Date.now();
const res = await paidFetch(url, { headers: { accept: "application/json" } });
const body = await res.text();
const receipt = res.headers.get("payment-response");
console.log(JSON.stringify({ payer: signer.address, status: res.status, ms: Date.now() - started, settlement: receipt ? decodePaymentResponseHeader(receipt) : null, body: body.slice(0, 300) }, null, 2));
