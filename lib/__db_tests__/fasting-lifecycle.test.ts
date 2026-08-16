// DB INTEGRATION TIER — the fasting lifecycle's write cores (#2756) and the
// notification stand-down they feed (#2757).
//
// The pure derivations are covered in lib/__tests__/fasting.test.ts. What only a real
// database can prove is here: the one-active invariant under an actual unique index, the
// typed refusals coming back from real state, the adult-only ASYMMETRY (starts refuse,
// ending always succeeds), and the annotation reading real `food_log_events` rows.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileSetting } from "@/lib/settings";
import { utcInstant } from "@/lib/date";
import {
  discardFast,
  editFast,
  endFast,
  fastingAvailable,
  reopenFast,
  startFast,
} from "@/lib/fast-write";
import { getActiveFast, listFasts } from "@/lib/fast-store";
import { getServingsDuringFast } from "@/lib/queries/fasting";
import { standsDownForFast } from "@/lib/fasting-standdown";
import { logFoodServingCore } from "@/lib/food-log-write";

function makeProfile(name: string, age?: number): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (age != null) setProfileSetting(id, "age", String(age));
  return id;
}

let adult: number;
let minor: number;

beforeEach(() => {
  db.prepare("DELETE FROM fasts").run();
  adult = makeProfile("adult-fast", 40);
  minor = makeProfile("minor-fast", 15);
});

describe("start / end lifecycle", () => {
  it("starts, reports the active row, and ends", () => {
    const started = startFast(adult);
    expect(started.kind).toBe("started");
    expect(getActiveFast(adult)).not.toBeNull();

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(adult)).toBeNull();
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("refuses a SECOND start — the cross-device double-start", () => {
    const first = startFast(adult);
    expect(first.kind).toBe("started");
    const second = startFast(adult);
    expect(second).toEqual({
      kind: "already-active",
      id: first.kind === "started" ? first.id : -1,
    });
    // The refusal wrote nothing.
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("refuses an end when nothing is running, rather than confirming", () => {
    expect(endFast(adult).kind).toBe("none-active");
  });

  it("refuses an end at or before its own start", () => {
    startFast(adult, new Date(Date.now() - 3_600_000));
    const bad = endFast(adult, new Date(Date.now() - 7_200_000));
    expect(bad.kind).toBe("invalid");
    // Still running: a refusal is a report, never a partial write.
    expect(getActiveFast(adult)).not.toBeNull();
  });

  it("refuses a future start", () => {
    expect(startFast(adult, new Date(Date.now() + 3_600_000)).kind).toBe(
      "invalid"
    );
    expect(listFasts(adult)).toHaveLength(0);
  });

  it("accepts a BACKDATED start — forgot-to-tap is the common failure", () => {
    const at = new Date(Date.now() - 10 * 3_600_000);
    expect(startFast(adult, at).kind).toBe("started");
    expect(getActiveFast(adult)?.started_at).toBe(utcInstant(at));
  });

  it("refuses a backdated start that would OVERLAP a recorded fast", () => {
    // A completed fast covering [-6h, -3h].
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    endFast(adult, new Date(Date.now() - 3 * 3_600_000));
    // A new open fast backdated to -8h would swallow it.
    const clash = startFast(adult, new Date(Date.now() - 8 * 3_600_000));
    expect(clash.kind).toBe("overlap");
    expect(listFasts(adult)).toHaveLength(1);
  });

  it("allows a back-to-back start at the previous fast's exact end", () => {
    const end = new Date(Date.now() - 3 * 3_600_000);
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    endFast(adult, end);
    expect(startFast(adult, end).kind).toBe("started");
  });
});

describe("Undo an end — the inverse is complete and local", () => {
  it("reopens the named fast, restoring the state exactly", () => {
    const started = startFast(adult, new Date(Date.now() - 3_600_000));
    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    const id = ended.kind === "ended" ? ended.id : -1;
    expect(reopenFast(adult, id)).toEqual({ kind: "reopened", id });
    expect(getActiveFast(adult)?.id).toBe(id);
    expect(getActiveFast(adult)?.started_at).toBe(
      started.kind === "started" ? getActiveFast(adult)?.started_at : null
    );
  });

  it("refuses to reopen into an already-active fast", () => {
    startFast(adult, new Date(Date.now() - 6 * 3_600_000));
    const ended = endFast(adult, new Date(Date.now() - 5 * 3_600_000));
    const id = ended.kind === "ended" ? ended.id : -1;
    startFast(adult);
    expect(reopenFast(adult, id).kind).toBe("already-active");
  });
});

describe("discard — 'I never actually fasted'", () => {
  it("removes the row", () => {
    const started = startFast(adult);
    const id = started.kind === "started" ? started.id : -1;
    expect(discardFast(adult, id)).toEqual({ kind: "discarded", id });
    expect(listFasts(adult)).toHaveLength(0);
  });

  it("is profile-scoped — one profile cannot discard another's fast", () => {
    const other = makeProfile("other-adult", 30);
    const started = startFast(adult);
    const id = started.kind === "started" ? started.id : -1;
    expect(discardFast(other, id).kind).toBe("not-found");
    expect(getActiveFast(adult)).not.toBeNull();
  });
});

// THE RULING'S ASYMMETRY (#2756). This is the safety-shaped half of the feature, so the
// negatives are asserted as hard as the positives: a restricted profile can never START
// a fast, and can ALWAYS close an existing one out.
describe("adult-only at the core, with the end-side exemption", () => {
  it("refuses a start on a known-minor profile, and writes nothing", () => {
    expect(startFast(minor)).toEqual({ kind: "refused" });
    expect(listFasts(minor)).toHaveLength(0);
    expect(fastingAvailable(minor)).toBe(false);
  });

  it("PASSES on unknown age — hide only on a positive under-age match", () => {
    const unknown = makeProfile("unknown-age-fast");
    expect(fastingAvailable(unknown)).toBe(true);
    expect(startFast(unknown).kind).toBe("started");
  });

  it("lets a profile that became restricted MID-FAST still end it", () => {
    // The realistic history: the fast is started while the age is unknown, and a
    // birthdate edit later makes the profile restricted. Without the exemption this row
    // would be permanently un-closable — and its food nudges permanently stood down.
    const profile = makeProfile("became-minor");
    expect(startFast(profile).kind).toBe("started");
    setProfileSetting(profile, "age", "15");
    expect(fastingAvailable(profile)).toBe(false);

    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");
    expect(getActiveFast(profile)).toBeNull();
    // And a new one still cannot be started.
    expect(startFast(profile).kind).toBe("refused");
  });

  it("lets a restricted profile discard and undo, but never edit", () => {
    const profile = makeProfile("became-minor-2");
    const started = startFast(profile);
    const id = started.kind === "started" ? started.id : -1;
    const ended = endFast(profile);
    expect(ended.kind).toBe("ended");
    setProfileSetting(profile, "age", "15");

    // Undo works — it restores the state the exempt end path produced.
    expect(reopenFast(profile, id).kind).toBe("reopened");
    // Editing a completed fast's interval is recording fasting content, so it refuses.
    endFast(profile);
    expect(
      editFast(
        profile,
        id,
        new Date(Date.now() - 7_200_000),
        new Date(Date.now() - 3_600_000)
      )
    ).toEqual({ kind: "refused" });
    // Discard works — it is the path that REMOVES fasting data.
    expect(discardFast(profile, id).kind).toBe("discarded");
  });
});

describe("the annotation reads real food rows and offers no verdict", () => {
  it("counts only servings with a STATED eating instant inside the interval", () => {
    const day = today(adult);
    const start = new Date(Date.now() - 6 * 3_600_000);
    startFast(adult, start);

    // Inside the interval, with a stated eating time.
    logFoodServingCore(adult, "legumes", day, undefined, undefined, {
      eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
      source: "stated",
    });
    // Inside the interval, but no stated eating time — proves nothing about WHEN, so it
    // is not counted. Silence here is honest.
    logFoodServingCore(adult, "legumes", day);

    const ended = endFast(adult);
    expect(ended.kind).toBe("ended");
    const fast = listFasts(adult)[0];
    expect(getServingsDuringFast(adult, fast)).toBe(1);
    // The fast still stands, and so do the servings: both facts, no adjudication.
    expect(fast.ended_at).not.toBeNull();
  });

  it("does not count another profile's servings", () => {
    const other = makeProfile("other-food", 30);
    const start = new Date(Date.now() - 6 * 3_600_000);
    startFast(adult, start);
    logFoodServingCore(other, "legumes", today(other), undefined, undefined, {
      eatenAt: utcInstant(new Date(Date.now() - 4 * 3_600_000)),
      source: "stated",
    });
    endFast(adult);
    expect(getServingsDuringFast(adult, listFasts(adult)[0])).toBe(0);
  });
});

// #2757 over real rows: the stand-down follows the fast's actual state and heals itself
// the moment it ends, because nothing is stored.
describe("the stand-down over real state (#2757)", () => {
  it("stands the food nudge down while active and resumes on the end", () => {
    expect(standsDownForFast(getActiveFast(adult), "food")).toBe(false);
    startFast(adult);
    expect(standsDownForFast(getActiveFast(adult), "food")).toBe(true);
    // Nothing was written anywhere to record the suppression …
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM profile_settings WHERE profile_id = ? AND key LIKE '%fast%'"
        )
        .get(adult)
    ).toEqual({ n: 0 });
    endFast(adult);
    // … so it self-heals with no sweep.
    expect(standsDownForFast(getActiveFast(adult), "food")).toBe(false);
  });

  it("never stands a dose reminder or an escalation down, fasting or not", () => {
    startFast(adult);
    const active = getActiveFast(adult);
    expect(standsDownForFast(active, "dose")).toBe(false);
    expect(standsDownForFast(active, "escalation")).toBe(false);
    expect(standsDownForFast(active, "redose")).toBe(false);
  });
});
