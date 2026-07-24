// The blocking dependency-audit gate (CI `check` job), allowlist-aware.
//
// `npm audit --audit-level=high` fails on ANY high/critical advisory with no
// escape hatch, which wedges every PR when an advisory lands that has no
// installable fix — the 2026-07-24 case: brace-expansion GHSA-mh99-v99m-4gvg
// flags every version except 5.0.8, but 5.0.8's CommonJS export is an object
// (`{ expand }`) where every shipped consumer generation (minimatch 3/9/10's
// published ranges, readdir-glob) expects `module.exports` to BE the function,
// so pinning it via overrides breaks eslint at import time. No resolvable set
// exists until the parents republish.
//
// This gate keeps the enforcement (a NEW high/critical still fails the job)
// while carrying a small, justified allowlist. RULES for the allowlist:
//   - entries are GHSA ids with a `reason` and a `tracking` issue reference;
//   - each entry is TEMPORARY by construction — the tracking issue owns its
//     removal the moment upstream ships a compatible fixed version;
//   - moderates/lows never reach this gate (the non-blocking visibility audit
//     above it in ci.yml surfaces those).
//
// Exit codes: 0 = clean or only-allowlisted; 1 = a non-allowlisted high or
// critical advisory is present (the job fails, as before).

import { execSync } from "node:child_process";

const ALLOWLIST = {
  // brace-expansion DoS (high). No installable fix: only 5.0.8 is outside the
  // flagged range and its CJS export shape breaks minimatch<=10.0.2 consumers
  // (eslint's tree: "TypeError: expand is not a function"). The 1.x/2.x
  // releases published 2026-07-08 look like in-major patches whose advisory
  // metadata hasn't propagated. Remove when `npm audit` accepts an in-range
  // version or the parents (minimatch, readdir-glob/exceljs) republish.
  // Tracking: #1454.
  "GHSA-mh99-v99m-4gvg": {
    reason:
      "no resolvable fix: only brace-expansion 5.0.8 clears the range and its export shape breaks all shipped minimatch consumers",
    tracking: "#1454",
  },
};

let raw;
try {
  raw = execSync("npm audit --json", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // npm audit exits non-zero when vulnerabilities exist — the JSON payload is
  // still on stdout; a missing payload is a real infrastructure failure.
  raw = err.stdout;
  if (!raw) {
    console.error("audit-gate: npm audit produced no JSON output");
    console.error(String(err.stderr ?? err));
    process.exit(1);
  }
}

const report = JSON.parse(raw);
const vulns = report.vulnerabilities ?? {};
const offenders = [];
const allowlisted = [];

for (const [name, v] of Object.entries(vulns)) {
  if (v.severity !== "high" && v.severity !== "critical") continue;
  // `via` mixes advisory objects (direct cause) and plain strings (transitive
  // package names); only the objects carry the GHSA url.
  const advisories = (v.via ?? []).filter((x) => typeof x === "object");
  const ids = advisories.map((a) => {
    const m = /GHSA-[a-z0-9-]+/.exec(a.url ?? "");
    return m ? m[0] : `${a.source ?? "unknown"}`;
  });
  // A package is allowlisted only when EVERY advisory driving it is allowlisted;
  // packages whose `via` is purely transitive strings inherit their root cause's
  // verdict (they carry no advisory of their own).
  if (ids.length === 0) continue;
  const notAllowed = ids.filter((id) => !(id in ALLOWLIST));
  if (notAllowed.length === 0) {
    allowlisted.push(`${name} (${ids.join(", ")})`);
  } else {
    offenders.push(`${name}: ${v.severity} — ${notAllowed.join(", ")}`);
  }
}

if (allowlisted.length > 0) {
  console.log("audit-gate: allowlisted (temporary, tracked):");
  for (const a of allowlisted) console.log(`  - ${a}`);
}

if (offenders.length > 0) {
  console.error(
    "audit-gate: FAILING on non-allowlisted high/critical advisories:"
  );
  for (const o of offenders) console.error(`  - ${o}`);
  process.exit(1);
}

console.log("audit-gate: OK — no non-allowlisted high/critical advisories");
