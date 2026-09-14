import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
console.log("web: public/ copied to dist/");
