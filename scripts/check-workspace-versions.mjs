// Every @cra-agent dependency inside the monorepo must name the version that package has right now.
// If it names an older one, npm stops linking the local code and quietly installs the old release
// from the registry instead. That is how production lost a payment rail for half a day: the API
// asked for seller 0.0.1, the workspace had moved on, and it ran four-day-old code without an error.
import { readdirSync, readFileSync, existsSync } from "node:fs";

const dirs = readdirSync("packages").filter((d) => existsSync(`packages/${d}/package.json`));
const pkgs = dirs.map((d) => JSON.parse(readFileSync(`packages/${d}/package.json`, "utf8")));
const version = new Map(pkgs.map((p) => [p.name, p.version]));
const problems = [];
for (const p of pkgs) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, wanted] of Object.entries(p[field] ?? {})) {
      if (version.has(dep) && wanted !== version.get(dep)) problems.push(`${p.name} wants ${dep}@${wanted}, the workspace has ${version.get(dep)}`);
    }
  }
}
if (problems.length > 0) {
  console.error(`workspace versions out of step:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`workspace versions in step (${pkgs.length} packages)`);
