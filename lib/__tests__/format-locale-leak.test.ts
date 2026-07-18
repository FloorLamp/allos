import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the date/time formatting seam (issue #964). The scattered
// per-surface date/time formatters were consolidated behind the pref-aware seam in
// lib/format-date.ts (formatClock / formatDateShape), and record-format.ts's
// datetime path — which called `toLocaleString(undefined, …)` — leaked the SERVER's
// locale (the Docker container's, not the user's) into server-rendered pages, so a
// deploy-environment change silently reformatted dates. The fix renders dates/times
// from fixed-English tables driven by the login's chosen format, never the ambient
// locale.
//
// This scan reads the seam's own source as TEXT (no DB/network, so it stays "pure")
// and fails the build if any of the consolidated formatter modules reintroduces a
// locale-implicit `toLocale*(undefined, …)` call. A new user-facing formatter that
// needs a date/time string routes through the seam instead of `toLocale*(undefined`.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The formatter modules consolidated onto the pref-aware seam. None of these may
// resolve a date/time against the ambient (server) locale.
const FORMATTER_FILES = [
  "lib/record-format.ts",
  "lib/administration-format.ts",
  "lib/format-date.ts",
  "lib/journal-card.ts",
];

// `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` invoked with an
// undefined (ambient-locale) first argument — the exact server-locale leak #964
// removed. An explicit locale (`toLocaleDateString("en-CA", …)`, as lib/date.ts's
// timezone math uses) is deterministic and NOT what this bans.
const LOCALE_LEAK = /toLocale(?:Date|Time)?String\(\s*undefined\b/;

describe("date/time formatters have no server-locale leak (#964)", () => {
  for (const rel of FORMATTER_FILES) {
    it(`${rel} does not call toLocale*(undefined, …)`, () => {
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      expect(src).not.toMatch(LOCALE_LEAK);
    });
  }
});
