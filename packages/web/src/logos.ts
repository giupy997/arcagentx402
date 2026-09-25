/** Sellers' logos, as the bazaar and the think page show them: read by our API, never straight from a seller's site. */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A seller without a logo gets its initials on a colour of its own, from the blues the site uses. */
export function monogram(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  const initials = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="monogram" style="--hue:${190 + (h % 80)}">${escape(initials)}</span>`;
}

/** Broken logos show the monogram instead: images arrive after the markup, so this runs after each render. */
export function watchLogos(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>(".b-logo img")) {
    const fail = () => img.parentElement?.classList.add("failed");
    if (img.complete && img.naturalWidth === 0) fail();
    else img.addEventListener("error", fail, { once: true });
  }
}
