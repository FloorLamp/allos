// DB INTEGRATION TIER — a stored age of 0 is an INFANT, never "unknown" (#2992).
//
// WHY THIS TIER AND NOT THE PURE ONE. The pure life-stage layer already answered 0
// correctly (`lifeStage(0) === "infant"`, and lib/__tests__/life-stage.test.ts has
// pinned `isFoodLoggingRelevant(0) === false` since #591). The defect was never in
// the gates — it was in the single READ that decided what reached them: `getStoredAge`
// required `n > 0`, so a stored "0" came back as `null`, the same value it returns when
// nothing is recorded at all. Because the stored age is the fallback consulted only when
// no birthdate is known, an infant with no DOB arrived at every gate as UNKNOWN, and the
// unknown branch is deliberately permissive (lib/life-stage's documented
// positive-match-only policy: never reshape a page or withhold a surface on missing data).
//
// So a test that only asserts `getStoredAge(p) === 0` cannot observe the bug's
// consequence. Each `it` below therefore drives a REAL GATE through the real read path,
// and every one of them is paired against an unknown-age control in the same file — the
// two answers coinciding IS the defect, so the assertions are only meaningful together.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  adoptProfileFromExtraction,
  getProfileAge,
  getStoredAge,
  setProfileBirthdate,
  setStoredAge,
} from "@/lib/settings/profile-attrs";
import { setProfileSetting } from "@/lib/settings/kv";
import { isFoodLoggingRelevant, isMinor, lifeStage } from "@/lib/life-stage";
import { fastAdultOnlyRefusal, fastingAvailable } from "@/lib/fast-write";
import { adultOnlyRefusal } from "@/lib/instrument-records";
import { getRecordsSpecialtyRelevance } from "@/lib/queries/nav-relevance";
import { reconcileFlags } from "@/lib/queries/medical/flags";
import { reconcileFlagsIfCanonicalChanged } from "@/lib/migrations/boot-tasks";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// An infant recorded the way #2992 describes: an age, and NO birthdate to derive
// one from. That combination is the whole point — with a birthdate the stored age
// is never consulted and the bug is unreachable.
function infantProfile(name: string): number {
  const p = newProfile(name);
  setStoredAge(p, 0);
  return p;
}

// The control: nothing recorded at all. Before #2992 this profile and the one above
// were INDISTINGUISHABLE to every gate below.
function unknownAgeProfile(name: string): number {
  return newProfile(name);
}

describe("stored age 0 round-trips as 0 (#2992)", () => {
  it("writes and reads back 0 rather than collapsing it to null", () => {
    const p = infantProfile("saz round trip");
    expect(getStoredAge(p)).toBe(0);
    // Nothing in the settings layer coerces it away on the way to storage either.
    expect(
      db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'age'"
        )
        .get(p)
    ).toEqual({ value: "0" });
  });

  it("resolves through getProfileAge with no birthdate, and classifies as infant", () => {
    const p = infantProfile("saz profile age");
    expect(getProfileAge(p)).toBe(0);
    expect(lifeStage(getProfileAge(p))).toBe("infant");
  });

  it("still distinguishes a blank stored value from a newborn", () => {
    // `Number("")` and `Number("   ")` are both 0, so the naive `n >= 0` fix would
    // read a blank value as an infant and start HIDING surfaces on a profile whose
    // age is merely unknown. The old `n > 0` bound masked this by accident.
    const p = newProfile("saz blank");
    setProfileSetting(p, "age", "");
    expect(getStoredAge(p)).toBeNull();
    setProfileSetting(p, "age", "   ");
    expect(getStoredAge(p)).toBeNull();
  });

  it("still rejects values no real age can take", () => {
    const p = newProfile("saz junk");
    for (const junk of ["-1", "abc", "150", "0.5"]) {
      setProfileSetting(p, "age", junk);
      expect(getStoredAge(p)).toBeNull();
    }
  });

  it("a birthdate still wins over the stored 0", () => {
    const p = infantProfile("saz birthdate wins");
    setProfileBirthdate(p, "1990-01-01");
    // setProfileBirthdate drops the now-redundant age fallback entirely.
    expect(getStoredAge(p)).toBeNull();
    expect(getProfileAge(p)).toBeGreaterThan(18);
  });
});

describe("life-stage gates reach the INFANT branch for a stored age of 0 (#2992)", () => {
  it("food logging is withheld from the infant and offered on unknown age", () => {
    // The paired assertion is the test: before #2992 both profiles answered `true`,
    // because the infant's age never survived the read.
    expect(
      isFoodLoggingRelevant(getProfileAge(infantProfile("saz food")))
    ).toBe(false);
    expect(
      isFoodLoggingRelevant(getProfileAge(unknownAgeProfile("saz food ctl")))
    ).toBe(true);
  });

  it("isMinor is true for the infant and false on unknown age", () => {
    expect(isMinor(getProfileAge(infantProfile("saz minor")))).toBe(true);
    expect(isMinor(getProfileAge(unknownAgeProfile("saz minor ctl")))).toBe(
      false
    );
  });

  it("the substance-use and mental-health panes hide for the infant", () => {
    const infant = getRecordsSpecialtyRelevance(infantProfile("saz specialty"));
    expect(infant.substanceUse).toBe(false);
    expect(infant.mentalHealth).toBe(false);

    const unknown = getRecordsSpecialtyRelevance(
      unknownAgeProfile("saz specialty ctl")
    );
    expect(unknown.substanceUse).toBe(true);
    expect(unknown.mentalHealth).toBe(true);
  });

  it("the adult-only INSTRUMENT write core refuses a substance score for the infant", () => {
    // lib/adult-only-writes.ts declares this a high-stakes path: the refusal lives in
    // the write core precisely because a Server Action is independently POST-callable.
    expect(adultOnlyRefusal(infantProfile("saz instrument"), "AUDIT-C")).toBe(
      true
    );
    expect(
      adultOnlyRefusal(unknownAgeProfile("saz instrument ctl"), "AUDIT-C")
    ).toBe(false);
    // A mental-health instrument is not adult-only, so the gate stays off for it —
    // this bit must not move just because the age now resolves.
    expect(adultOnlyRefusal(infantProfile("saz instrument mh"), "PHQ-9")).toBe(
      false
    );
  });

  it("the fasting write gate refuses for the infant and its read twin agrees", () => {
    const infant = infantProfile("saz fasting");
    expect(fastAdultOnlyRefusal(infant)).toBe(true);
    expect(fastingAvailable(infant)).toBe(false);

    const unknown = unknownAgeProfile("saz fasting ctl");
    expect(fastAdultOnlyRefusal(unknown)).toBe(false);
    expect(fastingAvailable(unknown)).toBe(true);
  });
});

describe("document adoption can record an age of 0 (#2992)", () => {
  const meta = (patient_age: number | null) => ({
    patient_sex: null,
    patient_birthdate: null,
    patient_age,
    patient_name: null,
  });

  it("adopts a stated age of 0 and the gates see the infant", () => {
    // The path that made this LIVE rather than latent: both hand-entry forms
    // validated the age themselves, but document adoption writes whatever
    // normalizeAge returned.
    const p = newProfile("saz adopt zero");
    const out = adoptProfileFromExtraction(p, meta(0));
    expect(out.age).toBe(0);
    expect(out.changed).toBe(true);
    expect(getStoredAge(p)).toBe(0);
    expect(fastAdultOnlyRefusal(p)).toBe(true);
  });

  it("does not treat an adopted 0 as 'no age recorded' on a later document", () => {
    // The only-when-unset backfill asks `getStoredAge(...) === null`. While 0 read
    // back as null, a second document could silently overwrite the infant's recorded
    // age — the write guard was reading the same conflated answer as the gates.
    const p = newProfile("saz adopt no overwrite");
    adoptProfileFromExtraction(p, meta(0));
    const out = adoptProfileFromExtraction(p, meta(42));
    expect(out.age).toBeNull();
    expect(getStoredAge(p)).toBe(0);
  });
});

// ── The boot reconcile must agree with the request-time one (#2992 R1) ──────────
//
// `profile_settings.age` has exactly TWO readers in the repo, and they are found by
// grepping the KEY rather than any identifier — what makes something a reader is the
// column it reads, not what it calls itself:
//
//   lib/settings/profile-attrs.ts   getStoredAge   (request path)
//   lib/migrations/boot-tasks.ts    readAge        (boot path, an inline copy that
//                                                   cannot import the first — bootTasks
//                                                   runs version-agnostically and needs
//                                                   the legacy global fallback)
//
// Both feed the SAME pure computeFlagReconciliation, under a comment promising "the
// boot-time reconcile and the request-time one can't drift". Fixing the bound in only
// one of them is WORSE than the original defect: while both readers were equally blind
// a newborn simply kept its adult-band flags, but a half-fixed pair has request-time
// clearing an adult ALP/BP claim off an infant's row and the next boot reconcile
// writing it straight back — the stored `flag` column becomes a function of which pass
// ran last. #2794's whole purpose is clearing adult-band BP claims off pediatric rows,
// so it must be able to reach a newborn.
describe("boot and request flag reconciles agree for a stored age of 0 (#2992 R1)", () => {
  function flagOf(id: number): string | null {
    return (
      (
        db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as
          { flag: string | null } | undefined
      )?.flag ?? null
    );
  }

  // Force the once-per-signature-change gate to fire, the way a release that moves
  // canonicalFlagsSignature() (or the first boot after a restored backup) does.
  function runBootReconcile() {
    db.prepare("DELETE FROM settings WHERE key = 'canonical_flags_sig'").run();
    reconcileFlagsIfCanonicalChanged(db);
  }

  // A profile with a stored age and NO birthdate, carrying the two adult-band claims
  // the boot pass exists to clear: an ALP of 300 U/L (normal in the pediatric band,
  // "high" against the adult 40–129) and a diastolic of 54 mmHg ("low" against the
  // adult 60–80, but a percentile question below 13 per #2794).
  function agedProfileWithAdultBandFlags(name: string, age: number) {
    const p = newProfile(name);
    setStoredAge(p, age);
    setProfileSetting(p, "sex", "female");
    const date = today(p);
    const insert = (
      canonical: string,
      value: number,
      unit: string,
      flag: string
    ) =>
      Number(
        db
          .prepare(
            `INSERT INTO medical_records
               (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
             VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
          )
          .run(p, date, canonical, String(value), unit, canonical, value, flag)
          .lastInsertRowid
      );
    return {
      p,
      alp: insert("Alkaline Phosphatase", 300, "U/L", "high"),
      bp: insert("Blood Pressure Diastolic", 54, "mmHg", "low"),
    };
  }

  it("the boot pass does not re-write flags the request pass just cleared", () => {
    const { p, alp, bp } = agedProfileWithAdultBandFlags(
      "saz newborn flags",
      0
    );

    reconcileFlags(p);
    const afterRequest = { alp: flagOf(alp), bp: flagOf(bp) };

    runBootReconcile();
    const afterBoot = { alp: flagOf(alp), bp: flagOf(bp) };

    // THE ASSERTION THAT MATTERS: agreement. Stated as a comparison rather than as two
    // literals so it keeps holding if the clinically-correct answer for an infant is
    // ever revised — what must never happen is the two passes disagreeing.
    expect(afterBoot).toEqual(afterRequest);

    // And concretely, for this newborn: neither adult-band claim survives either pass.
    // `pediatricBpContext(0)` is null — the pediatric regime declines below 1 y and
    // there is no normative table beneath it — so an infant's BP gets NO judgment
    // rather than an adult-band one. That is the correct answer absent infant
    // normative data, and it is deliberate, not a regression.
    expect(afterRequest).toEqual({ alp: null, bp: null });
  });

  it("still agrees for a toddler, the case that already worked", () => {
    // Age 2 cleared the old `n > 0` bound in BOTH readers, so this passed before
    // #2992 and must keep passing — the fix must not disturb the non-zero path.
    const { p, alp, bp } = agedProfileWithAdultBandFlags(
      "saz toddler flags",
      2
    );

    reconcileFlags(p);
    const afterRequest = { alp: flagOf(alp), bp: flagOf(bp) };
    runBootReconcile();
    expect({ alp: flagOf(alp), bp: flagOf(bp) }).toEqual(afterRequest);
  });

  it("still agrees when the age is genuinely unknown", () => {
    // The control for the whole file: with nothing recorded, both readers answer null
    // and the adult bands legitimately apply. Proves the agreement assertion above is
    // not vacuously true of every profile.
    const { p, alp, bp } = agedProfileWithAdultBandFlags(
      "saz unknown flags",
      0
    );
    setProfileSetting(p, "age", "");

    reconcileFlags(p);
    const afterRequest = { alp: flagOf(alp), bp: flagOf(bp) };
    runBootReconcile();
    expect({ alp: flagOf(alp), bp: flagOf(bp) }).toEqual(afterRequest);
    // Unknown age keeps the adult-band ALP claim — the positive-match-only policy.
    expect(afterRequest.alp).toBe("high");
  });
});
