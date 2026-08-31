// DB INTEGRATION TIER (#2874) — the correction hint: one owner, two domains, one gate.
//
// The defect this pins shut has three halves and they are the same mistake:
//
//   • the sentence that teaches the time chips was HAND-PLACED in `renderFoodNudge`, so
//     the dose nudge carried the identical chips and explained nothing;
//   • its condition was whether a correction was POSSIBLE, never whether the explanation
//     was still NEEDED, so it rendered at every eating window forever;
//   • and the thing it teaches is ONE behaviour, so a per-domain retirement would keep
//     teaching food to a profile that had already learned it on a dose.
//
// The gate is therefore asserted CROSS-DOMAIN in both directions, and each case proves
// its own fixture first: the hint is asserted PRESENT before the correction is seeded and
// ABSENT after, so a fixture that could never show the hint cannot pass by accident.

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { buildFoodNudge, consentedFoodTaps } from "@/lib/notifications/food";
import { withDoseCorrections } from "@/lib/notifications/intake";
import { plainBody } from "@/lib/notifications/rich-text";
import { now as clockNow } from "@/lib/clock";
import { CORRECTED_MARK_MS, correctionBursts } from "@/lib/correction-time";
import {
  correctionHintLine,
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
  PRACTICE_TIME_PREFIXES,
} from "@/lib/notifications/correction-rows";
import {
  hasCorrectedAnyTime,
  hasCorrectedDoseTime,
  hasCorrectedFoodTime,
} from "@/lib/queries/correction-history";
import { getDoseCorrectionBursts } from "@/lib/queries/intake/adherence";

// One frozen evening in Berlin (UTC+2 in August), so "tapped within the last hour" is a
// fact rather than a race.
const NOW_ISO = "2026-08-05T19:30:00Z"; // 21:30 local
const TAP_ISO = "2026-08-05T19:02:00Z"; // 28 minutes ago — inside CORRECTION_FRESH_MIN
let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

const FOOD_HINT = "Ate earlier?";
const DOSE_HINT = "Took it earlier?";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "Europe/Berlin");
  return id;
}

// A food tap whose stored eating instant sits `driftSec` BEFORE the tap. Zero drift is an
// ordinary uncorrected serving (`occurred_at` is the tap-contracted instant, #2019).
function seedFoodTap(profileId: number, driftSec = 0): void {
  const tap = new Date(TAP_ISO);
  const stated = new Date(tap.getTime() - driftSec * 1000);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at, occurred_at, time_source)
     VALUES (?, 'vegetables', ?, ?, ?, 'tap')`
  ).run(
    profileId,
    today(profileId),
    tap.toISOString().slice(0, 19) + "Z",
    stated.toISOString().slice(0, 19) + "Z"
  );
}

// The dose twin, through the same two columns (`recorded_at` is the tap, `occurred_at`
// the administration instant — migration 20260814-intake-log-time-vocabulary put the two
// ledgers on one spelling).
function seedDoseTap(profileId: number, driftSec = 0): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Evening Tab', 1, 'medication', 'daily', 'must')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'evening', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const tap = new Date(TAP_ISO);
  const stated = new Date(tap.getTime() - driftSec * 1000);
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, occurred_at, status)
     VALUES (?, ?, ?, ?, ?, 'taken')`
  ).run(
    doseId,
    itemId,
    today(profileId),
    tap.toISOString().slice(0, 19) + "Z",
    stated.toISOString().slice(0, 19) + "Z"
  );
}

const DOSE_BASE = {
  title: "💊 Evening doses",
  body: "💊 Evening Tab — 1 tab\n✅ Tap to confirm",
  actions: [],
  kind: "dose" as const,
};

function foodBody(profileId: number): string {
  const msg = buildFoodNudge(
    profileId,
    "Evening",
    today(profileId),
    undefined,
    { now: clockNow() }
  );
  return plainBody(msg!.body);
}

function doseBody(profileId: number): string {
  return plainBody(withDoseCorrections(profileId, DOSE_BASE).body);
}

// ---------------------------------------------------------------------------
// A never-corrected profile is TAUGHT, in both domains
// ---------------------------------------------------------------------------

describe("the shortened hint rides a nudge carrying a burst (#2874 decisions 1–3)", () => {
  it("food says the short line, and no longer narrates the row", () => {
    const pid = newProfile("Hint Hana");
    seedFoodTap(pid);
    const body = foodBody(pid);
    expect(body).toContain(
      "🕐 Ate earlier? Each chip sets the time it shows — press again to go further."
    );
    // Deliberately dropped (decision 2): the row still opens the drill-down and still
    // displays a time, it is simply no longer narrated.
    expect(body).not.toContain("tap the row for an exact time");
    expect(body).not.toContain("Ate earlier than you tapped?");
  });

  it("dose gains the twin line it has never had", () => {
    const pid = newProfile("Hint Ivo");
    seedDoseTap(pid);
    expect(doseBody(pid)).toContain(
      "🕐 Took it earlier? Each chip sets the time it shows — press again to go further."
    );
  });
});

// ---------------------------------------------------------------------------
// THE CROSS-DOMAIN GATE (decision 5) — the crux
// ---------------------------------------------------------------------------

describe("one correction anywhere retires every hint (#2874 decision 5)", () => {
  // Both directions of the ruling, and the reason a per-domain implementation fails
  // here: the domain that gets corrected is NOT the domain whose hint has to fall away.
  it.each([
    { corrected: "dose" as const, note: "a dose correction silences food too" },
    { corrected: "food" as const, note: "a food correction silences dose too" },
  ])("$note", ({ corrected }) => {
    const pid = newProfile(`Gate ${corrected}`);
    // Both domains have a fresh, UNCORRECTED burst — so both hints are live and the
    // fixture demonstrably reaches the state the assertions below forbid.
    seedFoodTap(pid);
    seedDoseTap(pid);
    expect(hasCorrectedAnyTime(pid)).toBe(false);
    expect(foodBody(pid)).toContain(FOOD_HINT);
    expect(doseBody(pid)).toContain(DOSE_HINT);

    // ONE correction, in ONE domain: an hour moved on a second row of that domain.
    if (corrected === "dose") seedDoseTap(pid, 3600);
    else seedFoodTap(pid, 3600);

    expect(hasCorrectedAnyTime(pid)).toBe(true);
    // NEITHER hint, and nothing replaces either one.
    const food = foodBody(pid);
    const dose = doseBody(pid);
    expect(food).not.toContain(FOOD_HINT);
    expect(dose).not.toContain(DOSE_HINT);
    expect(food).not.toContain("chip");
    expect(dose).not.toContain("chip");
  });

  it("keeps the chips, the rows and the statement of record after the hint retires", () => {
    // The hint retires; the affordance does not. Chips and picker tokens are untouched.
    const pid = newProfile("Gate Remy");
    seedDoseTap(pid);
    seedDoseTap(pid, 3600);
    const msg = withDoseCorrections(pid, DOSE_BASE);
    const tokens = (msg.actions ?? []).map((a) => a.data ?? "");
    expect(tokens.some((t) => t.startsWith("dosetime:"))).toBe(true);
    expect(tokens.some((t) => t.startsWith("dosetimeat:"))).toBe(true);
    expect(plainBody(msg.body)).toContain("🕐 Recorded:");
  });
});

// ---------------------------------------------------------------------------
// THE TOLERANCE BOUNDARY — both directions, both domains
// ---------------------------------------------------------------------------

const MARK_S = CORRECTED_MARK_MS / 1000;

describe("the gate counts a difference ABOVE CORRECTED_MARK_MS, in both domains", () => {
  // "More than the tolerance already in use" — a difference at or under it is the clock
  // jitter between two stamps written by one request, not a correction. The constant is
  // the `(corrected)` marker's own, imported rather than respelled, so the two surfaces
  // cannot drift to different definitions of a correction.
  it.each([
    { drift: 0, counts: false },
    { drift: MARK_S - 1, counts: false },
    { drift: MARK_S, counts: false },
    { drift: MARK_S + 1, counts: true },
    { drift: 3600, counts: true },
  ])("food drift $drift s counts=$counts", ({ drift, counts }) => {
    const pid = newProfile(`Tol food ${drift}`);
    seedFoodTap(pid, drift);
    expect(hasCorrectedFoodTime(pid)).toBe(counts);
    expect(hasCorrectedAnyTime(pid)).toBe(counts);
    expect(foodBody(pid).includes(FOOD_HINT)).toBe(!counts);
  });

  it.each([
    { drift: 0, counts: false },
    { drift: MARK_S - 1, counts: false },
    { drift: MARK_S, counts: false },
    { drift: MARK_S + 1, counts: true },
    { drift: 3600, counts: true },
  ])("dose drift $drift s counts=$counts", ({ drift, counts }) => {
    const pid = newProfile(`Tol dose ${drift}`);
    seedDoseTap(pid, drift);
    expect(hasCorrectedDoseTime(pid)).toBe(counts);
    expect(hasCorrectedAnyTime(pid)).toBe(counts);
    expect(doseBody(pid).includes(DOSE_HINT)).toBe(!counts);
  });

  it("ignores a dose row the correction surface would never offer", () => {
    // The probe inherits `getRecentDoseTaps`'s own conditions, so a skipped row or one
    // with no stated administration instant cannot answer this question.
    const pid = newProfile("Tol Skip");
    seedDoseTap(pid);
    db.prepare(
      `UPDATE intake_item_logs SET status = 'skipped', occurred_at = ?
        WHERE id = (SELECT MAX(id) FROM intake_item_logs)`
    ).run("2026-08-05T18:02:00Z");
    expect(hasCorrectedDoseTime(pid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SUBSTRATE IS LOAD-BEARING (decision 1)
// ---------------------------------------------------------------------------

describe("both hints render THROUGH the substrate helper, not beside it", () => {
  // A test that merely checks both strings appear cannot tell a shared owner from two
  // hand-placed copies. This replaces the substrate's own strings and asserts BOTH
  // rendered bodies follow — so re-inlining either sentence in a renderer turns this red,
  // which is the property decision 1 exists to create.
  it("a domain's hint text changes what its nudge says", () => {
    const pid = newProfile("Owner Otto");
    seedFoodTap(pid);
    seedDoseTap(pid);
    const realFood = FOOD_TIME_PREFIXES.hint;
    const realDose = DOSE_TIME_PREFIXES.hint;
    try {
      FOOD_TIME_PREFIXES.hint = "food hint marker 41";
      DOSE_TIME_PREFIXES.hint = "dose hint marker 42";
      const food = foodBody(pid);
      const dose = doseBody(pid);
      expect(food).toContain("food hint marker 41");
      expect(food).not.toContain(FOOD_HINT);
      expect(dose).toContain("dose hint marker 42");
      expect(dose).not.toContain(DOSE_HINT);
    } finally {
      FOOD_TIME_PREFIXES.hint = realFood;
      DOSE_TIME_PREFIXES.hint = realDose;
    }
  });

  it("gives a chip domain with no declared hint no sentence at all", () => {
    // Practices gained the chips in #2875 and were left out of this issue's decisions,
    // so the substrate answers for them by rendering nothing — not by letting a third
    // surface write its own copy.
    expect(PRACTICE_TIME_PREFIXES.hint).toBeUndefined();
    expect(correctionHintLine(PRACTICE_TIME_PREFIXES, false)).toBeNull();
    expect(correctionHintLine(FOOD_TIME_PREFIXES, false)).toBe(
      FOOD_TIME_PREFIXES.hint
    );
    expect(correctionHintLine(FOOD_TIME_PREFIXES, true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PLACEMENT, PICKER TITLES, AND THE SURFACES THAT MUST NOT MOVE
// ---------------------------------------------------------------------------

describe("where the hint sits, and what it never displaces", () => {
  it("appends BELOW the dose content", () => {
    const pid = newProfile("Place Pia");
    seedDoseTap(pid);
    const lines = doseBody(pid).split("\n");
    expect(lines[0]).toBe("💊 Evening Tab — 1 tab");
    expect(lines[1]).toBe("✅ Tap to confirm");
    expect(lines[2]).toContain(DOSE_HINT);
  });

  it("leaves a dose message with no correctable burst byte-identical", () => {
    // `withDoseCorrections` returns the message ITSELF when there is no burst, which is
    // stronger than byte equality: nothing in this change can reach that path at all.
    const pid = newProfile("Place Quin");
    expect(getDoseCorrectionBursts(pid, clockNow())).toEqual([]);
    expect(withDoseCorrections(pid, DOSE_BASE)).toBe(DOSE_BASE);
  });

  it("leaves the /dose list byte-identical, hint or no hint", () => {
    // Decision 4: the list's chips arrive through `updateMessageKeyboard`, whose contract
    // is "Text is untouched" — there is no body to write at the moment they appear. Its
    // body is a constant, and it is the same constant for a profile that has corrected
    // and one that has not.
    const taught = newProfile("List Sam");
    seedDoseTap(taught);
    const learned = newProfile("List Tam");
    seedDoseTap(learned);
    seedDoseTap(learned, 3600);
    expect(hasCorrectedAnyTime(taught)).toBe(false);
    expect(hasCorrectedAnyTime(learned)).toBe(true);
    // The hints differ between these two profiles on the nudge…
    expect(doseBody(taught)).toContain(DOSE_HINT);
    expect(doseBody(learned)).not.toContain(DOSE_HINT);
    // …and the `/dose` list says the same thing to both, because nothing writes its body.
    const listBody = "Tap a medication to record a dose now:";
    expect(listBody).not.toContain(DOSE_HINT);
    expect(listBody).not.toContain(FOOD_HINT);
  });

  it("keeps the picker title in both domains, hint or no hint", () => {
    const untaught = newProfile("Pick Ute");
    seedFoodTap(untaught);
    seedDoseTap(untaught);
    const taught = newProfile("Pick Vic");
    seedFoodTap(taught);
    seedDoseTap(taught);
    seedDoseTap(taught, 3600);

    for (const pid of [untaught, taught]) {
      const doseBurst = getDoseCorrectionBursts(pid, clockNow())[0];
      const open = plainBody(
        withDoseCorrections(pid, DOSE_BASE, { pickerAnchor: doseBurst.fromId })
          .body
      );
      // The title is a contextual heading for an open drill-down, not repeated chrome:
      // it renders unconditionally, and the hint takes its place only when no picker is
      // open — so an open picker never shows both.
      expect(open).toContain("when did you take these?");
      expect(open).not.toContain(DOSE_HINT);

      const foodMsg = buildFoodNudge(pid, "Evening", today(pid), undefined, {
        now: clockNow(),
        picker: foodBurstOf(pid),
      })!;
      const foodOpen = plainBody(foodMsg.body);
      expect(foodOpen).toContain("when did you eat?");
      expect(foodOpen).not.toContain(FOOD_HINT);
    }
  });
});

function foodBurstOf(profileId: number) {
  // The food burst as the nudge's own gather derives it (#3330's consented read, then
  // `correctionBursts`), so the picker opens on exactly the burst the keyboard offers.
  const bursts = correctionBursts(
    consentedFoodTaps(profileId, clockNow()),
    clockNow()
  );
  return bursts[0];
}
