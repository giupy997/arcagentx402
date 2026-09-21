/**
 * Finding the visitor's wallet, wherever it is.
 *
 * On a computer a wallet is an extension that announces itself to the page (EIP-6963), and there
 * can be several. On a phone there is no extension: a wallet app has its own browser, and a page
 * opened inside it finds the wallet exactly as it would on a computer. So on a phone with no wallet
 * in sight, the useful thing is a link that reopens this page inside the wallet app. No account,
 * no relay and no third party between the visitor and their wallet.
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
export interface FoundWallet {
  readonly name: string;
  readonly icon: string | null;
  readonly provider: Eip1193;
}

interface Announce { detail?: { info?: { name?: string; icon?: string; uuid?: string }; provider?: Eip1193 } }

/**
 * Every wallet that answers within `waitMs`. Wallet apps inject theirs a moment after the page
 * loads, so an empty first look is not yet a no.
 */
export function findWallets(waitMs = 1200): Promise<FoundWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundWallet>();
    const onAnnounce = (e: Event): void => {
      const d = (e as unknown as Announce).detail;
      if (!d?.provider || !d.info?.uuid) return;
      // Only an image the wallet embedded is shown; a remote URL would be a request the visitor never asked for.
      const icon = d.info.icon?.startsWith("data:image/") ? d.info.icon : null;
      found.set(d.info.uuid, { name: d.info.name ?? "Wallet", icon, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const injected = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;
    const done = (): void => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      const legacy = injected();
      // A wallet that predates the announcement still sits on window.ethereum.
      if (legacy && !list.some((w) => w.provider === legacy)) list.push({ name: list.length ? "Other wallet" : "Browser wallet", icon: null, provider: legacy });
      resolve(list);
    };
    const started = Date.now();
    const tick = (): void => {
      // As soon as anything has answered, give the others a short moment and stop waiting.
      if ((found.size > 0 || injected()) && Date.now() - started > 250) return done();
      if (Date.now() - started >= waitMs) return done();
      setTimeout(tick, 100);
    };
    tick();
  });
}

export const isPhone = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export interface WalletLink {
  readonly name: string;
  readonly href: string;
}

/** Links that reopen `pageUrl` inside a wallet app's own browser, in each wallet's documented format. */
export function openInWalletLinks(pageUrl: string): WalletLink[] {
  const u = new URL(pageUrl);
  const bare = `${u.host}${u.pathname}${u.search}`;
  const enc = encodeURIComponent(u.toString());
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: "OKX Wallet", href: `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${enc}`)}` },
  ];
}
