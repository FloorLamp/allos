import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
  TAP_TARGET_MIN_RENDERED_PX,
  UnreadableControlError,
  belowSmHeightPx,
  findFlooredControls,
  floorMiss,
  usesTapTarget,
  withoutComments,
  type FlooredControl,
} from "../tap-floor-reach";

// THE TAP FLOOR'S REACH, SWEPT OVER THE TREE (#3486 part 3, under #3514).
//
// The rule is `lib/tap-floor-reach.ts`; this file is what keeps it true, and it
// is the OPEN item `docs/internals/design-system.md` §5 records against the
// tap-floor row: "a census of hand-rolled controls outside the family".
//
// WHY A CENSUS AND NOT A LIST OF FIXES. #3510 declared the floor on the `.btn`
// family and that was right — the alternative was the per-site sprinkle this
// project rejects. What it could not do is say which controls are NOT in the
// family and still need a floor, because that set is not written down anywhere.
// `StarButton` sat 36px beside a 40px sibling for exactly that reason, and it was
// found by a geometry probe rather than by anything that knew to look.
//
// THE SHAPE, and every part of it is load-bearing:
//
//   1. A CORPUS FLOOR before a single verdict. "No control misses the floor" is
//      an ABSENCE assertion, and an absence assertion over a sweep that has
//      stopped finding controls is green and says nothing (#3206).
//   2. A NAMED SUBJECT — the four steppers this change actually moved, asserted
//      by file and line, so the sweep is provably looking at the thing the PR
//      claims to have fixed rather than at a corpus that merely averages out.
//   3. A SYNTHETIC OFFENDER PLANTED IN A SCANNED CORPUS, not handed to the
//      matcher. Handing a bad source to `findFlooredControls` proves the MATCHER
//      can see it; it proves nothing about the WALK that feeds it. A rename, a
//      directory the walk does not enter, an extension filter — every one of
//      those breaks the census while leaving the matcher's own tests green. So
//      the offender is written to disk and the whole census is re-run over it —
//      into a temp corpus of this file's own, NOT into the live source tree that
//      forty other concurrent guards are reading (see `Corpus` below).
//   4. QUIET ON THE BENIGN NEIGHBOURS. #3325's census had to stay silent on five
//      shipped `ORDER BY … COLLATE NOCASE` sorts, because a guard that cries wolf
//      is deleted within a week and takes the real rule with it. Here the
//      neighbours are the `.btn` family, `.tap-target` used where its arithmetic
//      works, and `.chip` — which app/globals.css declares floor-free ON PURPOSE.
//   5. A RATCHET over what already misses. 104 controls miss today — 59 once the
//      45 native boxes with a `<label>` taking the tap are licensed — and this PR
//      does not pretend otherwise; what it does is stop the number growing, and
//      record what each group is waiting on.
//   6. AND A SECOND ROSTER FOR WHAT THIS CENSUS CANNOT JUDGE. 19 `.tap-target`
//      controls pin no height in source, so `floorMiss` returns null at its first
//      line and they are neither findings nor cleared. Counting them is what
//      turns a silent blind spot into a number that can go up (#3557 review).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components"];

/**
 * ONE CORPUS THIS CENSUS CAN BE POINTED AT: a base directory, and the roots to
 * walk beneath it. In production there is exactly one — the tree.
 *
 * The parameter exists for the planted-offender case at the bottom of this file,
 * and it is worth saying why, because "make it configurable" is usually the
 * wrong answer. That case must find its offender BY WALKING (see the comment
 * there); its first draft did so by writing the file into the live, git-tracked
 * `components/` directory. Vitest runs test files CONCURRENTLY and roughly forty
 * other guards in this suite walk `components/`, collect a file list, and read
 * those files a moment later — so they collected the plant and then read
 * nothing, and the whole unit suite went intermittently red in tests that have
 * nothing to do with the tap floor (#3557 review, blocker 1: `ENOENT … open
 * components/__tap_floor_planted_1804.tsx`, reproduced 5/6 on one trio).
 *
 * So the discipline is unchanged and the LOCATION moved: the same `sourceFiles`
 * and the same `census` below are pointed at a corpus only that test can see.
 */
type Corpus = { base: string; roots: string[] };

/** The tree itself — what every assertion about this app is made against. */
const TREE: Corpus = { base: REPO, roots: ROOTS };

// THE FLOOR THE CENSUS MUST CLEAR. Not the exact count — controls arrive with
// every feature — but a number well above zero, so a sweep that has stopped
// seeing them fails LOUDLY instead of passing over an empty list. Measured
// 2026-08-22: 1456 interactive controls with a readable class list, of which 342
// are `.btn`-family members and 39 carry `.tap-target` (38 of those take it as
// their mechanism; the odd one out also names `btn-ghost`, which is checked
// first). It only ever moves up, and only when someone has looked.
const CENSUS_FLOOR = 1200;

/**
 * THE CONTROLS THAT MISS THE FLOOR TODAY, by file, with what each is waiting on.
 *
 * This is a RATCHET, not an amnesty. `controls` is an upper bound: the census
 * fails when a file grows a new one, and fails when a file that is registered
 * has none left (the entry is stale and the reason with it). Fixing one is
 * always allowed and always silent.
 *
 * It is deliberately not a promise that these are FINE. Every group below says
 * what would close it, in the #3536 tradition — that issue records the one
 * surface where 44px is arithmetically impossible (seven cells, 288px) rather
 * than forcing it, and the same honesty applies to a control whose row cannot
 * afford the height today.
 */
type Registered = { file: string; controls: number; why: string };

// A dense in-form editor's compact controls. These are the app's desktop-density
// rows — a set editor, a parts list, a day history — where raising every control
// to 44 changes the ROW, not just the control, and the row is the thing the
// surface is about. #3536 is the precedent: a floor that the geometry refuses is
// a finding, not something to force. What closes these is a phone idiom for the
// surface (the #3374/#3378 shape), not a height edit.
const DENSE_EDITOR =
  "dense in-form editor row: raising the control raises the row, which is a phone-idiom " +
  "decision for the surface (#3374/#3378 shape), not a height edit — the #3536 precedent";

// A dismiss/secondary glyph riding inside a line of text. Its box is sized to the
// text it sits in, so the floor cannot be met by growing it without moving the
// line. `.tap-target` does not rescue these either: below 32px rendered the
// overlay lands short (see TAP_TARGET_MIN_RENDERED_PX).
const INLINE_GLYPH =
  "inline dismiss/secondary glyph sized to the text line it rides in; below " +
  `${TAP_TARGET_MIN_RENDERED_PX}px even \`.tap-target\` cannot reach the floor, so this needs a ` +
  "layout answer rather than a class";

// A native `<select>` or text field. #3514 ruled the floor for TARGETS and its
// converged list is controls; whether a typed field's box is the same quantity is
// genuinely undecided, and this register records the question rather than
// answering it by shipping.
const TYPED_FIELD =
  "typed field (`<select>` / text `<input>`), not an icon target: #3514 converged CONTROLS " +
  "and never said whether a field's box is the same quantity — an open question, recorded";

// A bare native checkbox with no `<label>` taking the tap on its behalf. The 41
// labelled boxes in the tree are licensed by that association and are not
// registered here; these five are the ones where the 16px box IS the whole
// target.
const BARE_BOX =
  "bare native checkbox: no `<label>` takes the tap, so the 16px box is the whole target";

const UNDER_FLOOR_REGISTER: Registered[] = [
  // ── inline glyphs ────────────────────────────────────────────────────────
  { file: "components/FoodGuidance.tsx", controls: 1, why: INLINE_GLYPH },
  { file: "components/HouseholdCard.tsx", controls: 1, why: INLINE_GLYPH },
  {
    file: "app/(app)/trends/TrendingDigest.tsx",
    controls: 1,
    why: INLINE_GLYPH,
  },
  { file: "app/(app)/upcoming/page.tsx", controls: 1, why: INLINE_GLYPH },
  { file: "components/FindingCard.tsx", controls: 1, why: INLINE_GLYPH },
  { file: "components/FindingRow.tsx", controls: 1, why: INLINE_GLYPH },
  { file: "components/InfoTooltipIcon.tsx", controls: 1, why: INLINE_GLYPH },
  {
    file: "app/(app)/nutrition/UntrackHabitButton.tsx",
    controls: 1,
    why: INLINE_GLYPH,
  },
  {
    file: "app/(app)/results/TrajectoryWatchCard.tsx",
    controls: 1,
    why: INLINE_GLYPH,
  },
  {
    file: "components/facts/FactChipRow.tsx",
    controls: 1,
    why:
      "the fact chip's remove `x`, 24px inside a 34px chip. It CARRIES `.tap-target` and " +
      `still lands at ${24 + 2 * TAP_TARGET_INSET_PX}px effective, because the overlay adds a fixed ` +
      `2x${TAP_TARGET_INSET_PX}px. Reaching ${TAP_FLOOR_PX} needs ${TAP_TARGET_MIN_RENDERED_PX}px rendered, which grows the chip ` +
      "from 34px to 46 and re-lays every fact row in the app — the #3536 shape, recorded " +
      "rather than forced. The four steppers this PR did raise had the headroom; this does not",
  },
  {
    file: "components/illness/SymptomLogBar.tsx",
    controls: 4,
    why: `${INLINE_GLYPH}; and two 32px severity fields on the same bar (${TYPED_FIELD})`,
  },

  // ── dense editors ────────────────────────────────────────────────────────
  {
    file: "components/activity-form/StrengthSets.tsx",
    controls: 11,
    why: DENSE_EDITOR,
  },
  { file: "components/DayHistory.tsx", controls: 4, why: DENSE_EDITOR },
  {
    file: "components/activity-form/ActivityFormHeader.tsx",
    controls: 2,
    why: DENSE_EDITOR,
  },
  {
    file: "components/activity-form/FitnessTestTimer.tsx",
    controls: 1,
    why: DENSE_EDITOR,
  },
  { file: "components/MoodValencePicker.tsx", controls: 1, why: DENSE_EDITOR },
  {
    file: "app/(app)/training/TrainingLogView.tsx",
    controls: 1,
    why: DENSE_EDITOR,
  },
  {
    file: "components/ProfileSwitcherPanel.tsx",
    controls: 1,
    why: DENSE_EDITOR,
  },
  { file: "components/SidebarContent.tsx", controls: 1, why: DENSE_EDITOR },
  {
    file: "app/(app)/trends/ChartJumpMenu.tsx",
    controls: 1,
    why: DENSE_EDITOR,
  },
  { file: "components/CompactDateMenu.tsx", controls: 1, why: DENSE_EDITOR },
  { file: "components/MobileDetailPage.tsx", controls: 1, why: DENSE_EDITOR },

  // ── typed fields ─────────────────────────────────────────────────────────
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    controls: 2,
    why: TYPED_FIELD,
  },
  { file: "components/SaveTrendKeyPicker.tsx", controls: 1, why: TYPED_FIELD },
  { file: "components/TableSortSelect.tsx", controls: 1, why: TYPED_FIELD },
  { file: "components/WhenControl.tsx", controls: 2, why: TYPED_FIELD },
  {
    file: "components/activity-form/DateTimeFields.tsx",
    controls: 3,
    why: `${TYPED_FIELD} — and these three are \`h-[38px]\`, a pinned arbitrary value`,
  },
  {
    file: "components/illness/SymptomPhotoStrip.tsx",
    controls: 3,
    why: TYPED_FIELD,
  },
  {
    file: "components/video/VideoClipGrid.tsx",
    controls: 2,
    // NAMED, because this entry was read as covering the whole file and it does
    // not. The two controls here are the CAPTION TEXT INPUTS —
    // `video-clip-caption-input-*` (`input h-8`) and the new-clip `Caption
    // (optional)` field (`input h-9`). The file's two icon buttons at the
    // figcaption are a different population entirely: they pin no height, this
    // census renders no verdict on them, and they are recorded in
    // MEASURED_UNDER_FLOOR below at 24px and 22px rendered. A count of 2 with a
    // `why` about typed fields silently covered them, which is worse than
    // leaving them out — the ratchet was green and the sentence was false
    // (#3557 review, blocker 3).
    why: `${TYPED_FIELD}. This entry is the two caption text inputs ONLY; the file's two icon buttons pin no height and are recorded in MEASURED_UNDER_FLOOR`,
  },
  {
    file: "components/medications/PediatricDoseBandPicker.tsx",
    controls: 1,
    why: TYPED_FIELD,
  },

  // ── bare native boxes ────────────────────────────────────────────────────
  {
    file: "app/(app)/settings/notifications/NotificationPrefs.tsx",
    controls: 2,
    // Two, not three: #3558 gave one of the three boxes a `<label>` and the
    // licence took it out of the finding. The entry is the number the tree
    // holds today, not the number it held when the census was first taken.
    why: `${BARE_BOX} — the #1868 kind x channel matrix, whose phone idiom is #3495/#3550`,
  },
  { file: "components/DataTableManager.tsx", controls: 2, why: BARE_BOX },

  // ── the one range track ──────────────────────────────────────────────────
  {
    file: "components/ImageCropper.tsx",
    controls: 1,
    why:
      "an `<input type=range>`: the 4px TRACK is what the class list pins, and the thumb " +
      "is the target. The two are different boxes and this scan reads the wrong one — " +
      "recorded so the number is not mistaken for a 4px tap target",
  },
];

/**
 * THE `.tap-target` CONTROLS THIS CENSUS CANNOT JUDGE, ENUMERATED.
 *
 * `floorMiss` returns null on its FIRST LINE for a control that pins no height —
 * see the module header on what a class-list scan can see. That is a stated
 * bound and it is honest, but until now it was also SILENT: nineteen controls
 * wearing the token that says "the floor was reached by hit area" were neither
 * findings nor cleared, and nothing counted them. A blind spot with no number
 * cannot grow visibly, which is the #3206 shape one level down.
 *
 * So they are rostered here, by file and count, and the census asserts the
 * roster is EXACTLY what it finds. A new unpinned `.tap-target` is red until
 * someone records it; one that gains a height is red until someone removes it.
 * This is not a register of exemptions — nothing here is licensed. It is the
 * size of the question this scan cannot answer.
 *
 * Why it matters and is not bookkeeping: `.tap-target` adds a FIXED 12px, so a
 * control's compliance depends entirely on a rendered height none of these
 * declare. Three of the nineteen have now been measured (MEASURED_UNDER_FLOOR)
 * and all three are under the floor. The other sixteen are UNMEASURED — nobody
 * has looked, and this file says so rather than implying they are fine.
 */
type UnjudgedTapTarget = { file: string; controls: number };

const UNJUDGED_TAP_TARGETS: UnjudgedTapTarget[] = [
  { file: "app/(app)/encounters/AddVisitEntry.tsx", controls: 2 },
  { file: "app/(app)/protocols/ProtocolForm.tsx", controls: 1 },
  { file: "app/(app)/training/GoalForm.tsx", controls: 2 },
  { file: "app/(app)/training/MobilityLogBar.tsx", controls: 1 },
  { file: "components/IntakeItemForm.tsx", controls: 2 },
  { file: "components/ProfileIdentityBar.tsx", controls: 1 },
  { file: "components/QuickLogSheet.tsx", controls: 2 },
  { file: "components/encounters/VisitFactRow.tsx", controls: 1 },
  { file: "components/facts/FactChipRow.tsx", controls: 2 },
  { file: "components/intake/CadenceEditor.tsx", controls: 1 },
  { file: "components/intake/IntakeKindChip.tsx", controls: 1 },
  { file: "components/intake/IntakeRulesEditor.tsx", controls: 1 },
  { file: "components/video/VideoClipGrid.tsx", controls: 2 },
];

/**
 * THE THREE OF THOSE NINETEEN THAT HAVE BEEN MEASURED, and all three are short.
 *
 * Measured against the app's own compiled CSS at a 390px viewport with a coarse
 * pointer (#3557 review). These are the same defect this module is named for —
 * a control wearing `.tap-target`, which says the floor was reached by hit area,
 * while its rendered box is under the 32px the overlay's fixed 12px needs. They
 * were invisible to the source census because their height is their content's.
 *
 * RECORDED, NOT FIXED. Raising these is a phone-idiom decision in a dense row —
 * the weekday cadence toggles are seven across a phone, the clip glyphs ride a
 * figcaption line — and that is #3562's call, on the #3536 precedent this file
 * already follows for `FactChipRow`. What is fixed here is the RECORD: two of
 * the three were standing behind a register entry about `<select>` boxes.
 *
 * `testid` is what pins each entry to its control. A line number drifts with any
 * edit above it; a testid is the thing the control is addressed by, and the
 * census asserts it is still in the file.
 */
type MeasuredUnderFloor = {
  file: string;
  /** 1-based line of the opening tag when this was measured, for the reader. */
  line: number;
  /** A fragment of the control's `data-testid`, asserted to still be present. */
  testid: string;
  /** The measured rendered height in CSS pixels at 390px, coarse pointer. */
  renderedPx: number;
  what: string;
};

const MEASURED_UNDER_FLOOR: MeasuredUnderFloor[] = [
  {
    file: "components/intake/CadenceEditor.tsx",
    line: 56,
    testid: "-weekday-",
    renderedPx: 24,
    what:
      "the cadence editor's weekday toggles (`px-2 py-1 text-xs`, seven across a phone). " +
      "Raising them to 32 rendered re-lays the row, which is the #3374/#3378 phone-idiom " +
      "question and not a class edit",
  },
  {
    file: "components/video/VideoClipGrid.tsx",
    line: 217,
    testid: "video-clip-edit-",
    renderedPx: 24,
    what:
      "the clip caption's edit glyph (`p-1` around a text-sized character), riding the " +
      "figcaption line. The INLINE_GLYPH shape: its box is the line's, so the floor needs " +
      "a layout answer",
  },
  {
    file: "components/video/VideoClipGrid.tsx",
    line: 231,
    testid: "video-clip-delete-",
    renderedPx: 22,
    what:
      "the clip's delete glyph (`p-1` around a 14px icon), beside the edit glyph above and " +
      "2px shorter because the icon is smaller than the line box",
  },
];

/**
 * The sixteen nobody has measured. Stated as a number rather than left as
 * subtraction, because "we have not looked" is the fact worth being able to
 * read off this file.
 */
const UNMEASURED_TAP_TARGETS = 16;

function read(rel: string, base: string = REPO): string {
  return fs.readFileSync(path.join(base, rel), "utf8");
}

function sourceFiles(root: string, base: string = REPO): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(base, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(rel);
      } else if (entry.name.endsWith(".tsx")) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

type Found = FlooredControl & { file: string };

function census(corpus: Corpus = TREE): Found[] {
  const out: Found[] = [];
  for (const root of corpus.roots)
    for (const file of sourceFiles(root, corpus.base)) {
      let controls: FlooredControl[];
      try {
        controls = findFlooredControls(
          withoutComments(read(file, corpus.base))
        );
      } catch (error) {
        if (error instanceof UnreadableControlError)
          throw new UnreadableControlError(`${file}: ${error.message}`);
        throw error;
      }
      for (const c of controls) out.push({ ...c, file });
    }
  return out;
}

/** Every control that misses the floor, with the sentence saying how. */
function misses(found: Found[]): { control: Found; why: string }[] {
  const out: { control: Found; why: string }[] = [];
  for (const control of found) {
    // A labelled native box is licensed: the `<label>` takes the tap, so the
    // 16px box is not the target. Checked PER SITE — the premise can go false,
    // and when it does the box shows up as a finding rather than staying quiet.
    if (control.kind === "native-box" && control.labelled) continue;
    const why = floorMiss(control);
    if (why) out.push({ control, why });
  }
  return out;
}

// The tree's own census, taken once and shared by every describe below.
const found = census();
const missed = misses(found);

describe("the tap floor's reach (#3486 part 3 / #3514)", () => {
  // THE CENSUS ITSELF, ASSERTED BEFORE ANYTHING IS JUDGED.
  it("finds the controls it is about to judge", () => {
    expect(
      found.length,
      `Found ${found.length} interactive controls with a readable class list under ` +
        `${ROOTS.join("/")}, below the floor of ${CENSUS_FLOOR}. Either this scan has ` +
        "stopped seeing them (a rename, a move, a JSX shape it cannot parse) or the " +
        "controls really are gone — check which before lowering this number."
    ).toBeGreaterThanOrEqual(CENSUS_FLOOR);
    // Both registered mechanisms are really present, so the verdicts below are
    // not green over a corpus that happens to contain neither.
    const mechanisms = found.map((c) => c.mechanism);
    expect(mechanisms.filter((m) => m === "btn-family").length).toBeGreaterThan(
      100
    );
    expect(mechanisms.filter((m) => m === "tap-target").length).toBeGreaterThan(
      10
    );
  });

  // THE NAMED SUBJECT. Without this the corpus assertion above can stay green
  // while the four controls this change actually moved silently slide back.
  it("the four `.tap-target` steppers this change raised clear the mechanism's minimum", () => {
    const SUBJECTS = [
      { file: "app/(app)/nutrition/FoodLogBar.tsx", testid: "undo-" },
      { file: "app/(app)/nutrition/FoodLogBar.tsx", testid: "log-" },
      {
        file: "app/(app)/nutrition/ProteinQuickAdd.tsx",
        testid: "protein-quickadd-undo",
      },
      {
        file: "app/(app)/nutrition/ProteinQuickAdd.tsx",
        testid: "protein-quickadd-add",
      },
    ];
    for (const subject of SUBJECTS) {
      const source = withoutComments(read(subject.file));
      const controls = findFlooredControls(source).filter(
        (c) => c.mechanism === "tap-target" && c.belowSmPx !== null
      );
      expect(
        controls.length,
        `${subject.file} has no \`.tap-target\` control pinning a height at all`
      ).toBeGreaterThan(0);
      for (const c of controls)
        expect(
          c.belowSmPx,
          `${subject.file}:${c.line} renders ${c.belowSmPx}px and carries \`.tap-target\`, ` +
            `whose \`inset: -${TAP_TARGET_INSET_PX}px\` adds a fixed ${2 * TAP_TARGET_INSET_PX}px. That is ` +
            `${(c.belowSmPx ?? 0) + 2 * TAP_TARGET_INSET_PX}px effective, under the ${TAP_FLOOR_PX}px floor — ` +
            `the mechanism only reaches it from ${TAP_TARGET_MIN_RENDERED_PX}px up.`
        ).toBeGreaterThanOrEqual(TAP_TARGET_MIN_RENDERED_PX);
    }
    // The named subject really is the one described: `undo-`/`log-` and the two
    // protein steppers, not some other control in the same file.
    for (const subject of SUBJECTS)
      expect(read(subject.file)).toContain(subject.testid);
  });

  it("no unregistered file holds a control under the floor", () => {
    const registered = new Map(
      UNDER_FLOOR_REGISTER.map((entry) => [entry.file, entry])
    );
    const byFile = new Map<string, { control: Found; why: string }[]>();
    for (const m of missed) {
      const list = byFile.get(m.control.file) ?? [];
      list.push(m);
      byFile.set(m.control.file, list);
    }
    const offenders: string[] = [];
    for (const [file, list] of byFile) {
      const entry = registered.get(file);
      if (entry === undefined) {
        offenders.push(
          `${file} — ${list
            .map((m) => `line ${m.control.line} (<${m.control.tag}>): ${m.why}`)
            .join("; ")}`
        );
        continue;
      }
      if (list.length > entry.controls)
        offenders.push(
          `${file} — ${list.length} controls under the floor, registered for at most ` +
            `${entry.controls}: ${list.map((m) => `line ${m.control.line}`).join(", ")}`
        );
    }
    expect(
      offenders,
      `A control renders under the ${TAP_FLOOR_PX}px tap floor (#3514) with neither ` +
        "registered mechanism, in a file this census does not already know about.\n\n" +
        offenders.join("\n") +
        "\n\nThe two mechanisms: a RENDERED box of at least " +
        `${TAP_FLOOR_PX}px (\`min-h-11\`, or membership of the \`.btn\` family, which carries ` +
        "the floor for you), or `.tap-target`'s hit-area overlay — which adds a fixed " +
        `2x${TAP_TARGET_INSET_PX}px and therefore only reaches the floor from ` +
        `${TAP_TARGET_MIN_RENDERED_PX}px rendered up. If the control genuinely cannot have the ` +
        "height, that is a finding to record in UNDER_FLOOR_REGISTER in this file, with " +
        "what would close it — the #3536 precedent, not an amnesty."
    ).toEqual([]);
  });

  it("has no stale register entries", () => {
    const missedFiles = new Set(missed.map((m) => m.control.file));
    const stale = UNDER_FLOOR_REGISTER.filter(
      (entry) => !missedFiles.has(entry.file)
    ).map((entry) => entry.file);
    expect(
      stale,
      "A file registered as holding a control under the tap floor no longer holds one. " +
        "That is good news and the entry should go — a register that outlives its " +
        "findings stops describing the tree and starts excusing it."
    ).toEqual([]);
    // And the register is not silently duplicated, which would make the
    // at-most bound above read from whichever entry `Map` kept last.
    const files = UNDER_FLOOR_REGISTER.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
  });

  // THE ARITHMETIC, CHECKED AGAINST THE STYLESHEET IT DESCRIBES. The whole point
  // of TAP_TARGET_MIN_RENDERED_PX is that it is DERIVED from `.tap-target`'s
  // inset; if the CSS moves and the constant does not, every verdict above is
  // computed from a number that no longer describes anything.
  it("derives its minimum from the inset app/globals.css actually declares", () => {
    const css = read("app/globals.css");
    const block =
      /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.tap-target::after\s*\{([\s\S]*?)\}/.exec(
        css
      );
    expect(
      block,
      "`.tap-target::after` is no longer declared inside a `@media (pointer: coarse)` " +
        "block in app/globals.css. The hit-area mechanism is one of the two #3514 " +
        "registered, and this census prices it — find where it went."
    ).not.toBeNull();
    const inset = /inset:\s*-(\d+(?:\.\d+)?)px/.exec(block![1]);
    expect(
      inset,
      "`.tap-target::after` no longer declares a negative `inset`"
    ).not.toBeNull();
    expect(
      Number(inset![1]),
      `app/globals.css extends \`.tap-target\` by ${inset?.[1]}px per side, but ` +
        `lib/tap-floor-reach.ts prices it at ${TAP_TARGET_INSET_PX}px. Move the constant, ` +
        "or the census is judging every hit-area control against arithmetic that is not " +
        "the app's."
    ).toBe(TAP_TARGET_INSET_PX);
    expect(TAP_TARGET_MIN_RENDERED_PX).toBe(
      TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX
    );
    // And the family's own rendered floor is the same number the module names.
    // `2.75rem` is 44px; the census and the stylesheet hold ONE floor, which is
    // the property `lib/__tests__/card-mode-boundary.test.ts` keeps for the card
    // boundary and for the same reason.
    expect(
      css,
      "The `.btn` family's below-`sm` floor in app/globals.css is no longer " +
        `${TAP_FLOOR_PX / 16}rem (${TAP_FLOOR_PX}px). The census and the stylesheet must hold one number.`
    ).toContain(`min-block-size: ${TAP_FLOOR_PX / 16}rem`);
  });
});

describe("the `.tap-target` controls this census cannot judge", () => {
  const unjudged = found.filter(
    (c) => usesTapTarget(c.className) && c.belowSmPx === null
  );

  it("rosters every one of them, exactly", () => {
    const byFile = new Map<string, number>();
    for (const c of unjudged) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
    const actual = [...byFile]
      .map(([file, controls]) => ({ file, controls }))
      .sort((a, b) => a.file.localeCompare(b.file));
    const rostered = [...UNJUDGED_TAP_TARGETS].sort((a, b) =>
      a.file.localeCompare(b.file)
    );
    expect(
      actual,
      "A `.tap-target` control that pins NO height is one this source census renders no " +
        "verdict on: `floorMiss` returns null at its first line, so it is neither a " +
        "finding nor cleared. That is a stated bound (see the module header) and it must " +
        "not be a silent one — the roster is how the blind spot has a size that can go " +
        "up. If this list grew, record the new control in UNJUDGED_TAP_TARGETS and say " +
        "whether anyone has measured it; if it shrank, a control gained a height and the " +
        "entry should go."
    ).toEqual(rostered);
  });

  it("says how many have been measured and how many nobody has looked at", () => {
    const total = unjudged.length;
    const measuredFiles = new Set(MEASURED_UNDER_FLOOR.map((m) => m.file));
    for (const file of measuredFiles)
      expect(
        UNJUDGED_TAP_TARGETS.some((entry) => entry.file === file),
        `${file} holds a measured under-floor \`.tap-target\` control but is not in the ` +
          "unjudged roster. The two lists describe one population and cannot disagree."
      ).toBe(true);
    expect(
      UNMEASURED_TAP_TARGETS,
      `${total} \`.tap-target\` controls pin no height and ${MEASURED_UNDER_FLOOR.length} of them ` +
        "have been measured, so the number nobody has looked at is the difference. Saying " +
        "it out loud is the point: an unmeasured control is not a compliant one."
    ).toBe(total - MEASURED_UNDER_FLOOR.length);
  });

  it("holds the three measured ones to the arithmetic, not to a memory of it", () => {
    for (const m of MEASURED_UNDER_FLOOR) {
      // It really is the control described — the testid is how it is addressed,
      // and a line number would only tell you the file has been edited since.
      expect(
        read(m.file),
        `${m.file} no longer contains \`${m.testid}\`, so this entry is about a control ` +
          `that has moved or gone. It was measured at ${m.renderedPx}px on line ${m.line}.`
      ).toContain(m.testid);
      // …and it is still a `.tap-target` this census cannot judge. A control
      // that gained a height belongs in the census's verdicts, not in a
      // hand-recorded measurement that nothing re-checks.
      expect(
        unjudged.some((c) => c.file === m.file),
        `${m.file} no longer holds an unpinned \`.tap-target\` control. If it gained a ` +
          "height, the source census judges it now and this entry should go."
      ).toBe(true);
      // The recorded number is a FINDING, and the finding is arithmetic: the
      // overlay adds a fixed 2x6px, so anything under 32 rendered lands short.
      expect(
        m.renderedPx,
        `${m.file}:${m.line} is recorded at ${m.renderedPx}px rendered, which reaches ` +
          `${m.renderedPx + 2 * TAP_TARGET_INSET_PX}px effective — at or above the ` +
          `${TAP_FLOOR_PX}px floor. A control that MEETS the floor does not belong in a list ` +
          "of measured misses; delete the entry rather than leaving a false finding."
      ).toBeLessThan(TAP_TARGET_MIN_RENDERED_PX);
    }
    // And no file is registered twice under one roster, which would make the
    // counts above read from whichever entry `Map` kept last.
    const files = UNJUDGED_TAP_TARGETS.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });
});

// ── THE HALF THAT MAKES THE GREEN ABOVE WORTH ANYTHING ──────────────────────
//
// A green sweep over a complying tree says nothing about what the sweep can see.

describe("the height reader", () => {
  it("reads only what governs below `sm`", () => {
    // The mistake this exists to refuse: taking the smallest `h-*` in the class
    // list. `sm:h-11` is a DESKTOP height and answers nothing the floor asks.
    expect(belowSmHeightPx("h-9 w-9 sm:h-auto sm:w-auto")).toBe(36);
    expect(belowSmHeightPx("h-11 w-11 sm:h-auto")).toBe(44);
    expect(belowSmHeightPx("sm:h-11")).toBeNull();
    // `max-sm:` is the narrower query and wins over the unprefixed base.
    expect(belowSmHeightPx("h-8 max-sm:h-11")).toBe(44);
    expect(belowSmHeightPx("h-11 max-sm:h-8")).toBe(32);
    // An unpinned height is null, not zero — the difference between "content
    // decides" and "renders nothing", which is the difference between a case
    // this scan declines and a case it would wrongly flag.
    expect(belowSmHeightPx("h-auto")).toBeNull();
    expect(belowSmHeightPx("flex items-center px-3 py-1.5")).toBeNull();
    // Arbitrary values in units it knows.
    expect(belowSmHeightPx("input h-[38px]")).toBe(38);
    expect(belowSmHeightPx("h-[2rem]")).toBe(32);
    // Half steps and the 1px step.
    expect(belowSmHeightPx("h-3.5")).toBe(14);
    expect(belowSmHeightPx("h-px")).toBe(1);
    // A neighbouring utility that merely CONTAINS the token is not the token.
    expect(belowSmHeightPx("max-h-64 overflow-y-auto")).toBeNull();
    expect(belowSmHeightPx("h-full")).toBeNull();
  });
});

const scan = (source: string) => findFlooredControls(withoutComments(source));

describe("the sweep can see an offender", () => {
  it("catches a hand-rolled control outside the family — #3486's own shape", () => {
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="h-9 w-9 rounded-lg border sm:h-auto">*</button>;
       }`
    );
    expect(control.mechanism).toBe("none");
    expect(control.belowSmPx).toBe(36);
    expect(floorMiss(control)).toContain("neither registered mechanism");
  });

  it("catches `.tap-target` used below the arithmetic it depends on", () => {
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="tap-target flex h-7 w-7">-</button>;
       }`
    );
    expect(control.mechanism).toBe("tap-target");
    expect(floorMiss(control)).toContain("40px effective");
  });

  it("catches a `sm:`-only floor, which governs the wrong side of the boundary", () => {
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="h-8 w-8 sm:h-11 sm:w-11">x</button>;
       }`
    );
    expect(floorMiss(control)).toContain("32px rendered below `sm`");
  });

  it("catches a div made interactive by an onClick", () => {
    const [control] = scan(
      `export default function X() {
         return <div role="button" onClick={go} className="h-6 w-6">x</div>;
       }`
    );
    expect(control.kind).toBe("handler");
    expect(floorMiss(control)).not.toBeNull();
  });

  it("catches a bare native box, and licenses a labelled one", () => {
    const bare = scan(
      `export default function X() {
         return <input type="checkbox" className="h-4 w-4" aria-label="Pick" />;
       }`
    );
    expect(bare[0].kind).toBe("native-box");
    expect(bare[0].labelled).toBe(false);
    const wrapped = scan(
      `export default function X() {
         return <label className="flex gap-2"><input type="checkbox" className="h-4 w-4" />Pick</label>;
       }`
    );
    expect(wrapped.find((c) => c.tag === "input")!.labelled).toBe(true);
    // The expression spelling, which is how a list-rendered row writes it — and
    // the one a literal-only `htmlFor` match reads as unassociated.
    const byId = scan(
      "export default function X() {\n" +
        "  return <li>\n" +
        '    <input id={`tune-${c}`} type="checkbox" className="h-4 w-4" />\n' +
        "    <label htmlFor={`tune-${c}`}>Pick</label>\n" +
        "  </li>;\n" +
        "}"
    );
    expect(byId.find((c) => c.tag === "input")!.labelled).toBe(true);
  });

  it("throws on a height it cannot price, rather than skipping the control", () => {
    expect(() =>
      scan(
        `export default function X() {
           return <button type="button" className="h-[3lh] w-8">x</button>;
         }`
      )
    ).toThrow(UnreadableControlError);
  });

  it("reads a class list written as a template literal or a ternary", () => {
    const [control] = scan(
      "export default function X() {\n" +
        "  return <button type=\"button\" className={`h-8 w-8 ${on ? 'bg-brand-600' : ''}`}>x</button>;\n" +
        "}"
    );
    expect(control.belowSmPx).toBe(32);
    expect(floorMiss(control)).not.toBeNull();
  });
});

describe("the sweep is quiet on the benign neighbours", () => {
  it("says nothing about a `.btn`-family member, which carries the floor already", () => {
    for (const token of ["btn", "btn-ghost", "btn-danger", "btn btn-sm"]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className="${token} inline-flex items-center gap-1.5">Add goal</button>;
         }`
      );
      expect(control.mechanism).toBe("btn-family");
      expect(floorMiss(control)).toBeNull();
    }
  });

  it("says nothing about `.tap-target` where its arithmetic works", () => {
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="tap-target flex h-8 w-8">x</button>;
       }`
    );
    expect(control.belowSmPx).toBe(TAP_TARGET_MIN_RENDERED_PX);
    expect(floorMiss(control)).toBeNull();
  });

  it("says nothing about a control that already renders at or above the floor", () => {
    for (const cls of ["h-11 w-11", "min-h-11", "h-14", "h-11 sm:h-auto"]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className="${cls}">x</button>;
         }`
      );
      expect(floorMiss(control), cls).toBeNull();
    }
  });

  it("says nothing about a `.chip`, which app/globals.css declares floor-free ON PURPOSE", () => {
    // The single most important silence here. A chip is acquired by its WIDTH
    // along a scrolling row, and app/globals.css says so in as many words ("NO
    // HEIGHT FLOOR, DELIBERATELY"). A census that flagged the app's filter pills
    // would be switched off within a week and would take the real rule with it.
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="chip chip-filter" aria-pressed={on}>Meds</button>;
       }`
    );
    expect(control.belowSmPx).toBeNull();
    expect(floorMiss(control)).toBeNull();
    expect(
      fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8"),
      "app/globals.css no longer records that `.chip` declares no height floor on " +
        "purpose. The silence above is licensed by that sentence; if the decision " +
        "changed, this census should stop being quiet."
    ).toContain("NO HEIGHT FLOOR, DELIBERATELY");
  });

  it("says nothing about a non-interactive element that happens to be short", () => {
    expect(
      scan(
        `export default function X() {
           return <span className="h-4 w-4 rounded-full bg-brand-600" />;
         }`
      )
    ).toEqual([]);
  });
});

// ── THE OFFENDER IS PLANTED IN A CORPUS, NOT HANDED TO THE MATCHER ─────────
//
// Everything above proves the MATCHER can see a bad control. None of it proves
// the WALK can: a census whose `sourceFiles()` stopped entering `components/`,
// or stopped matching `.tsx`, or stopped recursing, would keep every test above
// green while reporting a clean sweep it never took. So one offender is written
// to disk inside a scanned root and the WHOLE census is re-run over it.
//
// A lens caught exactly this failure on a different PR this session, which is why
// it is here rather than left implied.
//
// WHERE IT IS PLANTED, AND WHY NOT IN `components/`. The first draft wrote the
// offender into the live, git-tracked `components/` directory. The reasoning was
// right and the address was wrong: vitest runs test files CONCURRENTLY, ~40 other
// guards walk `components/`, collect a file list, and read those files a moment
// later — and the `afterAll` unlink here lands in that window. They collected a
// file that no longer existed and died with `ENOENT`, in tests with nothing to do
// with the tap floor and a rotating victim. Reproduced 5/6 on one trio and 2/7 on
// the full suite (#3557 review, blocker 1).
//
// The fix is NOT to stop planting — a plant handed straight to the matcher tests
// the matcher, which is the thing that needed no help. It is to give the walk a
// corpus of its own: `census(corpus)` runs the same `sourceFiles` over a
// `mkdtemp` tree only this process can see, and the offender is still something
// the walk had to GO AND FIND.

describe("the census walk reaches a planted offender", () => {
  // A corpus with a shape, so the readings below are not two zeroes agreeing:
  // both roots the tree uses, one already-missing control, one compliant one,
  // and the plant in a SUBDIRECTORY so finding it also proves the walk recurses
  // rather than reading one directory's entries.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tap-floor-corpus-"));
  const corpus: Corpus = { base, roots: ROOTS };
  const plantedRel = "components/planted/__tap_floor_planted.tsx";
  const planted = path.join(base, plantedRel);

  beforeAll(() => {
    fs.mkdirSync(path.join(base, "app"), { recursive: true });
    fs.mkdirSync(path.join(base, "components", "planted"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "app", "SeedCompliant.tsx"),
      "export default function SeedCompliant() {\n" +
        '  return <button type="button" className="btn">Add goal</button>;\n' +
        "}\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(base, "components", "SeedOffender.tsx"),
      "export default function SeedOffender() {\n" +
        '  return <button type="button" className="h-8 w-8 rounded-lg border">y</button>;\n' +
        "}\n",
      "utf8"
    );
  });

  afterAll(() => {
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("flags a control the walk had to find on disk", () => {
    const before = misses(census(corpus));
    expect(
      before.length,
      "The seeded corpus holds one control under the floor and the walk found none of " +
        "it. Both readings below would then be empty and would agree, which is the " +
        "shape of a walk that has stopped walking — not of a passing test."
    ).toBe(1);
    fs.writeFileSync(
      planted,
      "export default function PlantedOffender() {\n" +
        '  return <button type="button" className="h-9 w-9 rounded-lg border">x</button>;\n' +
        "}\n",
      "utf8"
    );
    const after = misses(census(corpus));
    const caught = after.filter((m) => m.control.file === plantedRel);
    expect(
      caught,
      `The census did not see a file written to disk at \`${plantedRel}\` inside a ` +
        "scanned root. The matcher's own tests cannot tell you this: it is the WALK " +
        "that failed — a root it does not enter, a directory it does not recurse into, " +
        "or an extension it no longer matches."
    ).toHaveLength(1);
    expect(caught[0].control.belowSmPx).toBe(36);
    expect(caught[0].why).toContain("neither registered mechanism");
    // And exactly one more than before — the plant is additive, not a rewrite of
    // what the sweep was already reporting.
    expect(after.length).toBe(before.length + 1);
    // The planted file is unregistered, so the real verdict fires too.
    const registered = new Set(UNDER_FLOOR_REGISTER.map((e) => e.file));
    expect(registered.has(plantedRel)).toBe(false);
  });

  it("stays quiet on a planted control that meets the floor", () => {
    // The baseline is taken with NOTHING planted. Reading it while the previous
    // test's offender is still on disk measures the wrong tree — and it fails
    // toward "the compliant plant removed a finding", which is the reassuring
    // direction and the one that gets believed.
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    const before = misses(census(corpus));
    fs.writeFileSync(
      planted,
      "export default function PlantedNeighbour() {\n" +
        '  return <button type="button" className="tap-target flex h-8 w-8">x</button>;\n' +
        "}\n",
      "utf8"
    );
    const after = misses(census(corpus));
    expect(
      after.length,
      "The census flagged a planted control that meets the floor by `.tap-target` at " +
        `${TAP_TARGET_MIN_RENDERED_PX}px rendered. A guard that cries wolf on compliant code ` +
        "is deleted, and the rule goes with it."
    ).toBe(before.length);
    // …and it really was scanned, rather than silently skipped.
    expect(census(corpus).some((c) => c.file === plantedRel)).toBe(true);
  });

  // AND THE CORPUS PARAMETER IS NOT A SEPARATE CODE PATH. The two tests above
  // are only worth something if the walk they exercise is the walk the tree
  // gets: same function, same filters, same recursion, one argument different.
  it("is the same walk the tree itself is swept with", () => {
    expect(sourceFiles("components")).toContain(
      "components/facts/FactChipRow.tsx"
    );
    expect(sourceFiles("components", base)).toContain(
      "components/SeedOffender.tsx"
    );
    // The tree's walk cannot see the temp corpus and the temp corpus's walk
    // cannot see the tree — which is the whole point of the move.
    expect(sourceFiles("components", base)).not.toContain(
      "components/facts/FactChipRow.tsx"
    );
  });
});

// The temp dir is only used to prove the walk's own filters, kept separate from
// the planted-offender case above so a failure says which of the two broke.
describe("the walk's filters", () => {
  it("does not wander outside the scanned roots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tap-floor-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Outside.tsx"),
        '<button className="h-4 w-4" onClick={x} />',
        "utf8"
      );
      expect(census().some((c) => c.file.includes("Outside"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
