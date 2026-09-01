import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findTags, scanDirs, REPO } from "./jsx-tag-scan";

// One "when" control (issue #2236), ratcheted in the repo's established
// source-scan idiom (`icon-button-tooltip-scan.test.ts`, `page-width-scan.
// test.ts`): read the app's own TSX as TEXT — no DB, no network, so it stays
// "pure" — and fail the build when a NEW raw `<input type="time">` ships
// outside the shared control.
//
// WHY. "When did this happen?" was asked by ten hand-rolled controls in four
// vocabularies, and every one privately re-decided the five behavioural rules
// the question carries (the pair moves together; null means "not stated"; a
// stated time is never seeded from a record stamp; never default to now, offer
// "now"; absolute local times only). `components/WhenControl.tsx` owns those
// rules now, and the raw time input lives THERE and nowhere else.
//
// THE RATCHET. The hand-rolled set below is frozen at its current counts, each
// with the reason it is still allowed. An `event` entry is debt: it migrates to
// the shared control when its surface is touched (#2227/#2228/#2235 are the
// filed first movers), and its count may only SHRINK — shrinking updates the
// entry, growing fails the build. A `plan` entry is out of the control's scope
// on purpose: a notification slot or an appointment time states a PLAN, not an
// observation, so "when did this happen?" is not its question and it is not
// expected to migrate.

const SCAN_DIRS = ["app", "components"];

/** The one legitimate home of a raw event-time input. */
const CONTROL_FILE = "components/WhenControl.tsx";

/** The frozen hand-rolled set: file → { count, kind, reason }. */
const HANDROLLED_ALLOW = new Map<
  string,
  { count: number; kind: "event" | "plan"; reason: string }
>([
  // MeasurementsQuickAdd.tsx left the list with #2154's write half: the two
  // per-measure time inputs (temperature, peak flow) folded into the form's one
  // shared Time control, whose statement now lands on occurred_at.
  // HistoricalDoseForm.tsx and EpisodeTimeline.tsx left the list with #2228's
  // write half: both adopt the shared control (backfill = state + timeRequired,
  // amend = correct with "Not stated" reachable).
  // SymptomLogBar.tsx left it on the touch its own entry named (#4424 ruling 5): the
  // temperature reading time is WhenControl's now, day-fixed to the card's date.
  // PracticeSessionHistory.tsx left it on #4424 ruling 1's touch: its edit form spelled
  // the same five fields the log form did, so it now MOUNTS that form and the pair it
  // carried is GONE rather than migrated.
  //
  // AND TWO MOUNTS MOVED THE OTHER WAY, which is a trade rather than a win and is
  // stated here rather than smuggled: the `/history` add door's practice case and that
  // record row's correction each stated a START through `WhenControl` and could not
  // state an END at all, so a window stated in the expanded form was correctable on
  // exactly one surface. Both mount the one form now, which states the RANGE — the
  // shape this entry exists for. The ratchet's count does not move, because the pair is
  // spelled once and four surfaces mount it.
  [
    "components/practices/PracticeSessionForm.tsx",
    {
      count: 2,
      kind: "event",
      reason:
        "the #3142 detailed practice start/end pair — the SAME range shape as the " +
        "activity start/end pair below, unmodelled by the control for the same " +
        "reason. #3143 extracted the deliberate historical form from the quick " +
        "intent control so backfill remains exempt; the same two inputs moved, " +
        "not grew. #4424 ruling 1 made this THE practice form — add and edit, at " +
        "every mount — so four spellings of the pair are now this one. Migrates " +
        "with DateTimeFields when the control grows a range form",
    },
  ],
  [
    "components/activity-form/DateTimeFields.tsx",
    {
      count: 2,
      kind: "event",
      reason:
        "activity start/end pair — two times sharing one day, a shape the " +
        "control does not model yet; migrates when it grows a range form",
    },
  ],
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    {
      count: 2,
      kind: "event",
      reason:
        "the #1851 bed\u2192wake pair — the same range shape as the activity " +
        "start/end pair above and unmodelled for the same reason, plus one of " +
        "its own: NEITHER clock states a date. The wake day is the sitting's, " +
        "the bed day is DERIVED from the clock against the noon anchor, and " +
        "the pair resolves to instants in the PROFILE's zone at the write " +
        "boundary rather than the browser's. Migrates with DateTimeFields " +
        "when the control grows a range form. The form's own sitting Time is " +
        "still WhenControl's and is not counted here.",
    },
  ],
  [
    "app/(app)/settings/notifications/NotificationPrefs.tsx",
    {
      count: 3,
      kind: "plan",
      reason:
        "notification slot times state a PLAN (a schedule), not an observed " +
        "event — permanently out of the control's scope",
    },
  ],
  [
    "app/(app)/encounters/AppointmentForm.tsx",
    {
      count: 1,
      kind: "plan",
      reason:
        "an appointment time states a PLAN, not an observation — permanently " +
        "out of the control's scope",
    },
  ],
]);

/**
 * Every `<input …>` opening tag whose attributes carry `type="time"`, as line
 * numbers. Attribute values may span lines and contain braces/templates (an
 * onChange arrow's `=>` must not read as the tag's `>`), and a tag mentioned
 * inside a comment is not a tag — both handled by the shared reader in
 * ./jsx-tag-scan rather than by a regex.
 */
export function rawTimeInputs(text: string): number[] {
  return findTags(text, "input", (attrs) =>
    /(?:^|\s)type\s*=\s*"time"/.test(attrs)
  );
}

const scanRepo = () => scanDirs(SCAN_DIRS, rawTimeInputs);

const HOW = [
  'A raw <input type="time"> asks "when did this happen?" without the shared',
  "rules that question carries. Render <WhenControl> (components/WhenControl",
  '.tsx) instead — it owns the date+time pair, the null = "not stated" value,',
  'the never-default-to-now rule and the one-tap "now". A time that states a',
  'PLAN rather than an observation may be allowlisted here as kind: "plan",',
  "with the reason said.",
].join("\n");

describe('raw <input type="time"> ratchet (issue #2236)', () => {
  const found = scanRepo();

  it("the shared control itself renders one — the scan is not silently empty", () => {
    expect(found.get(CONTROL_FILE)).toHaveLength(1);
  });

  it("every raw time input outside the control is a frozen, reasoned entry", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of found) {
      if (rel === CONTROL_FILE) continue;
      const allowed = HANDROLLED_ALLOW.get(rel);
      if (!allowed) {
        offenders.push(`${rel}:${lines.join(",")} — not in HANDROLLED_ALLOW`);
      } else if (lines.length > allowed.count) {
        offenders.push(
          `${rel} grew: ${lines.length} raw time inputs, allowlisted at ` +
            `${allowed.count} — the count only shrinks`
        );
      }
    }
    expect(offenders, `${HOW}\n\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the allowlist counts are current — a migrated surface leaves the list", () => {
    const stale: string[] = [];
    for (const [rel, allowed] of HANDROLLED_ALLOW) {
      const lines = found.get(rel) ?? [];
      if (lines.length < allowed.count) {
        stale.push(
          `${rel}: allowlisted at ${allowed.count} but ${lines.length} remain ` +
            "— shrink (or remove) its entry so the ratchet holds"
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});

// ── THE UNION (issue #3273) ─────────────────────────────────────────────────
//
// The ratchet above catches a NEW raw time input. It cannot catch the other half of
// the same divergence: a form that writes an instant and offers no time affordance at
// all, or hand-rolls one out of BUTTONS (the food bar's "Eaten: Now / Earlier…" chips
// were exactly that, and chips are not inputs, so the scan above was structurally
// blind to them). #3273's acceptance is the UNION — every quick-log sheet form that
// writes an instant either mounts the shared control or says here why it does not.
//
// The sheet dispatches NINE forms (QuickEntryProvider's switch); eight are below.
// The ninth is `document`, a file upload — it writes no instant of its own, so "when
// did this happen?" is not a question it has to answer and it is not debt.
//
// The list is HAND-WRITTEN and stays short. It is the sheet's own census, not a
// discovered set: enumerating "forms that write an instant" from source is the
// scanner shape this repo does not build, and a wrong entry here is a claim about a
// neighbour's write core that only a person can make.
const SHEET_INSTANT_FORMS = new Map<string, { mounts: boolean; why: string }>([
  [
    "app/(app)/nutrition/FoodLogBar.tsx",
    {
      mounts: true,
      why: "eating-time statement + the correction sheet (#2227)",
    },
  ],
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    { mounts: true, why: "the form's one shared Time control (#2154)" },
  ],
  [
    "components/quick-entry/QuickStoolForm.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" over the second-grain key (#2785)',
    },
  ],
  [
    "components/practices/LogPracticeButton.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" states the end of Just finished (#3273/#3143)',
    },
  ],
  [
    "components/quick-entry/QuickMoodCheckin.tsx",
    {
      mounts: false,
      why:
        "THE COUNTER-CASE, not debt: a check-in is a DAY's answer, upserted on " +
        "UNIQUE(profile_id, date) and carrying no instant at all, so its day chips " +
        'are correct and "when did this happen?" is not the question it asks',
    },
  ],
  [
    "components/quick-entry/QuickCyclePanel.tsx",
    {
      mounts: false,
      why: "period start/end are DAYS; the panel states no time and stores none",
    },
  ],
  [
    "components/quick-entry/QuickDoseList.tsx",
    {
      mounts: false,
      why:
        "DEBT, named: a confirm writes intake_item_logs.recorded_at from the tap " +
        "and the sheet cannot state a late one — the correction row (#2206) is the " +
        "repair today; migrates on touch",
    },
  ],
  [
    "components/quick-entry/QuickSubstanceList.tsx",
    {
      mounts: false,
      why: "DEBT, named: a unit tap writes its own instant with no way to state an earlier one; migrates on touch",
    },
  ],
]);

describe("the quick-log sheet's instant forms mount the control or argue (#3273)", () => {
  const mounted = (rel: string) =>
    fs.readFileSync(path.join(REPO, rel), "utf8").includes("<WhenControl");

  it.each([...SHEET_INSTANT_FORMS])("%s", (rel, entry) => {
    // Both directions, because only one of them is the one that rots. A `mounts`
    // entry going false is the regression the union exists to catch; an argued entry
    // going true means the surface migrated and its argument is now a stale claim
    // about a file that no longer matches it.
    expect(mounted(rel), entry.why).toBe(entry.mounts);
  });
});

describe("the time-input reader itself", () => {
  it("finds a multi-line tag whose attributes contain braces and arrows", () => {
    expect(
      rawTimeInputs(
        `<input\n  type="time"\n  value={t}\n  onChange={(e) => set(e.target.value > "" ? e.target.value : "")}\n/>`
      )
    ).toEqual([1]);
  });

  it("ignores other input types and non-input tags", () => {
    expect(rawTimeInputs(`<input type="text" /><IconClock type="time" />`)) //
      .toEqual([]);
  });

  it("ignores a tag mentioned in a comment or a string", () => {
    expect(
      rawTimeInputs(
        `// seeds its <input type="time"> with\nconst s = '<input type="time">';\n{/* <input type="time"> */}`
      )
    ).toEqual([]);
  });

  it("counts each of several inputs on their own lines", () => {
    expect(
      rawTimeInputs(
        `<input type="time" />\n<input type="date" />\n<input type="time" name="t" />`
      )
    ).toEqual([1, 3]);
  });
});
