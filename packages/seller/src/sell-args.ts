/** The command line of cra-agent-sell, apart from the process that serves, so it can be tested. */
import { normalisePrice, parseRouteFlag, type PricedPath } from "./proxy.js";

export interface SellArgs {
  target: string;
  payTo: string;
  network: "arc" | "arcTestnet";
  port: number;
  routes: PricedPath[];
  free: string[];
  name?: string;
  description?: string;
  upstreamHeaders: Record<string, string>;
  facilitatorUrl?: string;
  list?: string;
}

export function parseSellArgs(argv: readonly string[]): SellArgs {
  const many = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "proxy" && i === 0) continue; // `npx @cra-agent/seller proxy …` reads naturally; the word is optional
    if (!a.startsWith("--")) throw new Error(`unexpected "${a}"`);
    const eq = a.indexOf("=");
    const [key, value] = eq > 0 && !a.startsWith("--route") && !a.startsWith("--upstream-header") ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), argv[++i] ?? ""];
    many.set(key, [...(many.get(key) ?? []), value]);
  }
  const known = ["target", "pay-to", "price", "route", "free", "name", "description", "network", "port", "upstream-header", "facilitator", "list"];
  for (const k of many.keys()) if (!known.includes(k)) throw new Error(`unknown option --${k}`);
  const one = (k: string): string | undefined => many.get(k)?.at(-1);

  const target = one("target");
  if (!target || !/^https?:\/\/\S+$/i.test(target)) throw new Error("--target is required: the URL of the API to sell, like https://api.example.com");
  const payTo = one("pay-to");
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("--pay-to is required: the 0x address that gets paid");
  const network = one("network") ?? "arc";
  if (network !== "arc" && network !== "arcTestnet") throw new Error("--network is arc or arcTestnet");
  const port = Number(one("port") ?? 8402);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port is a number between 1 and 65535");

  // Specific paths first: the first pattern that matches a request sets its price.
  const routes = (many.get("route") ?? []).map(parseRouteFlag);
  const price = one("price");
  if (price) routes.push({ pattern: "/*", price: normalisePrice(price) });
  if (routes.length === 0) throw new Error("give a price: --price 0.002 for every call, or --route \"GET /v1/x=0.002\" for one path");

  const upstreamHeaders: Record<string, string> = {};
  for (const h of many.get("upstream-header") ?? []) {
    const colon = h.indexOf(":");
    if (colon < 1) throw new Error(`--upstream-header "${h}": expected "Name: value"`);
    upstreamHeaders[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
  }
  const facilitatorUrl = one("facilitator");
  const list = one("list");
  if (list && !/^https:\/\/\S+$/i.test(list)) throw new Error("--list takes the public https URL buyers will call");
  const name = one("name");
  const description = one("description");
  return { target, payTo, network, port, routes, free: many.get("free") ?? [], upstreamHeaders, ...(name ? { name } : {}), ...(description ? { description } : {}), ...(facilitatorUrl ? { facilitatorUrl } : {}), ...(list ? { list } : {}) };
}
