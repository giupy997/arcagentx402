import { cpSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

// Runtime config. Empty API URL = same origin (the API serves the site on the VPS).
const api = (process.env.ARCRAIL_API_URL ?? "").replace(/\/+$/, "");
if (api && !/^https?:\/\//.test(api)) throw new Error(`ARCRAIL_API_URL must start with http(s)://, got ${api}`);
writeFileSync("dist/config.js", `window.ARCRAIL_API = ${JSON.stringify(api)};\n`);
console.log(`web: public/ copied to dist/ · API ${api || "(same origin)"}`);
