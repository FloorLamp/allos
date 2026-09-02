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
    "components/stool/StoolTypeControl.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" over the second-grain key (#2785), via the shared statement',
    },
  ],
  [
    "components/practices/LogPracticeButton.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" states the end of Just finished (#3273/#3143), via the shared statement',
    },
  ],
  [
    "components/mood/MoodForm.tsx",
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
  // WHAT MEMBERSHIP ACTUALLY IS. Mounting the shared statement (#4426) mounts the
  // control — `useTimeStatement` renders a `WhenControl` and nothing else can — so a
  // predicate that only knew the JSX tag read the two surfaces that converged onto it
  // as having LOST the control they still render.
  const mounted = (rel: string) => {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    return src.includes("<WhenControl") || src.includes("useTimeStatement(");
  };

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

// ── EVERY DIRECT `<WhenControl>` MOUNT IS CLASSIFIED (#4426) ─────────────────
//
// THE CRITERION, as #4738's ruling states it: no hand-rolled composition outside the
// shared control or the argued-exclusion register.
//
// #4426 converged THREE of the four hand-rolled "reveal a WhenControl" compositions
// onto `useTimeStatement` — practice, stool and PRN. (PRN was the fourth only until the
// ruling: its day range existed because the illness cockpit had no day of its own, and
// once the Today/Yesterday lift gave the card one, the day came from the surface and the
// statement went back to being the time half.) The food bar is the ONE that did not, and
// BEFORE this register nothing in the tree recorded that — a second could have joined it
// and no check would have noticed, which is the state the criterion existed to end.
//
// So the claim is made over the WHOLE population rather than over a list of suspects:
// every file that mounts the control DIRECTLY is exactly one of the three kinds below,
// and an unclassified mount fails. That is why this is not the allowlist the standing
// ruling refuses. An allowlist is a silent claim — a name in an array that outlives its
// reason and that a reader cannot evaluate. Each entry here carries a reason a reader
// can DISAGREE with, and an `argued` entry additionally carries the issue where the
// disagreement is being settled, so it goes stale loudly when that issue is ruled.
//
// Mounts of the SHARED statement never appear here: they mount no `<WhenControl>` of
// their own, which is the whole point of converging them.
type WhenMount =
  // The shared statement itself — the one legitimate collapsed reveal.
  | { kind: "shared" }
  // An always-on-screen field inside a form, a sheet or an editor. Nothing is
  // collapsed, so there is no reveal to converge; the control IS the field.
  | { kind: "field"; why: string }
  // A collapsed reveal that did NOT converge, with the reason and where it is being
  // decided. The issue number is a literal type: an entry cannot drift onto a
  // different question without the type changing.
  | { kind: "argued"; why: string; issue: "#4738" };

const WHEN_MOUNTS = new Map<string, WhenMount>([
  ["components/TimeStatement.tsx", { kind: "shared" }],
  [
    "app/(app)/nutrition/FoodLogBar.tsx",
    {
      kind: "argued",
      why:
        "THE ONE ARGUED EXCLUSION (#4738 ruling 4). The eating-time statement is a " +
        "STANDING CLAIM ABOUT A SESSION OF TAPS, not one tap's time: sticky for the " +
        "batch by design (#4118's amendment), never spent by the tap it answers — the " +
        "shared statement's rule 4 inverted — and drawn as a Disclosure with a " +
        "stated-time badge at `hour` grain. Converging it needs a stickiness flag plus " +
        "a details/summary shape flag, which is the four-behaviours-one-control shape " +
        "the ruling refuses. A shared sticky statement gets extracted when a SECOND " +
        "surface wants one, with two real instances to shape it",
      issue: "#4738",
    },
  ],
  [
    "app/(app)/nutrition/DayLedger.tsx",
    {
      kind: "field",
      why:
        "#4118's selection-edit `Set time…` — the web's AFTER-THE-FACT correction " +
        "path, reached by selecting rows and asking for it. #4426 is explicit that " +
        "this stays where it is; the shared statement only tells the time AT the tap",
    },
  ],
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    {
      kind: "field",
      why: "the sitting's one shared Time, above the groups (#2154)",
    },
  ],
  [
    "components/illness/EpisodeTimeline.tsx",
    { kind: "field", why: "the when half of the event editor (#2236)" },
  ],
  [
    "components/illness/SymptomLogBar.tsx",
    {
      kind: "field",
      why: "the reading's time, beside the temperature field (#4424 ruling 5)",
    },
  ],
  [
    "components/medications/HistoricalDoseForm.tsx",
    { kind: "field", why: "the backfill/amend form's date+time pair (#2228)" },
  ],
  [
    "components/nutrition/FoodServingForm.tsx",
    {
      kind: "field",
      why: "the serving's day + eating-time pair (#4424 ruling 1)",
    },
  ],
  [
    "components/stool/StoolForm.tsx",
    { kind: "field", why: "the dated door's own when (#4708)" },
  ],
]);

/**
 * Is this source still the hand-rolled composition its argued entry describes? Both
 * halves, because either one going false ends the argument: it must still mount the
 * control ITSELF, and it must not have taken the shared statement.
 */
export function stillHandRolled(src: string): boolean {
  return (
    findTags(src, "WhenControl", () => true).length > 0 &&
    !src.includes("useTimeStatement(")
  );
}

/** Files mounting `<WhenControl>` directly. Comments and strings do not count. */
export function whenControlMounts(): string[] {
  return [
    ...scanDirs(SCAN_DIRS, (text) => findTags(text, "WhenControl", () => true)),
  ]
    .map(([rel]) => rel)
    .sort();
}

describe("every direct WhenControl mount is classified (#4426)", () => {
  const mounts = whenControlMounts();

  it("has no mount outside the register", () => {
    const unclassified = mounts.filter((rel) => !WHEN_MOUNTS.has(rel));
    expect(
      unclassified,
      `\nA new hand-rolled "reveal a WhenControl" composition, or a new form field:\n` +
        `${unclassified.join("\n")}\n` +
        `Mount the shared statement (components/TimeStatement.tsx), or classify it above.\n`
    ).toEqual([]);
  });

  // THE STALENESS HALF, and it is the direction the `<WhenControl`-literal bug in the
  // census above failed in: an entry describing a file that no longer mounts anything
  // is a claim about nothing, and it decays silently because nothing else reads it.
  it("has no entry describing a file that no longer mounts", () => {
    const stale = [...WHEN_MOUNTS.keys()].filter(
      (rel) => !mounts.includes(rel)
    );
    expect(
      stale,
      `\nThese entries describe a file that no longer mounts WhenControl — it converged, ` +
        `or it moved. Delete the entry:\n${stale.join("\n")}\n`
    ).toEqual([]);
  });

  // An argued exclusion is only worth more than an allowlist if its reason is
  // READABLE, so the shape is enforced rather than trusted — and STALE IN BOTH
  // DIRECTIONS, because only one of the two is the direction a reader would notice.
  // A file that stopped mounting entirely is caught above; the other direction is a
  // file that QUIETLY ADOPTED the shared statement while keeping its argument for not
  // having, which leaves a paragraph in this register describing a surface that no
  // longer matches it. That is the exact rot that made PRN's entry wrong within a day.
  it.each(
    [...WHEN_MOUNTS].filter(([, m]) => m.kind === "argued") as [
      string,
      { kind: "argued"; why: string; issue: "#4738" },
    ][]
  )("%s argues its exclusion and says where it is decided", (rel, entry) => {
    expect(entry.why.length).toBeGreaterThan(60);
    expect(entry.issue).toBe("#4738");
    expect(
      stillHandRolled(fs.readFileSync(path.join(REPO, rel), "utf8")),
      `${rel} no longer hand-rolls its reveal — it converged, so delete its entry ` +
        `rather than leaving an argument for an exclusion that ended`
    ).toBe(true);
  });

  // THE GUARD CAN SEE. A green sweep over a complying tree says nothing about what
  // the sweep is able to notice, so run it over sources written to break it — and over
  // the benign neighbours it must stay quiet on.
  it.each([
    ["a plain mount", "<WhenControl mode='state' />", 1],
    [
      "a mount inside a reveal",
      "{open ? <WhenControl grain='hour' /> : null}",
      1,
    ],
    ["two mounts in one file", "<WhenControl /><WhenControl />", 2],
    ["a mention in a comment", "// mounts <WhenControl one day", 0],
    ["a mention in a string", 'const s = "<WhenControl>";', 0],
    ["the shared statement's own name", "useTimeStatement({ day })", 0],
  ])("%s → %i mount(s)", (_label, source, count) => {
    expect(findTags(source, "WhenControl", () => true).length).toBe(count);
  });

  // …AND SO CAN THE STALENESS HALF. Run over sources written to break it, because a
  // predicate asserted only over a complying tree is a predicate nobody has watched
  // fail: the converged shape is what every argued entry eventually becomes.
  //
  // DELIBERATELY TREE-INDEPENDENT — this table is green before and after any
  // convergence, and that is the point. It is the positive control for the assertion
  // beside it, which reads the real file and can only ever come back `true` while the
  // register is honest; without this, "the food bar still hand-rolls" would be a green
  // nobody had ever seen go red.
  it.each([
    [
      "a hand-rolled reveal",
      "{open ? <WhenControl grain='hour' /> : null}",
      true,
    ],
    [
      "one that quietly took the shared statement too",
      "const s = useTimeStatement({ day });\n<WhenControl />",
      false,
    ],
    ["one that fully converged", "const s = useTimeStatement({ day });", false],
    ["one that mounts nothing at all", "export const x = 1;", false],
  ])("%s still hand-rolls: %s", (_label, source, expected) => {
    expect(stillHandRolled(source)).toBe(expected);
  });
});
