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
import type { Fast } from "../fasting";

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
    expect(standsDownForFast(ACTIVE, kind as NotificationKind)).toBe(false);
  });

  it("stands the food nudge down only while a fast is ACTIVE", () => {
    expect(standsDownForFast(ACTIVE, "food")).toBe(true);
    expect(standsDownForFast(null, "food")).toBe(false);
  });

  it("requires BOTH halves — an active fast alone silences nothing", () => {
    // Every non-food kind, with a fast running. If either half of the predicate were
    // dropped this is the assertion that fails.
    for (const kind of ALL_NOTIFICATION_KINDS) {
      if (kind === "food") continue;
      expect(
        standsDownForFast(ACTIVE, kind),
        `${kind} was suppressed by an active fast`
      ).toBe(false);
    }
  });

  it("stands the usual-routine OFFER down while a fast is active", () => {
    expect(standsDownUsualRoutine(ACTIVE)).toBe(true);
    expect(standsDownUsualRoutine(null)).toBe(false);
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
    const imports = [...code.matchAll(/^import\s+([\s\S]*?)from\s+"([^"]+)"/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, clause, from] of imports) {
      expect(
        clause.includes("type"),
        `lib/fasting-standdown.ts imports a VALUE from ${from} — it must stay pure`
      ).toBe(true);
    }
  });
});
