import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHIP_SM_RENDERED_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
  TAP_TARGET_MIN_RENDERED_PX,
  UnreadableControlError,
  belowSmHeightPx,
  buttonFloorClasses,
  findFlooredControls,
  floorMiss,
  usesTapTarget,
  withoutComments,
  type FloorMechanism,
  type FlooredControl,
  type ImportedModule,
} from "../tap-floor-reach";
import { makeTmpDir } from "./tmp-dir";

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
//      works, and `.chip-sm` using its shared rendered floor.
//   5. A RATCHET over what already misses. Labelled native boxes are licensed
//      separately and counted exactly below; this file does not pretend the rest
//      comply — it stops the number growing and records what each group awaits.
//   6. AND A SECOND ROSTER FOR WHAT THIS CENSUS CANNOT JUDGE. A `.tap-target`
//      control that pins no height in source makes `floorMiss` return null at its
//      first line, so it is neither a finding nor cleared. The roster is empty
//      after #3562, and keeping that exact assertion prevents the blind spot from
//      returning silently.
//   7. AND A THIRD FOR WHAT IT CANNOT EVEN READ. A control whose class list is
//      composed somewhere else — a forwarded `className` prop, a `.map()`
//      variable — comes back `readable: false`, and those are rostered EXACTLY
//      too. Until #3561 they were not a roster and not a finding: a hoisted
//      constant reached the scan as its own IDENTIFIER, matched no height token,
//      and read as a control that simply pins no height. Three live 40px controls
//      were behind that (`TrainingLogCalendar`, raised here) and a fourth turned
//      up when that closed (`ActivityOverlay`, subsequently cleared by the
//      shared 44px overlay-handle target in #3691).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components"];
const BUTTON_FLOOR_CLASSES = buttonFloorClasses(
  fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8")
);

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
// 2026-08-25: 1464 interactive controls carrying a `className`, of which 350 are
// `.btn`-family members and 31 take `.tap-target` as their mechanism. It only
// ever moves up, and only when someone has looked.
//
// The same 1456 measured 2026-08-22, before #3561 taught the scan to resolve a
// hoisted class list. The TOTAL did not move, because an unreadable class list was
// always counted here — it is what the scan then DID with it that changed. What
// moved is underneath: 159 controls could receive a verdict and now 178 explicit
// heights can. The governed floor below also counts authenticated CSS mechanisms,
// so the subset this rule can actually clear or reject cannot disappear behind a
// stable headline. `.tap-target` as a mechanism separately went 38 -> 51, then
// back to 35 as adjacent controls took rendered ownership in #3562's first
// pass, then 31 when the four owner-held controls converged.
const CENSUS_FLOOR = 1200;
// Filled from the governed source-verdict population below: explicit readable
// heights plus the two mechanisms whose rendered floor arrives from CSS.
const GOVERNED_CENSUS_FLOOR = 494;
const MECHANISM_CENSUS_FLOORS: Partial<Record<FloorMechanism, number>> = {
  "btn-family": 350,
  "tap-target": 31,
  "chip-sm": 21,
  rendered: 39,
};
const LICENSED_NATIVE_BOXES = 51;

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
    // The two controls here are the CAPTION TEXT INPUTS —
    // `video-clip-caption-input-*` (`input h-8`) and the new-clip `Caption
    // (optional)` field (`input h-9`). The file's two icon buttons at the
    // figcaption now has one standard OverflowMenu trigger instead of the two
    // under-floor glyphs (#3562).
    why: `${TYPED_FIELD}. This entry is the two caption text inputs only`,
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
 * see the module header on what a class-list scan can see. The exact empty roster
 * after #3562 makes a future blind spot fail instead of growing silently.
 *
 * So they are rostered here, by file and count, and the census asserts the
 * roster is EXACTLY what it finds. A new unpinned `.tap-target` is red until
 * someone records it; one that gains a height is red until someone removes it.
 * This is not a register of exemptions — nothing here is licensed. It is the
 * size of the question this scan cannot answer.
 *
 * Why it matters and is not bookkeeping: `.tap-target` adds a FIXED 12px, so a
 * control's compliance depends entirely on its rendered height.
 */
type UnjudgedTapTarget = { file: string; controls: number };

const UNJUDGED_TAP_TARGETS: UnjudgedTapTarget[] = [];

/**
 * THE CLASS LISTS THIS CENSUS CANNOT READ AT ALL, ENUMERATED.
 *
 * A control whose `className` is composed somewhere else — `className={className}`
 * forwarded from a caller, a field of a `.map()` variable, a class returned by a
 * motion plan — has no class text in the file it lives in. `findFlooredControls`
 * marks it `readable: false`; nothing about it is judged, and nothing about it is
 * cleared.
 *
 * WHY IT IS A ROSTER AND NOT A THROW. The module throws when it cannot PARSE what
 * it was handed — that is the scan being wrong about the language. This is the
 * other case: no edit to `SubmitButton.tsx` can tell it what class its caller will
 * pass. Demanding one would be a red nobody can clear, and the fix for a red
 * nobody can clear is always to delete the check. So the blind spot is given a
 * SIZE instead: this list is asserted to be exactly what the sweep finds, so a new
 * one is red until someone records it, and one that becomes readable is red until
 * someone removes it.
 *
 * Before #3561 there was no list, because there was no way to tell these apart
 * from a control that had been read and pinned no height. Twelve is the number
 * after the resolver reaches module constants, imported constants, barrel
 * re-exports, record lookups and single-`return` helpers; without those it was 153.
 * CustomRangeToggle left this roster when it took exact ownership of its chip
 * class instead of accepting an unreadable forwarded `className`.
 */
const UNREADABLE_CLASS_LISTS: { file: string; controls: number }[] = [
  { file: "app/(app)/sleep/SleepLogAction.tsx", controls: 1 },
  { file: "app/(app)/upcoming/FoldSummary.tsx", controls: 1 },
  { file: "components/Combobox.tsx", controls: 1 },
  { file: "components/DateField.tsx", controls: 1 },
  { file: "components/DoseStatusControl.tsx", controls: 1 },
  { file: "components/ExerciseDetailPanel.tsx", controls: 1 },
  { file: "components/HrefSelect.tsx", controls: 1 },
  { file: "components/LogActivityButton.tsx", controls: 1 },
  { file: "components/SubmitButton.tsx", controls: 1 },
  { file: "components/activity-form/IntensityPicker.tsx", controls: 1 },
  { file: "components/illness/EndEpisodeReconcile.tsx", controls: 1 },
  { file: "components/illness/ReopenEpisodeReconcile.tsx", controls: 1 },
];

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

const MEASURED_UNDER_FLOOR: MeasuredUnderFloor[] = [];

const UNMEASURED_TAP_TARGETS = 0;

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

/**
 * HOW THE SCAN FOLLOWS AN IMPORT, and why the corpus owns this rather than the
 * module. `lib/tap-floor-reach.ts` resolves a class constant it can reach; where
 * `"@/components/overlay"` LIVES is a fact about the tree, and the planted-offender
 * case below points the identical walk at a temp directory. So the corpus hands the
 * scan a reader, and each module it reaches hands on a reader of its own — which is
 * what makes a barrel readable at all (`./overlay` -> `index.ts` -> `./tokens`).
 *
 * Cached because the same handful of token modules is imported by hundreds of
 * files, and `withoutComments` over each of them is the expensive part.
 */
const moduleCache = new Map<string, ImportedModule | null>();

function moduleReader(corpus: Corpus, dir: string) {
  return (specifier: string): ImportedModule | null => {
    let base: string;
    if (specifier.startsWith("@/"))
      base = path.join(corpus.base, specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(dir, specifier);
    // A package, a stylesheet, anything not in this corpus. Not an error: the
    // control is simply one whose class text is not here, which the roster counts.
    else return null;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const file = base + suffix;
      if (!moduleCache.has(file))
        moduleCache.set(
          file,
          fs.existsSync(file)
            ? {
                source: withoutComments(fs.readFileSync(file, "utf8")),
                readModule: moduleReader(corpus, path.dirname(file)),
              }
            : null
        );
      const found = moduleCache.get(file)!;
      if (found !== null) return found;
    }
    return null;
  };
}

function census(corpus: Corpus = TREE): Found[] {
  const out: Found[] = [];
  for (const root of corpus.roots)
    for (const file of sourceFiles(root, corpus.base)) {
      let controls: FlooredControl[];
      try {
        controls = findFlooredControls(
          withoutComments(read(file, corpus.base)),
          moduleReader(corpus, path.dirname(path.join(corpus.base, file))),
          BUTTON_FLOOR_CLASSES
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

/** The controls for which this source rule can issue a pass or a finding. */
function governedControls<T extends FlooredControl>(found: T[]): T[] {
  return found.filter((control) => {
    if (!control.readable) return false;
    // The associated label is the target, so the native box itself is outside
    // this rule's verdict population. Its exact licensed inventory is pinned.
    if (control.kind === "native-box" && control.labelled) return false;
    if (control.governedAlternative) return true;
    // These mechanisms receive their floor from CSS even when the call site
    // writes no height. The other mechanisms need an explicit rendered height
    // before a source-only rule can prove their arithmetic.
    if (control.mechanism === "btn-family" || control.mechanism === "chip-sm")
      return true;
    return control.belowSmPx !== null;
  });
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
    const governed = governedControls(found);
    expect(
      governed.length,
      `Only ${governed.length} controls remain in the governed source-verdict ` +
        `population, below its floor of ${GOVERNED_CENSUS_FLOOR}. The headline ${found.length} ` +
        "controls cannot prove that the subset this source census can judge is still visible."
    ).toBeGreaterThanOrEqual(GOVERNED_CENSUS_FLOOR);
    expect(
      found.filter(
        (control) => control.kind === "native-box" && control.labelled
      ).length,
      "The licensed native-box count changed. Each one is exempt only because an " +
        "associated label owns its tap; inspect any added/removed association before updating it."
    ).toBe(LICENSED_NATIVE_BOXES);
    // Every registered mechanism has its own live-population ratchet. One can no
    // longer disappear while growth in another keeps the aggregate floor green.
    for (const [mechanism, floor] of Object.entries(
      MECHANISM_CENSUS_FLOORS
    ) as [FloorMechanism, number][]) {
      const population = found.filter(
        (control) =>
          control.mechanism === mechanism ||
          control.reachableMechanisms?.includes(mechanism)
      ).length;
      expect(
        population,
        `Only ${population} controls still authenticate the ${mechanism} mechanism, ` +
          `below its live-population floor of ${floor}. Inspect whether the mechanism ` +
          "really lost adopters or the scanner stopped recognizing them."
      ).toBeGreaterThanOrEqual(floor);
    }
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
      const controls = findFlooredControls(
        source,
        moduleReader(TREE, path.dirname(path.join(REPO, subject.file))),
        BUTTON_FLOOR_CLASSES
      ).filter((c) => c.mechanism === "tap-target" && c.belowSmPx !== null);
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
    expect([...BUTTON_FLOOR_CLASSES].sort()).toEqual([
      "btn",
      "btn-danger",
      "btn-ghost",
    ]);
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

  it("keeps browser float tolerance below a genuine layout miss", () => {
    expect(TAP_FLOOR_FLOAT_EPSILON_PX).toBe(0.01);
    expect(
      TAP_FLOOR_PX - 0.001 + TAP_FLOOR_FLOAT_EPSILON_PX
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(TAP_FLOOR_PX - 0.02 + TAP_FLOOR_FLOAT_EPSILON_PX).toBeLessThan(
      TAP_FLOOR_PX
    );
    for (const rendered of [31.99994, 32.00006])
      expect(Math.abs(rendered - 32)).toBeLessThanOrEqual(
        TAP_FLOOR_FLOAT_EPSILON_PX
      );
    expect(Math.abs(31.98 - 32)).toBeGreaterThan(TAP_FLOOR_FLOAT_EPSILON_PX);
  });
});

describe("the `.tap-target` controls this census cannot judge", () => {
  // `readable` matters here: an UNREADABLE control also has `belowSmPx === null`,
  // and its `className` is the expression as written, which can contain the word
  // `tap-target` without the control carrying the class. Two blind spots, two
  // rosters, and neither may absorb the other.
  const unjudged = found.filter(
    (c) => c.readable && usesTapTarget(c.className) && c.belowSmPx === null
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

  it("holds any measured ones to the arithmetic, not to a memory of it", () => {
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

describe("the class lists this census cannot read (#3561)", () => {
  const unreadable = found.filter((c) => !c.readable);

  it("rosters every one of them, exactly", () => {
    const byFile = new Map<string, number>();
    for (const c of unreadable)
      byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
    const actual = [...byFile]
      .map(([file, controls]) => ({ file, controls }))
      .sort((a, b) => a.file.localeCompare(b.file));
    const rostered = [...UNREADABLE_CLASS_LISTS].sort((a, b) =>
      a.file.localeCompare(b.file)
    );
    expect(
      actual,
      "A control's class list could not be resolved to any class text, so the tap floor " +
        "renders no verdict on it. That USED to be silent — a hoisted `className={CONST}` " +
        "reached this scan as the identifier, matched no height token, and was " +
        "indistinguishable from a control that had been read and pinned no height " +
        "(#3561). If this list grew, either the control's classes moved somewhere this " +
        "scan cannot follow, or the resolver lost a shape it used to handle — record it " +
        "in UNREADABLE_CLASS_LISTS, or make the class list readable. If it shrank, one " +
        "became readable and its entry should go.\n\n" +
        unreadable
          .map((c) => `${c.file}:${c.line} <${c.tag}> ${c.className}`)
          .join("\n")
    ).toEqual(rostered);
  });

  it("renders no verdict on them, and does not pretend to", () => {
    for (const c of unreadable) {
      expect(c.mechanism, `${c.file}:${c.line}`).toBe("unreadable");
      expect(c.belowSmPx, `${c.file}:${c.line}`).toBeNull();
      expect(floorMiss(c), `${c.file}:${c.line}`).toBeNull();
    }
    // And they are a small fraction of the corpus, which is the claim that makes
    // every verdict above worth reading. A resolver that quietly stopped resolving
    // would move controls into this list by the hundred and the roster above would
    // say so — this bound says the sweep is not living on the edge of that.
    expect(unreadable.length).toBeLessThan(found.length / 50);
  });

  it("still reads the controls whose class list is a hoisted constant", () => {
    // THE SUBJECT OF #3561, asserted from the tree rather than from a fixture.
    // `TrainingLogCalendar` hoists ARROW_HIT and DAY_HIT and every control in it
    // uses one; before the resolver, all three came back as identifiers.
    const calendar = found.filter(
      (c) => c.file === "components/TrainingLogCalendar.tsx"
    );
    const arrows = calendar.filter((c) => c.tag === "button");
    expect(
      arrows.length,
      "components/TrainingLogCalendar.tsx no longer holds the two month arrows this " +
        "resolver was written for. If they moved, point this at where they went."
    ).toBe(2);
    for (const arrow of arrows) {
      expect(arrow.readable, `${arrow.line}`).toBe(true);
      expect(
        arrow.belowSmPx,
        `components/TrainingLogCalendar.tsx:${arrow.line} pins ${arrow.belowSmPx}px below ` +
          "`sm` through the hoisted `ARROW_HIT`. It was 40 — correct under the floor as " +
          "#3377 left it, and short under #3514's 44 — and no census could see it."
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    }
    // The day cell is a `next/link`, which this scan does not walk (a capitalised
    // component tag is not a DOM tag). Its class list is the same hoisted constant,
    // so the constant is asserted directly — the height is real either way.
    expect(
      belowSmHeightPx(
        /const DAY_HIT =\s*"([^"]*)"/.exec(
          read("components/TrainingLogCalendar.tsx")
        )![1]
      ),
      "components/TrainingLogCalendar.tsx's DAY_HIT is the day cell's hit box on a " +
        "phone. It tiles one of seven columns in the widened drawer, so both its " +
        "rendered width and height reach the floor (#3536)."
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    const drawerSource = read("components/MobileNav.tsx");
    expect(
      drawerSource,
      "the phone drawer must reserve seven 44px columns after its safe-area gutter"
    ).toContain(
      "w-[max(20rem,calc(19.3125rem+env(safe-area-inset-left)))] max-w-full"
    );
    expect(
      read("components/TrainingLogCalendar.tsx"),
      "the calendar may cancel the ordinary drawer gutter, never the safe-area inset"
    ).toContain(
      "ml-[calc(env(safe-area-inset-left)_-_max(1rem,env(safe-area-inset-left)))]"
    );
    const calendarDrawerGeometry = (viewport: number, safeLeft: number) => {
      const drawer = Math.min(viewport, Math.max(320, 309 + safeLeft));
      const leftPadding = Math.max(16, safeLeft);
      const calendarMarginLeft = safeLeft - leftPadding;
      return {
        gridLeft: leftPadding + calendarMarginLeft,
        gridWidth: drawer - 1 - leftPadding - 16 - calendarMarginLeft + 16,
      };
    };
    for (const [viewport, safeLeft] of [
      [320, 0],
      [390, 10],
      [390, 16],
      [390, 44],
      [430, 60],
    ]) {
      const geometry = calendarDrawerGeometry(viewport, safeLeft);
      expect(
        geometry.gridLeft,
        `a ${viewport}px viewport must keep its calendar inside a ${safeLeft}px left safe inset`
      ).toBeGreaterThanOrEqual(safeLeft);
      expect(
        geometry.gridWidth,
        `a ${viewport}px viewport with ${safeLeft}px left safe inset`
      ).toBeGreaterThanOrEqual(7 * TAP_FLOOR_PX);
    }
  });
});

// ── THE HALF THAT MAKES THE GREEN ABOVE WORTH ANYTHING ──────────────────────
//
// A green sweep over a complying tree says nothing about what the sweep can see.

describe("the TSX source reader", () => {
  it("preserves comment-shaped JSX text while blanking real comments", () => {
    const source = [
      `const hidden = "h-11"; // code comment h-4`,
      `export default function X() {`,
      `  return <><p>a // b</p><span>https://x.co</span><p>a /* b</p>`,
      `    {/* real JSX comment <button className="h-4">z</button> */}`,
      `    <button title="a > b" type="button" className="h-7 w-7">x</button></>;`,
      `}`,
    ].join("\n");
    const clean = withoutComments(source);
    expect(clean).toContain("<p>a // b</p>");
    expect(clean).toContain("<span>https://x.co</span>");
    expect(clean).toContain("<p>a /* b</p>");
    expect(clean).not.toContain("code comment h-4");
    expect(clean).not.toContain("real JSX comment");
    const [control] = findFlooredControls(
      clean,
      undefined,
      BUTTON_FLOOR_CLASSES
    );
    expect(control.className).toBe("h-7 w-7");
    expect(floorMiss(control)).not.toBeNull();
  });

  it("keeps a nested control after line-leading comment-shaped JSX text", () => {
    const source = `export function X() {
      return <div>
        // visible prefix <button className="h-4">x</button>
        <button className="h-7">y</button>
      </div>;
    }`;
    const clean = withoutComments(source);
    expect(clean).toContain("// visible prefix");
    const controls = findFlooredControls(
      clean,
      undefined,
      BUTTON_FLOOR_CLASSES
    );
    expect(controls).toHaveLength(2);
    expect(controls.map((control) => control.belowSmPx)).toEqual([16, 28]);
    expect(controls.map(floorMiss).every((miss) => miss !== null)).toBe(true);
  });
});

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
    expect(belowSmHeightPx("[min-height:2rem]")).toBe(32);
    expect(belowSmHeightPx("pointer-coarse:h-8")).toBe(32);
    // Half steps and the 1px step.
    expect(belowSmHeightPx("h-3.5")).toBe(14);
    expect(belowSmHeightPx("h-px")).toBe(1);
    // A neighbouring utility that merely CONTAINS the token is not the token.
    expect(belowSmHeightPx("max-h-64 overflow-y-auto")).toBeNull();
    expect(belowSmHeightPx("h-full")).toBeNull();
  });
});

const scan = (source: string) =>
  findFlooredControls(withoutComments(source), undefined, BUTTON_FLOOR_CLASSES);

/**
 * The same scan with a handful of in-memory modules behind it, so an import hop
 * can be exercised without a temp directory. Each module can itself import from
 * this same set, which is what a barrel needs.
 */
function scanWith(
  source: string,
  modules: Record<string, string>
): FlooredControl[] {
  const reader = (specifier: string): ImportedModule | null =>
    specifier in modules
      ? {
          source: withoutComments(modules[specifier]),
          readModule: reader,
        }
      : null;
  return findFlooredControls(
    withoutComments(source),
    reader,
    BUTTON_FLOOR_CLASSES
  );
}

describe("the sweep can see an offender", () => {
  it("counts the actual source-verdict population and names its exclusions", () => {
    const controls = scan(
      `export default function X() {
         return <>
           <button className="btn">family</button>
           <button className="chip chip-filter chip-sm">dense chip</button>
           <button className="tap-target h-8">overlay</button>
           <button className="h-7">explicit offender</button>
           <button className="tap-target">unmeasured overlay</button>
           <label><input type="checkbox" className="h-4" />label owns tap</label>
         </>;
       }`
    );
    expect(controls.map((control) => control.mechanism)).toEqual([
      "btn-family",
      "chip-sm",
      "tap-target",
      "none",
      "tap-target",
      "none",
    ]);
    expect(
      governedControls(controls).map((control) => control.mechanism)
    ).toEqual(["btn-family", "chip-sm", "tap-target", "none"]);
  });

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

  it("catches the unapproved dense-chip payload directly and through an imported helper", () => {
    const payload =
      "chip chip-filter chip-sm outline-2 outline-dashed outline-rose-500 pointer-coarse:h-8 [min-height:2rem]";
    const [direct] = scan(
      `export default function X() { return <button aria-pressed className="${payload}">x</button>; }`
    );
    const [imported] = scanWith(
      'import { CHIP } from "@/lib/chips"; export default function X() { return <button aria-pressed className={CHIP}>x</button>; }',
      { "@/lib/chips": `export const CHIP = "${payload}";` }
    );
    for (const control of [direct, imported]) {
      expect(control.readable).toBe(true);
      expect(control.mechanism).toBe("chip-sm");
      expect(control.belowSmPx).toBe(32);
      expect(floorMiss(control)).toContain(
        "undercuts `chip-sm`'s shared 44px rendered floor"
      );
    }
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

// ── THE CLASS LIST IS RESOLVED, OR THE CONTROL IS COUNTED (#3561) ──────────
//
// Every case below is a class list this scan USED to read as the literal text of
// its own expression — `className={ARROW_HIT}` was the class list "ARROW_HIT" —
// which matched no height token and came back indistinguishable from a control
// that pins none. A green sweep over a complying tree says nothing about that, so
// each shape is planted here with a height UNDER the floor: if the resolver stops
// reading it, the assertion that it is a finding fails.

describe("the sweep resolves a class list written somewhere else", () => {
  it("reads a module-scope constant, which is the shape #3561 was filed about", () => {
    const [control] = scan(
      `const ARROW_HIT = "flex h-10 w-10 items-center justify-center";
       export default function X() {
         return <button type="button" className={ARROW_HIT}>*</button>;
       }`
    );
    expect(control.readable).toBe(true);
    expect(control.belowSmPx).toBe(40);
    expect(control.className).toContain("h-10");
    expect(floorMiss(control)).toContain("40px rendered below `sm`");
  });

  it("reads a constant declared inside the component, not only at module scope", () => {
    // `PaginationControls` writes its steppers this way and the precedent in
    // mobile-density-convention takes module scope only. Refusing this shape
    // would leave the commonest spelling of a hoisted class list unread.
    const [control] = scan(
      `export default function X() {
         const STEP = "flex h-9 w-9 items-center";
         return <button type="button" className={STEP}>*</button>;
       }`
    );
    expect(control.belowSmPx).toBe(36);
    expect(floorMiss(control)).not.toBeNull();
  });

  it("refuses to guess when a name is declared twice in one file", () => {
    // The safety the file-local rule gives up, bought back. Which declaration a
    // call site meant is a guess, and a guess here silently prices a control.
    const [control] = scan(
      `function A() {
         const HIT = "h-11 w-11";
         return <span className={HIT} />;
       }
       export default function X() {
         const HIT = "h-8 w-8";
         return <button type="button" className={HIT}>*</button>;
       }`
    );
    expect(control.readable).toBe(false);
    expect(control.mechanism).toBe("unreadable");
    expect(floorMiss(control)).toBeNull();
  });

  it("follows a named import into the module that declares it", () => {
    const [control] = scanWith(
      `import { MENU_ITEM } from "./menu";
       export default function X() {
         return <button type="button" className={MENU_ITEM}>*</button>;
       }`,
      { "./menu": `export const MENU_ITEM = "block h-9 w-full px-3";` }
    );
    expect(control.belowSmPx).toBe(36);
    expect(floorMiss(control)).not.toBeNull();
  });

  it("follows a BARREL, which is how this tree actually writes its tokens", () => {
    // This is the shape ActivityOverlay uses for
    // `OVERLAY_DRAG_HANDLE_HIT`: imported from "./overlay", an
    // index that re-exports it from "./tokens", whose value is composed from a
    // constant that never crosses either hop. Stopping at the first module reads
    // nothing; a sub-floor button behind those three hops must remain visible.
    const [control] = scanWith(
      `import { HANDLE } from "./overlay";
       export default function X() {
         return <button type="button" className={HANDLE}>*</button>;
       }`,
      {
        "./overlay": `export { HANDLE } from "./tokens";`,
        "./tokens": [
          `const BOX = "mx-auto flex w-16";`,
          "export const HANDLE = `${BOX} h-6 items-center`;",
        ].join("\n"),
      }
    );
    expect(control.className).toContain("mx-auto");
    expect(control.belowSmPx).toBe(24);
    expect(floorMiss(control)).toContain("24px rendered below `sm`");
  });

  it("follows an `export *` re-export too", () => {
    const [control] = scanWith(
      `import { FIELD } from "./model";
       export default function X() {
         return <input type="text" className={FIELD} />;
       }`,
      {
        "./model": `export * from "@/lib/form-model";`,
        "@/lib/form-model": `export const FIELD = "input h-8 w-full";`,
      }
    );
    expect(control.belowSmPx).toBe(32);
  });

  it("reads every value of a record a class list indexes into", () => {
    // `PhotoPicker` picks its class by variant. Which branch runs is not a thing
    // a source scan knows, so it reads all of them — the same trade a ternary
    // already makes, and the one that can only produce a FALSE finding.
    const [control] = scan(
      `const BY_VARIANT = { default: "h-11 w-11", compact: "h-7 w-7" };
       export default function X({ variant }: { variant: "default" | "compact" }) {
         return <button type="button" className={BY_VARIANT[variant]}>*</button>;
       }`
    );
    expect(control.readable).toBe(true);
    expect(control.className).toContain("h-7");
    expect(floorMiss(control)).not.toBeNull();
  });

  it("reads a single-`return` helper and an arrow, called with an argument", () => {
    for (const helper of [
      'function chip(on: boolean): string { return `h-8 w-8 ${on ? "bg-brand-50" : ""}`; }',
      'const chip = (on: boolean) => `h-8 w-8 ${on ? "bg-brand-50" : ""}`;',
    ]) {
      const [control] = scan(
        `${helper}
         export default function X({ on }: { on: boolean }) {
           return <button type="button" className={chip(on)}>*</button>;
         }`
      );
      expect(control.belowSmPx, helper).toBe(32);
      expect(floorMiss(control), helper).not.toBeNull();
    }
  });

  it("is not walked into an unreadable state by a condition it never had to read", () => {
    // `MoodValencePicker`'s shape. `selected` is `value === score` is `index + 1`
    // is a `.map()` parameter — expanding a TEST that cannot contribute class text
    // walked the resolver off the end of a wholly literal class list and reported
    // it unreadable. Substitute what a browser would concatenate, not what it
    // would evaluate.
    const [control] = scan(
      `export default function X({ value }: { value: number }) {
         return [1, 2].map((face, index) => {
           const score = index + 1;
           const selected = value === score;
           return (
             <button
               key={score}
               type="button"
               className={\`flex h-9 w-9 \${selected ? "border-brand-500" : "opacity-60"}\`}
             >
               {face}
             </button>
           );
         });
       }`
    );
    expect(control.readable).toBe(true);
    expect(control.belowSmPx).toBe(36);
  });

  it("ignores a comment written inside a `${…}` hole", () => {
    // `withoutComments` treats a template literal as opaque, which is right for a
    // file and wrong for a hole — and this app explains its class choices there.
    // An unblanked comment is not noise: its prose carries apostrophes and
    // backticks, which every scanner downstream reads as an unterminated string.
    const [control] = scan(
      "export default function X({ on }: { on: boolean }) {\n" +
        "  return (\n" +
        "    <button\n" +
        '      type="button"\n' +
        "      className={`h-8 w-8 ${\n" +
        "        on\n" +
        "          ? // the row's own colour — see #3486's note about `sm`\n" +
        '            "bg-brand-50"\n' +
        '          : ""\n' +
        "      }`}\n" +
        "    >\n" +
        "      x\n" +
        "    </button>\n" +
        "  );\n" +
        "}"
    );
    expect(control.readable).toBe(true);
    expect(control.belowSmPx).toBe(32);
    expect(control.className).toContain("bg-brand-50");
    expect(control.className).not.toContain("#3486");
  });

  it("counts a class list composed at the CALL SITE instead of inventing a verdict", () => {
    const [control] = scan(
      `export default function X({ className }: { className: string }) {
         return <button type="button" className={className}>*</button>;
       }`
    );
    expect(control.readable).toBe(false);
    expect(control.mechanism).toBe("unreadable");
    expect(control.belowSmPx).toBeNull();
    // NOT a clearance. The census rosters this; `floorMiss` only declines to
    // speak, and the difference is the whole of #3561.
    expect(floorMiss(control)).toBeNull();
  });

  it("throws on a class list it cannot parse, rather than reporting a clean read", () => {
    // The OTHER failure, and the one that does throw: this is not a class list
    // composed elsewhere, it is source this scan does not understand. Returning
    // "no height pinned" from a parser that gave up is the #3561 defect in its
    // purest form, so the parser says so instead.
    expect(() =>
      scan(
        "export default function X() {\n" +
          '  return <button type="button" className={\'h-8 w-8}>x</button>;\n' +
          "}"
      )
    ).toThrow(UnreadableControlError);
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

  it("derives family membership and catches a call-site minimum that lowers it", () => {
    const [modifierOnly] = scan(
      `export default function X() {
         return <button type="button" className="btn-sm min-h-7">x</button>;
       }`
    );
    expect(modifierOnly.mechanism).toBe("none");
    expect(floorMiss(modifierOnly)).toContain("neither registered mechanism");

    const [lowered] = scan(
      `export default function X() {
         return <button type="button" className="btn min-h-8">x</button>;
       }`
    );
    expect(lowered.mechanism).toBe("btn-family");
    expect(floorMiss(lowered)).toContain(
      "32px call-site minimum replaces the button family's 44px"
    );

    const [heightOnly] = scan(
      `export default function X() {
         return <button type="button" className="btn h-8">x</button>;
       }`
    );
    expect(floorMiss(heightOnly)).toBeNull();
  });

  it("does not authenticate a variant-prefixed button-family suffix", () => {
    for (const token of ["sm:btn", "hover:btn", "max-sm:btn"]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className="${token} h-7">x</button>;
         }`
      );
      expect(control.mechanism, token).toBe("none");
      expect(floorMiss(control), token).toContain(
        "with neither registered mechanism"
      );
    }
  });

  it("requires every reachable conditional or logical class arm to be safe", () => {
    for (const expression of [
      `ok ? "btn" : "h-7"`,
      `"h-7 " + (ok && "btn")`,
      `ok ? "h-7" : "tap-target h-8"`,
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className={${expression}}>x</button>;
         }`
      );
      expect(control.belowSmPx, expression).toBe(28);
      expect(floorMiss(control), expression).toContain(
        "with neither registered mechanism"
      );
    }

    for (const expression of [
      `ok ? "btn" : "min-h-11"`,
      `"min-h-11 " + (ok && "btn")`,
      `ok ? "min-h-11" : "tap-target h-8"`,
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className={${expression}}>x</button>;
         }`
      );
      expect(floorMiss(control), expression).toBeNull();
    }
  });

  it("does not let a governed class arm lend its proof to an empty arm", () => {
    for (const expression of [
      `ok && "btn"`,
      `ok ? "btn" : ""`,
      `ok ? "btn" : "px-1"`,
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className={${expression}}>x</button>;
         }`
      );
      expect(floorMiss(control), expression).toContain(
        "reachable class-expression arm"
      );
      expect(control.reachableMechanisms, expression).not.toContain(
        "btn-family"
      );
    }
  });

  it("fails closed instead of flattening more than 64 class alternatives", () => {
    const expression = ["a", "b", "c", "d", "e", "f", "g"]
      .map(
        (condition, index) =>
          `(${condition} && "${index === 0 ? "btn" : `x${index}`}")`
      )
      .join(' + " " + ');
    expect(() =>
      scan(
        `export default function X() {
           return <button type="button" className={${expression}}>x</button>;
         }`
      )
    ).toThrow(/more than 64 reachable alternatives/);

    const atBound = ["a", "b", "c", "d", "e", "f"]
      .map(
        (condition, index) =>
          `(${condition} && "${index === 0 ? "btn" : `x${index}`}")`
      )
      .join(' + " " + ');
    const [control] = scan(
      `export default function X() {
         return <button type="button" className={${atBound}}>x</button>;
       }`
    );
    expect(floorMiss(control)).toContain("reachable class-expression arm");
  });

  it("requires priced tap-target arithmetic in every governed class arm", () => {
    for (const expression of [
      `ok ? "btn" : "tap-target"`,
      `ok ? "tap-target" : "btn"`,
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className={${expression}}>x</button>;
         }`
      );
      expect(control.mechanism, expression).toBe("tap-target");
      expect(control.belowSmPx, expression).toBeNull();
      expect(control.unprovenAlternative, expression).toBe(true);
      expect(floorMiss(control), expression).toContain(
        "reachable class-expression arm"
      );
      expect(control.reachableMechanisms, expression).toEqual([]);
      expect(
        control.readable &&
          usesTapTarget(control.className) &&
          control.belowSmPx === null,
        expression
      ).toBe(true);
    }

    const [safe] = scan(
      `export default function X() {
         return <button className={ok ? "btn" : "tap-target h-8"}>x</button>;
       }`
    );
    expect(floorMiss(safe)).toBeNull();
    expect(safe.reachableMechanisms).toEqual(["btn-family", "tap-target"]);

    const [short] = scan(
      `export default function X() {
         return <button className={ok ? "btn" : "tap-target h-7"}>x</button>;
       }`
    );
    expect(floorMiss(short)).toContain("40px effective");
    expect(short.reachableMechanisms).toEqual([]);
  });

  it("fails closed on explicit and important button-family minimum overrides", () => {
    for (const [classes, fragment] of [
      ["btn min-h-auto h-7", "cannot prove"],
      ["btn max-sm:min-h-auto h-7", "cannot prove"],
      ["btn min-h-7! min-h-11 h-7", "28px call-site minimum"],
      ["btn min-h-7 min-h-11 h-7", "cannot prove"],
    ] as const) {
      const [control] = scan(
        `export default function X() {
           return <button type="button" className="${classes}">x</button>;
         }`
      );
      expect(control.mechanism, classes).toBe("btn-family");
      expect(floorMiss(control), classes).toContain(fragment);
    }

    const [safe] = scan(
      `export default function X() {
         return <button type="button" className="btn min-h-7 min-h-11! h-7">x</button>;
       }`
    );
    expect(floorMiss(safe)).toBeNull();
  });

  it("rejects phone-applicable, custom-property and inline family minima", () => {
    for (const token of [
      "max-md:min-h-7",
      "dark:min-h-7",
      "landscape:min-h-7",
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button className="btn h-7 ${token}">x</button>;
         }`
      );
      expect(floorMiss(control), token).toContain("cannot prove");
    }

    expect(() =>
      scan(
        `export default function X() {
           return <button className="btn h-7 min-h-(--compact)">x</button>;
         }`
      )
    ).toThrow(UnreadableControlError);

    for (const source of [
      `export default function X() {
         return <button className="btn h-7" style={{ minHeight: 28 }}>x</button>;
       }`,
      `const LOW = { style: { minHeight: 28 } };
       export default function X() {
         return <button {...LOW} className="btn h-7">x</button>;
       }`,
    ]) {
      const [control] = scan(source);
      expect(floorMiss(control), source).toContain(
        "28px call-site minimum replaces the button family's 44px"
      );
    }

    const [desktopOnly] = scan(
      `export default function X() {
         return <button className="btn h-7 sm:min-h-7">x</button>;
       }`
    );
    expect(floorMiss(desktopOnly)).toBeNull();
    const [inlineSafe] = scan(
      `export default function X() {
         return <button className="btn h-7" style={{ minHeight: 44 }}>x</button>;
       }`
    );
    expect(floorMiss(inlineSafe)).toBeNull();
  });

  it("resolves referenced and spread inline minima, including block-size", () => {
    for (const source of [
      `const SMALL = { minHeight: 28 };
       export default function X() {
         return <button className="btn h-7" style={SMALL}>x</button>;
       }`,
      `const SMALL = { minHeight: 28 };
       export default function X() {
         return <button className="btn h-7" style={{ ...SMALL }}>x</button>;
       }`,
      `export default function X() {
         return <button className="btn h-7" style={{ minBlockSize: 28 }}>x</button>;
       }`,
      `export default function X() {
         return <button className="btn h-7" style={{ "min-block-size": 28 }}>x</button>;
       }`,
    ]) {
      const [control] = scan(source);
      expect(floorMiss(control), source).toContain(
        "28px call-site minimum replaces the button family's 44px"
      );
    }

    for (const source of [
      `const SAFE = { minHeight: 44 };
       export default function X() {
         return <button className="btn h-7" style={SAFE}>x</button>;
       }`,
      `const SAFE = { minBlockSize: 44 };
       export default function X() {
         return <button className="btn h-7" style={{ ...SAFE }}>x</button>;
       }`,
      `const SMALL = { minHeight: 28 };
       export default function X() {
         return <button className="btn h-7" style={{ ...SMALL, minHeight: 44 }}>x</button>;
       }`,
    ]) {
      const [control] = scan(source);
      expect(floorMiss(control), source).toBeNull();
    }

    expect(() =>
      scan(
        `export default function X({ style }) {
           return <button className="btn h-7" style={style}>x</button>;
         }`
      )
    ).toThrow(UnreadableControlError);

    const [lateLow] = scan(
      `const SAFE = { minHeight: 44 };
       export default function X() {
         return <button className="btn h-7" style={{ ...SAFE, minHeight: 28 }}>x</button>;
       }`
    );
    expect(floorMiss(lateLow)).toContain(
      "28px call-site minimum replaces the button family's 44px"
    );
  });

  it("resolves numeric arguments passed through style helpers", () => {
    for (const helper of [
      `const makeStyle = (n: number) => ({ minHeight: n });`,
      `const makeStyle = (n: number) => ({ minBlockSize: n });`,
      `const makeStyle = (minHeight: number) => ({ minHeight });`,
      `const makeStyle = (minBlockSize: number) => ({ minBlockSize });`,
    ]) {
      const [safe] = scan(
        `${helper}
         export default function X() {
           return <button className="btn h-7" style={makeStyle(44)}>x</button>;
         }`
      );
      expect(floorMiss(safe), helper).toBeNull();

      const [low] = scan(
        `${helper}
         export default function X() {
           return <button className="btn h-7" style={makeStyle(28)}>x</button>;
         }`
      );
      expect(floorMiss(low), helper).toContain(
        "28px call-site minimum replaces the button family's 44px"
      );

      expect(
        () =>
          scan(
            `${helper}
             export default function X({ size }: { size: number }) {
               return <button className="btn h-7" style={makeStyle(size)}>x</button>;
             }`
          ),
        helper
      ).toThrow(UnreadableControlError);
    }
  });

  it("accepts known-safe phone-applicable family minima", () => {
    for (const token of [
      "dark:min-h-11",
      "max-md:min-h-11",
      "landscape:min-h-11",
    ]) {
      const [control] = scan(
        `export default function X() {
           return <button className="btn h-7 ${token}">x</button>;
         }`
      );
      expect(floorMiss(control), token).toBeNull();
    }

    const [conflicting] = scan(
      `export default function X() {
         return <button className="btn h-7 dark:min-h-11 dark:min-h-7">x</button>;
       }`
    );
    expect(floorMiss(conflicting)).toContain("cannot prove");
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

  it("keeps a regular chip quiet without masking a competing mechanism", () => {
    // The single most important silence here. A chip is acquired by its WIDTH
    // along a scrolling row, and app/globals.css says so in as many words ("NO
    // RENDERED HEIGHT FLOOR, DELIBERATELY"). A census that flagged the app's filter pills
    // would be switched off within a week and would take the real rule with it.
    const [control] = scan(
      `export default function X() {
         return <button type="button" className="chip chip-filter" aria-pressed={on}>Meds</button>;
       }`
    );
    expect(control.belowSmPx).toBeNull();
    expect(floorMiss(control)).toBeNull();
    const [ordinary] = scan(
      `export default function X() {
         return <button type="button" className="foo bar h-7">Meds</button>;
       }`
    );
    expect(floorMiss(ordinary)).not.toBeNull();
    const [localHeight] = scan(
      `export default function X() {
         return <button type="button" className="chip chip-filter h-7">Meds</button>;
       }`
    );
    expect(floorMiss(localHeight)).toContain(
      "with neither registered mechanism"
    );
    const [collision] = scan(
      `export default function X() {
         return <button type="button" className="chip btn min-h-4">Meds</button>;
       }`
    );
    expect(collision.mechanism).toBe("btn-family");
    expect(floorMiss(collision)).toContain(
      "16px call-site minimum replaces the button family's 44px"
    );
    expect(
      fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8"),
      "app/globals.css no longer records that `.chip` declares no height floor on " +
        "purpose. The silence above is licensed by that sentence; if the decision " +
        "changed, this census should stop being quiet."
    ).toContain("NO RENDERED HEIGHT FLOOR, DELIBERATELY");
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
  const base = makeTmpDir("tap-floor-corpus");
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

  it("flags a call-site minimum that undercuts chip-sm's rendered floor", () => {
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    const before = misses(census(corpus));
    fs.writeFileSync(
      planted,
      "export default function PlantedDenseChip() {\n" +
        '  return <button type="button" aria-pressed="false" className="chip chip-filter chip-sm min-h-4">x</button>;\n' +
        "}\n",
      "utf8"
    );
    const after = misses(census(corpus));
    const caught = after.filter((m) => m.control.file === plantedRel);
    expect(caught).toHaveLength(1);
    expect(caught[0].control.mechanism).toBe("chip-sm");
    expect(caught[0].control.belowSmPx).toBe(16);
    expect(caught[0].why).toContain(
      `undercuts \`chip-sm\`'s shared ${CHIP_SM_RENDERED_PX}px rendered floor`
    );
    expect(after.length).toBe(before.length + 1);
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

  it("flags one whose class list is a constant in ANOTHER file it had to open", () => {
    // THE #3561 SHAPE, END TO END. Everything in the resolver's own describe is
    // handed its modules in memory; this one makes the walk find the component on
    // disk AND makes the scan open the module beside it, through the corpus's own
    // reader. A reader that resolved `@/` against the wrong base, or stopped at a
    // barrel, would leave the class list unread — and unread is exactly the state
    // that used to look like "pins no height".
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    const before = misses(census(corpus));
    fs.mkdirSync(path.join(base, "components", "tokens"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "components", "tokens", "index.ts"),
      'export { HANDLE } from "./hit";\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(base, "components", "tokens", "hit.ts"),
      'const BOX = "mx-auto flex w-16";\n' +
        "export const HANDLE = `${BOX} h-6 items-center`;\n",
      "utf8"
    );
    fs.writeFileSync(
      planted,
      'import { HANDLE } from "@/components/tokens";\n' +
        "export default function PlantedHoisted() {\n" +
        '  return <button type="button" className={HANDLE}>x</button>;\n' +
        "}\n",
      "utf8"
    );
    const after = misses(census(corpus));
    const caught = after.filter((m) => m.control.file === plantedRel);
    expect(
      caught,
      "The census did not flag a control whose class list is a constant re-exported " +
        "from a module beside it. That is the #3561 defect: the class list came back as " +
        "the identifier `HANDLE`, matched no height token, and read as a control that " +
        "pins none. Check the corpus's module reader before the resolver."
    ).toHaveLength(1);
    expect(caught[0].control.readable).toBe(true);
    expect(caught[0].control.belowSmPx).toBe(24);
    expect(after.length).toBe(before.length + 1);
  });

  it("counts, rather than clears, a plant whose class list comes from its caller", () => {
    if (fs.existsSync(planted)) fs.unlinkSync(planted);
    const before = misses(census(corpus));
    fs.writeFileSync(
      planted,
      "export default function PlantedForwarded({ className }: { className: string }) {\n" +
        '  return <button type="button" className={className}>x</button>;\n' +
        "}\n",
      "utf8"
    );
    const scanned = census(corpus).filter((c) => c.file === plantedRel);
    expect(scanned).toHaveLength(1);
    expect(scanned[0].readable).toBe(false);
    expect(scanned[0].mechanism).toBe("unreadable");
    // It is not a finding — there is nothing to find — and it is not silence
    // either: the tree's own roster above is what gives it a number.
    expect(misses(census(corpus)).length).toBe(before.length);
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
    const dir = makeTmpDir("tap-floor");
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
