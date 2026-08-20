import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_TIMEZONE_OVERRIDES } from "../../e2e/fixture-timezones";

// #3337: THE RULE IN e2e/fixture-timezones.ts's HEADER, MADE CHECKABLE.
//
// That header says, from #3260: "do NOT opt a profile out here if its spec asserts a
// dashboard atom." It was true, it was written beside the data it governs, and nothing
// read it — so it did not prevent the third red of exactly that shape.
//
// WHY THE PAIRING IS A BUG rather than a style preference. Dashboard candidates carry
// LOCAL-TIME-OF-DAY timing. The run pins the instance timezone so the frozen clock reads
// 13:mm local at every UTC start hour (e2e/pinned-timezone.ts), which puts every
// pin-following profile at the same distance from every window at every start hour. A
// profile that opts out has a local minute-of-day equal to the run's real UTC start
// hour, so a window it sits outside at 14:00 UTC it sits INSIDE at 09:00 UTC. The atom
// then appears, disappears, or moves lane by the hour the suite happened to start:
//
//   #3260  meal windows      — a candidate resolved `expired` for runs in [21:00, 24:00)
//   #3337  sleep arrival     — `sleepArrivedInWakeWindow`'s 180 minutes promoted
//                              `sleep.duration` OUT of its Standing family for runs in
//                              [08:00, 11:00), so the family lost a member
//
// Both were red ~3 hours a day and green the other 21, which is the worst duty cycle a
// failure can have: rare enough to look like flake, frequent enough to keep costing.
//
// WHAT THIS TEST DOES NOT DO. It does not ask whether a given fixture's local time
// currently lands in some window — that would re-implement the promotion rules and rot
// beside them. It asks the structural question the header already answers: is a profile
// with its OWN calendar reachable from a spec that asserts a dashboard atom? That is
// decidable from source and stays true as the timing rules change.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Spelled this way so this file stays plain text and never joins the deliberate-NUL
// registry (#3206).
const NUL = String.fromCharCode(0);

function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

/**
 * Tracked e2e sources, read directly.
 *
 * `git ls-files -z` plus a direct read, NOT an `rg` sweep: several files in this repo
 * carry a deliberate NUL and ripgrep skips them as binary without `-a`, reporting a
 * clean sweep it never took (#3206). A census that can silently miss a file is worth
 * nothing here, because missing one is indistinguishable from compliance.
 */
function trackedE2eFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "e2e"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split(NUL)
    .filter((rel) => rel.endsWith(".ts"))
    .sort();
}

const E2E_FILES = trackedE2eFiles();
const SPEC_FILES = E2E_FILES.filter((rel) => rel.endsWith(".spec.ts"));
const SOURCE = new Map(E2E_FILES.map((rel) => [rel, read(rel)]));

// How a spec asserts a dashboard atom. The testid and the attribute are the rendered
// contract; the two helpers are the only sanctioned way to reach them, so a spec that
// imports either is asserting atoms even if it never spells the attribute itself.
const ATOM_MARKERS = [
  "data-candidate-id",
  "dashboardCandidatePrefix",
  "dashboardCandidateWithText",
  "data-standing-family",
  '"dashboard-candidate"',
] as const;

function assertsDashboardAtom(rel: string): boolean {
  const src = SOURCE.get(rel) ?? "";
  return ATOM_MARKERS.some((marker) => src.includes(marker));
}

interface CallSite {
  file: string;
  declaration: string;
  profileVar: string;
  zoneArg: string;
}

/** Every `setFixtureTimezone(db, <profileVar>, "<declaration>", <zone>)` in the tree. */
function callSites(): CallSite[] {
  const re =
    /setFixtureTimezone\(\s*[\w.]+\s*,\s*([\w.]+)\s*,\s*"([^"]+)"\s*,\s*([^)]+?)\s*\)/g;
  const found: CallSite[] = [];
  for (const [file, src] of SOURCE) {
    if (file === "e2e/fixture-timezones.ts") continue;
    for (const m of src.matchAll(re))
      found.push({
        file,
        declaration: m[2],
        profileVar: m[1],
        zoneArg: m[3].trim(),
      });
  }
  return found;
}

/**
 * The login constants through which a seeded profile variable can be reached.
 *
 * Two shapes, both present in the seeds: a login seeded directly onto the profile, and
 * a login seeded onto ANOTHER profile and then granted this one — which is how the
 * west-of-the-date-line Timeline profile is reached, and the case a naive scan misses.
 */
function loginsReaching(file: string, profileVar: string): string[] {
  const src = SOURCE.get(file) ?? "";
  const logins = new Set<string>();

  const direct = new RegExp(
    `seedMemberLogin\\(\\s*(E2E_LOGIN_\\w+)\\s*,\\s*${profileVar}\\b`,
    "g"
  );
  for (const m of src.matchAll(direct)) logins.add(m[1]);

  const loginVars = new Map<string, string>();
  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*seedMemberLogin\(\s*(E2E_LOGIN_\w+)/g
  ))
    loginVars.set(m[1], m[2]);
  const granted = new RegExp(
    `grantProfile\\(\\s*(\\w+)\\s*,\\s*${profileVar}\\b`,
    "g"
  );
  for (const m of src.matchAll(granted)) {
    const login = loginVars.get(m[1]);
    if (login) logins.add(login);
  }
  return [...logins].sort();
}

/** Spec files that name a login constant, and so can drive the profiles it reaches. */
function specsUsingLogin(login: string): string[] {
  const re = new RegExp(`\\b${login}\\b`);
  return SPEC_FILES.filter((rel) => re.test(SOURCE.get(rel) ?? ""));
}

/**
 * Which spec files can reach the profile a call site overrides.
 *
 * A call site inside a spec drives that spec directly (a profile the spec creates at
 * runtime). A call site in a seed is reached through the logins seeded onto it.
 */
function driverSpecs(site: CallSite): string[] {
  if (site.file.endsWith(".spec.ts")) return [site.file];
  return [
    ...new Set(
      loginsReaching(site.file, site.profileVar).flatMap(specsUsingLogin)
    ),
  ].sort();
}

const SITES = callSites();

describe("a fixture with its own calendar is not asserted as a dashboard atom (#3337)", () => {
  it("no own-zone override is reachable from a spec that asserts a dashboard atom", () => {
    const violations: string[] = [];
    for (const site of SITES) {
      const entry =
        FIXTURE_TIMEZONE_OVERRIDES[
          site.declaration as keyof typeof FIXTURE_TIMEZONE_OVERRIDES
        ];
      if (entry?.kind !== "own-zone") continue;
      for (const spec of driverSpecs(site))
        if (assertsDashboardAtom(spec))
          violations.push(`${site.declaration} (${site.file}) → ${spec}`);
    }
    // The message has to say what to DO, because the failure is otherwise a puzzle: the
    // spec that goes red is not the spec that is wrong, and the wrongness is a pairing
    // rather than a line.
    expect(
      violations.sort(),
      "A profile pinned to its own timezone is reachable from a spec asserting a dashboard atom.\n" +
        "Dashboard candidates carry local-time-of-day timing, so that atom appears or moves lane\n" +
        "with the hour the suite starts — red a few hours a day, green the rest (#3260, #3337).\n" +
        "Fix it by making the profile follow the run's pin (build its wall times through the\n" +
        "profile's own zone, as e2e/seed/dashboard.ts's segmented-night fixture does), or by\n" +
        "moving the atom assertion onto a pin-following profile. Do NOT weaken the assertion."
    ).toEqual([]);
  });

  // ---- The census cannot be allowed to under-report -------------------------------
  //
  // Every check above is a scan, and a scan that silently resolves nothing PASSES. Each
  // assertion below fails loudly at the exact point the scan stopped seeing the tree, so
  // a refactor that renames `seedMemberLogin` or moves the overrides cannot quietly turn
  // this file into a test that asserts nothing — which is the failure mode that put the
  // rule it enforces in a comment in the first place.

  it("every declared override is actually used, and every use is declared", () => {
    const declared = Object.keys(FIXTURE_TIMEZONE_OVERRIDES).sort();
    const used = [...new Set(SITES.map((s) => s.declaration))].sort();
    expect(
      used,
      "a setFixtureTimezone call names an undeclared override"
    ).toEqual(expect.arrayContaining([]));
    for (const decl of used)
      expect(declared, `${decl} is called but not declared`).toContain(decl);
    for (const decl of declared)
      expect(used, `${decl} is declared but never used — delete it`).toContain(
        decl
      );
  });

  it("finds the call sites at all", () => {
    // A regex that stops matching would empty every list above and pass everything.
    expect(SITES.length).toBeGreaterThanOrEqual(
      Object.keys(FIXTURE_TIMEZONE_OVERRIDES).length
    );
  });

  it("resolves every seeded override to at least one login and one driving spec", () => {
    for (const site of SITES) {
      if (site.file.endsWith(".spec.ts")) continue;
      const logins = loginsReaching(site.file, site.profileVar);
      expect(
        logins,
        `${site.declaration}: no login found for ${site.profileVar} in ${site.file}. ` +
          `The seed shape changed and this census has stopped seeing it — teach loginsReaching the new shape.`
      ).not.toEqual([]);
      expect(
        driverSpecs(site),
        `${site.declaration}: no spec drives ${logins.join(", ")} — the census resolved a login nothing uses.`
      ).not.toEqual([]);
    }
  });

  it("every run-pin call site passes a zone derived from pinnedTimezone", () => {
    // THE EXEMPTION IS ONLY SOUND WHILE THE LABEL IS TRUE. A "run-pin" entry is skipped
    // by the check above, so a second calendar wearing that label walks straight past
    // the rule — and a label nothing verifies is how #3337 happened.
    //
    // Asked of the CALL rather than of the table: the declaration is a claim about what
    // the seed does, so the zone actually passed is the thing to read. Both current
    // sites bind `const TZ = pinnedTimezone(frozenNow().toISOString()).zone` and pass
    // TZ, which is exactly the shape this accepts — a literal like "UTC" is not.
    for (const site of SITES) {
      const entry =
        FIXTURE_TIMEZONE_OVERRIDES[
          site.declaration as keyof typeof FIXTURE_TIMEZONE_OVERRIDES
        ];
      if (entry?.kind !== "run-pin") continue;
      const src = SOURCE.get(site.file) ?? "";
      const derived = new RegExp(
        `\\b(?:const|let)\\s+${site.zoneArg}\\s*=\\s*pinnedTimezone\\(`
      );
      expect(
        derived.test(src),
        `${site.declaration} is declared "run-pin" but ${site.file} passes ${site.zoneArg}, ` +
          `which is not derived from pinnedTimezone(). Either pass the run's pinned zone, or ` +
          `declare it "own-zone" — and then it may not be reachable from a spec asserting a dashboard atom.`
      ).toBe(true);
    }
  });

  it("recognises a dashboard-atom assertion where one certainly exists", () => {
    // The marker list is the whole sensitivity of this guard, so it is proved against a
    // spec known to assert atoms rather than trusted. dashboard-atomic-personas is the
    // spec #3337 fired in.
    expect(assertsDashboardAtom("e2e/dashboard-atomic-personas.spec.ts")).toBe(
      true
    );
    expect(assertsDashboardAtom("e2e/fixture-timezones.ts")).toBe(false);
  });
});
