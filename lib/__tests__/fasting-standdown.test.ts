import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAST_SUPPRESSIBLE_KINDS,
  isFastSuppressibleKind,
  standsDownForFast,
  standsDownUsualRoutine,
} from "../fasting-standdown";
import {
  ALL_NOTIFICATION_KINDS,
  SAFETY_NOTIFICATION_KINDS,
} from "../notifications/kinds";
import type { NotificationKind } from "../notifications/types";
import { type Fast } from "../fasting";
import { EPISODE_BOUNDS } from "../open-episode";

const FAST_STALE_HOURS = EPISODE_BOUNDS.fast.staleMin / 60;

// The fasting stand-down's SAFETY PROOF (#2757).
//
// Standing a nudge down is the shape that silences things, so these tests are written
// to FALSIFY the claim "a fast can only silence a food nudge" rather than to
// demonstrate the happy path. Concretely:
//
//   • the allowlist is quantified over the WHOLE `NotificationKind` union, so a kind
//     added to the app next month is covered here without anyone remembering this file;
//   • the safety-class kinds are named INDIVIDUALLY as well as set-wise, because a
//     disjointness assertion between two sets both derived from the same registry can
//     pass vacuously if the registry itself drifts;
//   • the suppression is proved to require BOTH halves, so neither an active fast alone
//     nor a food kind alone silences anything.

const ACTIVE: Fast = {
  id: 1,
  started_at: "2026-08-16T08:00:00Z",
  ended_at: null,
  note: null,
};

// An instant at which ACTIVE is running and still PLAUSIBLE (4 h in). Every assertion
// below that was written before the staleness term (#2757 D4) judges the fast at this
// instant, so the term changed the signature and not one verdict.
const AT = new Date("2026-08-16T12:00:00Z");

// The same fast, judged past FAST_STALE_HOURS. A row this old is evidence that somebody
// abandoned it, not evidence that they are not eating.
const AT_STALE = new Date(
  Date.parse(ACTIVE.started_at) + (FAST_STALE_HOURS + 1) * 3_600_000
);

describe("fasting stand-down — what a fast may silence (#2757)", () => {
  it("suppresses ONLY the food kind, across the entire notification union", () => {
    const suppressible = ALL_NOTIFICATION_KINDS.filter((k) =>
      isFastSuppressibleKind(k)
    );
    expect(suppressible).toEqual(["food"]);
  });

  it("never reaches a safety-class kind", () => {
    const overlap = [...SAFETY_NOTIFICATION_KINDS].filter((k) =>
      FAST_SUPPRESSIBLE_KINDS.has(k)
    );
    expect(
      overlap,
      "a fast must never be able to silence a safety-class send — " +
        "see lib/fasting-standdown.ts for why this set is an allowlist"
    ).toEqual([]);
  });

  // Named one by one, deliberately. The set-wise check above is derived from the same
  // registry the app is, so if SAFETY_NOTIFICATION_KINDS ever lost a member the
  // disjointness would still pass while the protection quietly disappeared. These
  // literals cannot drift with it.
  it.each([
    ["dose", "scheduled dose reminder"],
    ["escalation", "missed-dose escalation"],
    ["redose", "PRN redose-window notice"],
    ["refill", "running-low nudge"],
    ["followup", "overdue safety follow-up"],
    ["illness-care", "care finding from logged symptoms"],
    ["preventive", "preventive-care nudge"],
    ["digest", "morning digest"],
    ["mood", "mood check-in"],
    ["wear-reminder", "bedtime watch reminder"],
    ["workout", "workout reminder"],
    ["practice", "practice pace nudge"],
  ] as const)("an active fast never stands down %s (%s)", (kind, _what) => {
    expect(standsDownForFast(ACTIVE, kind as NotificationKind, AT)).toBe(false);
  });

  it("stands the food nudge down only while a fast is ACTIVE", () => {
    expect(standsDownForFast(ACTIVE, "food", AT)).toBe(true);
    expect(standsDownForFast(null, "food", AT)).toBe(false);
  });

  it("requires BOTH halves — an active fast alone silences nothing", () => {
    // Every non-food kind, with a fast running. If either half of the predicate were
    // dropped this is the assertion that fails.
    for (const kind of ALL_NOTIFICATION_KINDS) {
      if (kind === "food") continue;
      expect(
        standsDownForFast(ACTIVE, kind, AT),
        `${kind} was suppressed by an active fast`
      ).toBe(false);
    }
  });

  it("stands the usual-routine OFFER down while a fast is active", () => {
    expect(standsDownUsualRoutine(ACTIVE, AT)).toBe(true);
    expect(standsDownUsualRoutine(null, AT)).toBe(false);
  });
});

// D4: A SUPPRESSION MUST BE ABLE TO END BY ITSELF.
//
// "Derived, so it self-heals when the fast ends" is only true if the fast ends. An
// active row can sit there for days — a backdated start, a fast nobody closed — and
// while it does, the food nudge is silent and the ONLY thing that would tell the user is
// a card on the page the silenced nudge existed to bring them to. So the stand-down is
// bounded by the same plausibility bound the surface uses: once a fast reads STALE it has
// stopped being evidence of not-eating and the nudge comes back.
describe("the stand-down expires with the claim's plausibility (#2757)", () => {
  it("stops suppressing the food nudge once the fast reads STALE", () => {
    expect(standsDownForFast(ACTIVE, "food", AT)).toBe(true);
    expect(standsDownForFast(ACTIVE, "food", AT_STALE)).toBe(false);
  });

  it("restores the usual-routine offer once the fast reads STALE", () => {
    expect(standsDownUsualRoutine(ACTIVE, AT)).toBe(true);
    expect(standsDownUsualRoutine(ACTIVE, AT_STALE)).toBe(false);
  });

  it("holds right up to the bound and releases exactly at it", () => {
    const started = Date.parse(ACTIVE.started_at);
    const justUnder = new Date(started + (FAST_STALE_HOURS - 0.01) * 3_600_000);
    const atBound = new Date(started + FAST_STALE_HOURS * 3_600_000);
    expect(standsDownForFast(ACTIVE, "food", justUnder)).toBe(true);
    expect(standsDownForFast(ACTIVE, "food", atBound)).toBe(false);
  });

  it("a 13-day backdated start suppresses NOTHING, at any kind", () => {
    // The D4 scenario exactly: a start inside FAST_MAX_HOURS, so the row is storable and
    // active, but far past the plausibility bound. It must silence nothing at all.
    const backdated: Fast = {
      id: 2,
      started_at: "2026-08-03T08:00:00Z",
      ended_at: null,
      note: null,
    };
    for (const kind of ALL_NOTIFICATION_KINDS) {
      expect(
        standsDownForFast(backdated, kind, AT),
        `${kind} was suppressed by a 13-day-old abandoned fast`
      ).toBe(false);
    }
    expect(standsDownUsualRoutine(backdated, AT)).toBe(false);
  });
});

// The stand-down stores NOTHING. #2757 rules it derived precisely so it self-heals when
// the fast ends and there is nothing to sweep — a stored suppression flag would be a row
// that outlives its reason. This reads the module's own source, the same shape as the
// repo's other registry scans, so the property is enforced rather than described.
describe("the stand-down is derived, not stored (#2757)", () => {
  const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const raw = fs.readFileSync(
    path.join(REPO, "lib/fasting-standdown.ts"),
    "utf8"
  );
  // CODE only. The module's header discusses the very systems it must not touch — that
  // is the documentation doing its job — so a text scan that counted prose would either
  // fail on a correct file or force the reasoning out of it. Comments are stripped so
  // the assertions below are about what the module DOES.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  it("writes nothing", () => {
    for (const marker of [
      "writeTx",
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
      "setProfileSetting",
      "setSetting",
    ]) {
      expect(code, `lib/fasting-standdown.ts must not ${marker}`).not.toContain(
        marker
      );
    }
  });

  it("touches neither the dismissal bus, notify_lifecycle, nor send markers", () => {
    // "Disjoint by construction" is the claim #2757 makes; these are the systems it
    // names as the ones this must not become entangled with.
    expect(code).not.toContain("upcoming_dismissals");
    expect(code).not.toContain("notify_lifecycle");
    expect(code).not.toContain("send-markers");
  });

  it("imports only TYPES — it can reach no runtime state at all", () => {
    const imports = [
      ...code.matchAll(/^import\s+([\s\S]*?)from\s+"([^"]+)"/gm),
    ];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, clause, from] of imports) {
      expect(
        clause.includes("type"),
        `lib/fasting-standdown.ts imports a VALUE from ${from} — it must stay pure`
      ).toBe(true);
    }
  });
});
