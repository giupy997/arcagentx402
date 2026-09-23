/**
 * Registering a seller's wallet with the facilitator: connect, sign a message, send the signature.
 * The message text lives in registration-message.ts; a test keeps it identical to the API's.
 */
import { API_BASE } from "./api.js";
import { initChrome } from "./menu.js";
import { registrationMessage } from "./registration-message.js";
import { findWallets, isPhone, openInWalletLinks, type Eip1193 } from "./wallets.js";

initChrome();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let wallet: Eip1193 | null = null;
let account: string | null = null;
let issuedAt = "";

function step(text: string, state: "" | "ok" | "bad" = ""): void {
  const li = document.createElement("li");
  li.textContent = text;
  if (state) li.className = state;
  $("steps").appendChild(li);
}

async function loadInfo(): Promise<void> {
  try {
    const d = (await (await fetch(`${API_BASE}/v1/facilitator`)).json()) as { dailyCap?: number | null; sharedDailyCap?: number | null };
    if (d.dailyCap) $("r-cap").textContent = String(d.dailyCap);
    if (d.sharedDailyCap) $("r-shared").textContent = String(d.sharedDailyCap);
  } catch {
    /* the default stays */
  }
}

async function connect(): Promise<void> {
  const found = await findWallets();
  if (found.length === 0) {
    if (isPhone()) {
      const box = $("wallets");
      box.classList.remove("hidden");
      box.innerHTML = '<p class="sub">On a phone, open this page inside your wallet app:</p>';
      for (const l of openInWalletLinks(location.href)) {
        const a = document.createElement("a");
        a.className = "btn";
        a.href = l.href;
        a.textContent = l.name;
        box.appendChild(a);
      }
    } else $("account").textContent = "No browser wallet found. Install one and reload.";
    return;
  }
  wallet = found[0]!.provider;
  try {
    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    account = accounts[0] ?? null;
  } catch (err) {
    $("account").textContent = `Not connected: ${(err as Error).message ?? "request rejected"}`;
    return;
  }
  if (!account) return;
  $("account").textContent = account;
  issuedAt = new Date().toISOString();
  $("r-message").textContent = registrationMessage(account, issuedAt);
  $<HTMLButtonElement>("sign").disabled = false;
  try {
    const s = (await (await fetch(`${API_BASE}/v1/facilitator/sellers/${account}`)).json()) as { registered?: boolean; settledToday?: number; dailyCap?: number | null };
    $("r-status").textContent = s.registered ? `Already registered${s.dailyCap ? `: ${s.settledToday ?? 0} of ${s.dailyCap} settlements used today` : ""}. Signing again is harmless.` : "Not registered yet.";
  } catch {
    $("r-status").textContent = "";
  }
}

async function sign(): Promise<void> {
  if (!wallet || !account) return;
  const button = $<HTMLButtonElement>("sign");
  button.disabled = true;
  $("steps").innerHTML = "";
  try {
    issuedAt = new Date().toISOString();
    const message = registrationMessage(account, issuedAt);
    $("r-message").textContent = message;
    step("Waiting for your signature in the wallet…");
    const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const signature = (await wallet.request({ method: "personal_sign", params: [hex, account] })) as string;
    step("Signed. Sending it to the API…", "ok");
    const res = await fetch(`${API_BASE}/v1/facilitator/sellers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payTo: account, issuedAt, signature }) });
    const body = (await res.json()) as { error?: string; registered?: boolean; active?: boolean; facilitatorUrl?: string };
    if (!res.ok || !body.registered) throw new Error(body.error ?? `HTTP ${res.status}`);
    step(body.active ? "Registered. The facilitator settles for this wallet from now on." : "Registered. The facilitator will pick it up shortly.", "ok");
    $("r-flag").textContent = `--facilitator ${body.facilitatorUrl ?? `${API_BASE || location.origin}/facilitator`}`;
    $("done-card").classList.remove("hidden");
    $("r-status").textContent = "Registered.";
  } catch (err) {
    step(`Failed: ${(err as Error).message}`, "bad");
  } finally {
    button.disabled = false;
  }
}

$("connect").addEventListener("click", () => void connect());
$("sign").addEventListener("click", () => void sign());
void loadInfo();
