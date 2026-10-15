// Refuse a run whose Node major differs from .nvmrc. `engine-strict` covers
// `npm install`/`npm ci` only; npm's run-script path never reads `engines`, so
// package.json prefixes the hand-run tiers with this. `start` stays unguarded:
// the Docker image ships neither `scripts/` nor `.nvmrc`.
import fs from "node:fs";

const nvmrc = new URL("../.nvmrc", import.meta.url);
let pinned;
try {
  pinned = fs
    .readFileSync(nvmrc, "utf8")
    .trim()
    .replace(/^v/, "")
    .split(".")[0];
} catch {
  pinned = "";
}
const major = process.version.replace(/^v/, "").split(".")[0];
if (!pinned) {
  console.error(
    `node-check: .nvmrc unreadable; cannot check ${process.version}`
  );
  process.exit(3);
}
if (major !== pinned) {
  console.error(
    `node-check: this shell runs node ${process.version} (${process.execPath}) but .nvmrc pins ${pinned}. Switch to node ${pinned} and re-run.`
  );
  process.exit(3);
}
