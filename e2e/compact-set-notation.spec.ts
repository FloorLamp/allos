import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import {
  comboboxRows,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";

// Issue #3336 (#3228 item 4): a UNIFORM RUN OF COMPLETED SETS STATES ITSELF.
//
// A three-exercise session of three sets each rendered nine identical rows of four
// controls, though the app already owns the notation for exactly that shape — the one
// `summarizeExercise` the Recent panel, the training log card, the timeline and the
// export all render. So a part that ARRIVES as a finished uniform run opens as
// "100 kg × 5 × 3" with the grid one tap behind it.
//
// FOUR CLAIMS LIVE HERE, and each is the half a reading of the code cannot settle:
//
//   1. The sentence replaces the grid, and the chip is a DISCLOSURE — a button with
//      `aria-expanded`, not a label beside an invisible control.
//   2. COLLAPSE IS DISPLAY ONLY. A save taken while a part is collapsed still writes
//      every one of its sets (#2359: a field the form omits is a field it clears). The
//      activity form composes its payload from React state rather than from mounted
//      inputs — but that is a fact about this form TODAY, not about the pattern (see
//      the lane's correction on #3334), so it is pinned as behaviour through a
//      real save with none of the set inputs in the document.
//   3. A NON-UNIFORM PART NEVER COLLAPSES. Editing one set out of line takes the
//      sentence away AND takes the collapse control with it, because "8, 8, 7" is a
//      choice the notation cannot fold into "× 3".
//   4. LIVE MODE ALWAYS SHOWS THE GRID. The grid is the job in a gym session — the
//      #3218 pattern's workbench exclusion, which #3228 invokes by name.
//
// THREE MUTANTS WERE RUN AGAINST THESE TESTS, and each dies at the assertion under
// test — a green suite over a correct tree says nothing about what it can see:
//
//   | mutant                                            | dies at                       |
//   |---------------------------------------------------|-------------------------------|
//   | `partSetsSummary` stops asking whether the run is  | the non-uniform claim: the    |
//   | uniform                                            | collapse control is still     |
//   |                                                    | there on 5, 5, 6              |
//   | the `live` exclusion is dropped                    | the live grid read-back       |
//   | collapsing truncates the part's sets               | the collapse round-trip       |
//
// Fixture ownership (#868, docs/internals/e2e-hygiene.md failure class 1): the probe
// activity carries a UNIQUE per-run title and every lookup and cleanup keys on it, so
// a --repeat-each rerun or a sibling spec cannot collide with it. A start-of-test
// sweep removes anything a failed run left behind.
//
// FIXTURE POSITION RELATIVE TO THE NEW BOUNDARY: the shared seed's PPL sessions sit on
// BOTH sides of it — a Push day's Bench Press is 8, 8, 8 (compresses) while its
// Overhead Press is 8, 8, 7 (never does) — which is why two shipped specs that reach
// stored set inputs were updated in this change rather than left to pass by landing on
// a neighbouring part: e2e/activity-page.spec.ts (a Leg day is five uniform runs, so
// `set1-weight` was not in the document at all) and e2e/entry-ergonomics.spec.ts (its
// its first-match locator would have silently moved to the first VARIED part).

const PROBE_PREFIX = "Compact set notation probe";
let probeSeq = 0;

// The load every probe set carries. Stated as one constant because the sentence the
// spec asserts is built from it, and a second spelling is how the two drift.
const PROBE_WEIGHT = "100";
const PROBE_REPS = "5";
const PROBE_SETS = 3;
// "100 kg × 5 × 3" — or lb, depending on the login's unit preference, which this spec
// deliberately does not pin: the notation is what is under test, not the unit.
const UNIFORM_SENTENCE = new RegExp(
  `${PROBE_WEIGHT} (kg|lb) × ${PROBE_REPS} × ${PROBE_SETS}`
);

// Training Log row(s) whose title contains `text`, scoped to the main content.
function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .getByTestId("history-row")
    .filter({ hasText: text });
}

// Open the stored session's canonical page, then launch its shared workspace.
async function openEditorFromRow(page: Page, row: Locator): Promise<void> {
  await hydratedClick(
    page,
    row.getByRole("link").first() // first-ok: the canonical title link precedes any exercise links in the row
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
}

// Pick an activity in the editor's exercise combobox (the shape-tolerant matcher the
// entry-ergonomics / rpe-logging specs document).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
}

// Wait on the DEBOUNCED activity autosave by its OWN payload — matching on the
// `next-action` header alone also matches /training's background toaster poll, and a
// poller response resolving the wait early is how the #1189 census read a stale value
// back (the note at rpe-logging's call site has the receipt).
function savePostWith(page: Page, marker: RegExp) {
  return page.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST") return false;
      if (r.request().headers()["next-action"] == null) return false;
      if (!r.ok()) return false;
      const body = r.request().postData();
      return body != null && marker.test(body);
    },
    { timeout: 15_000 }
  );
}

// A payload carrying all three probe sets — the marker that says the run is stored,
// rather than "some save happened".
const THREE_SETS = new RegExp(
  `(?:"reps":${PROBE_REPS}[,}][\\s\\S]*){${PROBE_SETS}}`
);

async function sweepProbes(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training?tab=log");
  const probes = cardsByTitle(page, PROBE_PREFIX);
  for (let guard = 0; guard < 12; guard++) {
    const n = await probes.count();
    if (n === 0) break;
    const row = probes.first(); // first-ok: every PROBE_PREFIX row is this spec's own leftover; cleanup is order-agnostic
    await openEditorFromRow(page, row);
    await confirmDelete(page);
    await page.goto("/training?tab=log");
    await expect(probes).toHaveCount(n - 1);
  }
}

// Log a strength session of PROBE_SETS identical sets and leave the editor open on it.
// Returns the probe's unique title.
//
// `finish` decides which side of the LIVE boundary the probe lands on, and the
// difference is not cosmetic: a manual session with a start time and no end time is
// what `getWorkoutPresence` reads as a workout IN PROGRESS (#921), so reopening it
// resumes LIVE mode and the grid stays — which is the fourth claim above, and is also
// how the first draft of this spec failed. A finished session reopens in plain editing.
async function logUniformProbe(page: Page, finish: boolean): Promise<string> {
  await page.goto("/training?tab=log");
  await page.getByTestId("training-log-add-activity").click();

  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`; // clock-ok: unique probe-name suffix, never a stored timestamp
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  // The fully-qualified variant, not the bare base: a bare variant base needs a
  // per-set equipment pick before it can save (#342).
  await pickActivity(page, "Barbell Bench Press");

  const stored = savePostWith(page, THREE_SETS);
  // A uniform run states its weight ONCE, on the exercise band above the rows, and
  // "+ Add set" copies that load — so the rows take only their reps (#5371). The
  // band carries set 1's id; there is no `set2-weight` until a set varies.
  await settledFill(page, page.getByTestId("set1-weight"), PROBE_WEIGHT);
  for (let i = 1; i <= PROBE_SETS; i++) {
    if (i > 1) await page.getByRole("button", { name: "+ Add set" }).click();
    await settledFill(page, page.getByTestId(`set${i}-reps`), PROBE_REPS);
  }
  // The autosave that carries the WHOLE run. Without it the reopen below can race the
  // debounce and read a two-set session, which would compress just the same and hide
  // the miss.
  await stored;

  if (finish) {
    // An end time is what takes the session out of "in progress" — the pinned e2e
    // timezone puts local now at 13:mm (e2e/pinned-timezone.ts), so 23:59 is always
    // after the start the create form stamped.
    const ended = savePostWith(page, /23:59/);
    const endTime = page.getByTestId("end-time-input");
    await endTime.fill("23:59");
    await ended;
    // AND LEAVE THE FIELD. Focusing a time field opens its wheel beside it
    // (#5360), and Escape closes the innermost open layer — so a caller that
    // presses Escape to dismiss the FORM would close the wheel instead.
    await endTime.blur();
  }
  return title;
}

test("a uniform run of sets states itself, and a save behind it still writes every set (#3336)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit
  await sweepProbes(page);

  const title = await logUniformProbe(page, true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("activity-form")).toHaveCount(0);

  // ---- 1. The stored run opens as a sentence, and the sentence is a disclosure.
  await page.goto("/training?tab=log");
  const row = cardsByTitle(page, title);
  await expect(row).toBeVisible();
  await openEditorFromRow(page, row);
  await expect(page.getByLabel("Activity name")).toHaveValue(title);

  const summary = page.getByTestId("set-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(UNIFORM_SENTENCE);
  // A CHIP IS A DISCLOSURE, not a label beside an invisible control (#3218).
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(summary).toHaveAttribute("data-fact-state", "stated");
  // The grid is genuinely gone — measured against a PRESENT peer (the chip above),
  // so this is "the part rendered and its rows are not there", not "nothing has
  // rendered yet". A bare retrying count-0 would be satisfied by an editor that had
  // not arrived, which is the failure this pair exists to distinguish.
  await expect(page.getByTestId("set1-weight")).toHaveCount(0);
  await expect(page.getByTestId("set-column-headings")).toHaveCount(0);

  // ---- 2. One tap opens the grid, and one tap closes it again.
  await hydratedClick(page, summary);
  await expect(page.getByTestId("set1-weight")).toHaveValue(PROBE_WEIGHT);
  await expect(page.getByTestId(`set${PROBE_SETS}-reps`)).toHaveValue(
    PROBE_REPS
  );
  await expect(summary).toHaveCount(0);
  const collapse = page.getByTestId("set-summary-collapse");
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(summary).toContainText(UNIFORM_SENTENCE);
  await expect(page.getByTestId("set1-weight")).toHaveCount(0);

  // ---- 3. THE WRITE PATH, with none of the set inputs in the document (#2359).
  // Making an edit somewhere else in the form is the whole test: asserting straight
  // after a collapse would pass against a build that drops the sets on every save,
  // because nothing would have saved. Intensity is a session fact that sits outside
  // the part, so this is a REAL save taken while the run is collapsed.
  const savedWhileCollapsed = savePostWith(page, THREE_SETS);
  await page.getByRole("button", { name: "Hard", exact: true }).click();
  await savedWhileCollapsed;

  await page.goto("/training?tab=log");
  await openEditorFromRow(page, cardsByTitle(page, title));
  await expect(page.getByTestId("set-summary")).toContainText(UNIFORM_SENTENCE);

  // ---- 4. A NON-UNIFORM PART NEVER COLLAPSES.
  await hydratedClick(page, page.getByTestId("set-summary"));
  const varied = savePostWith(page, /"reps":6[,}]/);
  await settledFill(
    page,
    page.getByTestId(`set${PROBE_SETS}-reps`),
    String(Number(PROBE_REPS) + 1)
  );
  await varied;
  // Both halves go at once, and that is the point: with no sentence to collapse to
  // there is no collapse control either, rather than one that would have to lie.
  await expect(page.getByTestId("set-summary")).toHaveCount(0);
  await expect(page.getByTestId("set-summary-collapse")).toHaveCount(0);
  // And it stays a grid across a reload — the rule is about the sets, not about
  // whether this browser tab happened to expand them.
  await page.goto("/training?tab=log");
  await openEditorFromRow(page, cardsByTitle(page, title));
  await expect(page.getByTestId("set1-weight")).toHaveValue(PROBE_WEIGHT);
  await expect(page.getByTestId("set-summary")).toHaveCount(0);

  // Cleanup: the probe, from the editor that is already open.
  await confirmDelete(page);
  await page.goto("/training?tab=log");
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});

test("live mode shows the full grid however uniform the run is (#3336/#3228)", async ({
  page,
}) => {
  test.slow();
  await sweepProbes(page);

  try {
    // A session with a start time and no end time IS a workout in progress (#921), so
    // this probe stays on the live side of the boundary — and reopening it RESUMES the
    // live session rather than opening a plain edit (`preserveCurrentWorkout` in
    // ActivityEditorProvider). That is the reachable case the exclusion exists for: you
    // logged three identical sets, the tab reloaded, and the workbench you are standing
    // at must come back as the workbench.
    const title = await logUniformProbe(page, false);
    await page.keyboard.press("Escape");

    await page.goto("/training?tab=log");
    await openEditorFromRow(page, cardsByTitle(page, title));
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    // The present peer is the grid itself, so the absence below is measured against a
    // part that has demonstrably rendered its rows — not against an editor that has
    // not arrived yet.
    await expect(page.getByTestId("set1-weight")).toHaveValue(PROBE_WEIGHT);
    await expect(page.getByTestId("set-summary")).toHaveCount(0);
    await expect(page.getByTestId("set-summary-collapse")).toHaveCount(0);
  } finally {
    // From a finally, because a started-but-unended activity on the shared profile is
    // an ACTIVE workout for every later spec on this worker (#3173) — an earlier
    // failure must not be allowed to skip the disposal.
    await sweepProbes(page);
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);
  }
});
