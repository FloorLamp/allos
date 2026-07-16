import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static hygiene guard for the e2e suite (issue #868, fix a) — the #448 /
// telegram-chokepoint source-scan pattern applied to Playwright specs. It reads
// e2e/*.spec.ts as TEXT (no browser, no DB, so it stays "pure" in the vitest
// sense) and freezes TODAY's count of two settle anti-patterns per spec file:
//
//   (i)  waitForLoadState("networkidle") — a readiness gate that settles on a
//        quiet page but NOT one with a long-poll/SSE/streaming request, and waits
//        for the WRONG thing (network silence, not "my interaction landed"). The
//        blessed replacement is e2e/helpers.ts (settledClick / followLink).
//   (ii) waitForTimeout(...) — a fixed sleep that asserts nothing and is either
//        too short (flakes under CI contention) or too long (slows the suite).
//
// Existing offenders are grandfathered via a per-file allowlist (file → count);
// a NEW occurrence, or a NEW spec file introducing either, exceeds its allowed
// count (0 when absent) and FAILS. Reducing a count below its frozen value also
// fails — with a message telling you to lower the allowlist — so the allowlist
// only ever shrinks as offenders are migrated (the same immutable-manifest
// discipline as the migration hash manifest). This is a per-file COUNT freeze,
// not line numbers, so it survives ordinary edits.
//
// NOT mechanically enforced here (documented rule only — see
// docs/internals/e2e-hygiene.md): exact-count assertions against SHARED-SEED
// fixture rows ("2 today", "≥ 2 episode rows"). Detecting those syntactically
// (a numeric literal inside a toContainText/toHaveCount against a seeded testid)
// is too clever — it can't tell a shared-seed count from a spec's own
// self-created fixture, so it would fire on legitimate dedicated-fixture asserts
// and miss obfuscated ones. The honest scope is the two mechanically-detectable
// anti-patterns above; the fixture-ownership rule lives in the doc and is a
// review/convention gate, not a linter.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const E2E_DIR = path.join(REPO, "e2e");

// The blessed interaction module OWNS networkidle/timeout usage (followLink's
// internal settle), so it is never scanned — only spec files are.
const NETWORKIDLE_RE = /waitForLoadState\(\s*["']networkidle["']\s*\)/g;
const WAITFORTIMEOUT_RE = /\.waitForTimeout\(/g;

// Frozen offenders as of #868 (per-file counts). Migrate an entry to
// e2e/helpers.ts and LOWER its number here in the same PR; a fully-migrated file
// drops out entirely. New files must not appear.
const NETWORKIDLE_ALLOW: Record<string, number> = {
  "providers.spec.ts": 1,
};

const WAITFORTIMEOUT_ALLOW: Record<string, number> = {
  // Both prove the ABSENCE of an effect (no autosave/edit-lock fires within the
  // 700ms window; a toast auto-dismisses after its lifetime) — a legitimate use
  // a settledClick/expect cannot express. Kept, but frozen so no NEW sleep hides
  // among them.
  "journal-provenance.spec.ts": 2,
  "profile-switch-toasts.spec.ts": 3,
};

function specFiles(): { name: string; text: string }[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(E2E_DIR, name), "utf8"),
    }));
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function checkPattern(
  label: string,
  re: RegExp,
  allow: Record<string, number>
) {
  const files = specFiles();
  const seen = new Set<string>();
  const violations: string[] = [];

  for (const { name, text } of files) {
    const count = countMatches(text, re);
    const allowed = allow[name] ?? 0;
    seen.add(name);
    if (count > allowed) {
      violations.push(
        `${name}: ${count} ${label} (allowed ${allowed}). ` +
          `New occurrences are banned — use e2e/helpers.ts (settledClick/followLink); ` +
          `see docs/internals/e2e-hygiene.md.`
      );
    } else if (count < allowed) {
      violations.push(
        `${name}: ${count} ${label} but allowlist freezes ${allowed}. ` +
          `You reduced offenders — LOWER (or remove) its entry in ` +
          `lib/__tests__/e2e-hygiene.test.ts so the allowlist keeps shrinking.`
      );
    }
  }

  // A stale allowlist entry for a file that no longer exists must be removed.
  for (const name of Object.keys(allow)) {
    if (!seen.has(name)) {
      violations.push(
        `${name}: allowlisted for ${label} but the spec file no longer exists — ` +
          `remove its entry in lib/__tests__/e2e-hygiene.test.ts.`
      );
    }
  }

  expect(violations, violations.join("\n")).toEqual([]);
}

describe("e2e suite hygiene guard (issue #868)", () => {
  it('no NEW waitForLoadState("networkidle") in a spec (use e2e/helpers.ts)', () => {
    checkPattern(
      'waitForLoadState("networkidle")',
      NETWORKIDLE_RE,
      NETWORKIDLE_ALLOW
    );
  });

  it("no NEW waitForTimeout(...) in a spec (use e2e/helpers.ts or a real expect)", () => {
    checkPattern(
      "waitForTimeout(...)",
      WAITFORTIMEOUT_RE,
      WAITFORTIMEOUT_ALLOW
    );
  });

  it("the blessed interaction module exists and exports settledClick + followLink", () => {
    const helpers = fs.readFileSync(path.join(E2E_DIR, "helpers.ts"), "utf8");
    expect(helpers).toMatch(/export async function settledClick\b/);
    expect(helpers).toMatch(/export async function followLink\b/);
  });
});
