import { describe, expect, it } from "vitest";
import { checkUrl, extractReadable, isPublicAddress, UnsafeUrl } from "../src/safe-fetch.js";
import { decodeString, formatUnits } from "../src/tools.js";
import { PAID_ROUTES } from "../src/routes.js";

describe("which URLs a stranger may make us fetch", () => {
  it("refuses every address that only this machine or its network can reach", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["1.1.1.1", "213.136.90.99", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) expect(isPublicAddress(a), a).toBe(true);
  });

  it("refuses odd schemes, ports, credentials and names that are not public", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com", "http://example.com:8792/", "http://user:pw@example.com/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://2130706433/", "http://0x7f.1/", "gopher://x", "nonsense"]) {
      expect(() => checkUrl(u), u).toThrow(UnsafeUrl);
    }
    expect(checkUrl("https://www.arc.network/path?q=1").hostname).toBe("www.arc.network");
  });
});

describe("the readable part of a page", () => {
  it("keeps what a person reads and drops the machinery", () => {
    const html = `<html><head><title>Hello &amp; welcome</title><meta name="description" content="A test page"><style>p{color:red}</style></head>
      <body><nav>Menu Home About</nav><h1>Main <em>title</em></h1><script>alert("x")</script><p>First paragraph.</p><h2>Second</h2><p>More&nbsp;text &#8212; here.</p><footer>© nobody</footer></body></html>`;
    const out = extractReadable(html);
    expect(out.title).toBe("Hello & welcome");
    expect(out.description).toBe("A test page");
    expect(out.headings).toEqual(["Main title", "Second"]);
    expect(out.text).toContain("First paragraph.");
    expect(out.text).toContain("More text — here.");
    expect(out.text).not.toMatch(/alert|color:red|Menu Home|nobody/);
  });
});

describe("reading a contract's answers without a library", () => {
  it("formats base units", () => {
    expect(formatUnits(500n, 6)).toBe("0.0005");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(0n, 18)).toBe("0");
    expect(formatUnits(10n ** 27n, 18)).toBe("1000000000");
  });
  it("decodes a string in either of the encodings tokens use", () => {
    const dynamic = `0x${"20".padStart(64, "0")}${"3".padStart(64, "0")}${Buffer.from("CRA").toString("hex").padEnd(64, "0")}`;
    expect(decodeString(dynamic)).toBe("CRA");
    expect(decodeString(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`)).toBe("MKR");
    expect(decodeString("0x")).toBeNull();
  });
});

describe("the catalogue", () => {
  it("has no two routes on one path, and gives every required parameter an example that the try page can send", () => {
    expect(new Set(PAID_ROUTES.map((r) => r.path)).size).toBe(PAID_ROUTES.length);
    for (const r of PAID_ROUTES) for (const p of r.params ?? []) if (p.required) expect(p.example, `${r.path} ${p.name}`).toBeDefined();
  });
});
