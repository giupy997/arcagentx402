import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

// Runtime config. Empty API URL = same origin (the API serves the site on the VPS).
const api = (process.env.CRA_API_URL ?? process.env.ARCRAIL_API_URL ?? "").replace(/\/+$/, "");
if (api && !/^https?:\/\//.test(api)) throw new Error(`CRA_API_URL must start with http(s)://, got ${api}`);
writeFileSync("dist/config.js", `window.CRA_API = ${JSON.stringify(api)};\n`);
// The one script with dependencies: the receipt checks of the router (viem, the post-quantum library), in one
// file a browser can load. Read from source, so this site builds without building the packages first.
const bundled = await build({
  entryPoints: ["bundle/receipt-check.ts"],
  outfile: "dist/js/receipt-check.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  alias: { "@cra-agent/accounting": "../accounting/src/index.ts" },
  metafile: true,
});
const kb = Math.round(Object.values(bundled.metafile.outputs)[0].bytes / 1024);
console.log(`web: public/ copied to dist/ · receipt-check.js ${kb} kB · API ${api || "(same origin)"}`);
