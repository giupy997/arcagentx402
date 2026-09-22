/**
 * Pays for one URL from a Solana key, choosing the Solana option in the seller's 402.
 *   npx tsx scripts/pay-on-solana.mts .secrets/solana-test-buyer.key "https://api.cra-agent.tech/v1/paid/fx/execution?symbol=cirBTC"
 * PayAI completes the transaction and pays its fee, so the key needs USDC on Solana and no SOL.
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import { solanaSigner } from "./solana-key.mts";

const [keyFile, url] = process.argv.slice(2);
if (!keyFile || !url) throw new Error("usage: pay-on-solana.mts <key file> <url>");
const signer = await solanaSigner(keyFile);
const client = new x402Client().register("solana:*", new ExactSvmScheme(toClientSvmSigner(signer)));
const paidFetch = wrapFetchWithPayment(fetch, client);
const started = Date.now();
const res = await paidFetch(url, { headers: { accept: "application/json" } });
const body = await res.text();
const receipt = res.headers.get("payment-response");
console.log(JSON.stringify({ payer: signer.address, status: res.status, ms: Date.now() - started, settlement: receipt ? decodePaymentResponseHeader(receipt) : null, body: body.slice(0, 300) }, null, 2));
