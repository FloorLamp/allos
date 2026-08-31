import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";

// A COLOURED BIOMARKER VALUE CAN POINT AT ITS BASIS (#2340).
//
// WHAT WAS WRONG. The detail page coloured its latest value from the stored flag but
// built its range display exclusively from the CURATED catalog entry. On an analyte
// the catalog deliberately declines to band, that list is empty and no range rendered
// at all — while the range the flag came from sat on the row, in
// `medical_records.reference_range`, unread by this surface. The reader saw an
// alarming value and no basis for the alarm.
//
// And the same page printed prose about the analyte twice: the curated `note` in the
// header subtitle, the curated `description` in the explainer card fifteen lines
// below, near-paraphrases of each other. The note's one distinct clause — WHY there
// is no band — was the most useful sentence on the page and the one buried furthest
// from where it is asked.
//
// Fixture hygiene (#868): every row here is this spec's OWN, tagged by a source no
// other fixture uses, and removed afterwards. No exact counts of shared-seed
// aggregates.

const DB_PATH = workerDbPath();
const SOURCE = "e2e-basis-2340";
// Two analytes the curated catalog declines to band, which is exactly when the
// curated range list is guaranteed empty: one whose documents printed their own
// range, one whose document printed nothing.
const REPORTED = "Leptin";
const BARE = "Creatinine, Urine";
// #2337: the unqualified glucose entry gave up its band (it was a FASTING one), and
// its fasting sibling kept 70–99. The same surface, one analyte apart.
const UNQUALIFIED_GLUCOSE = "Glucose";
const FASTING_GLUCOSE = "Glucose, Fasting";
const TOUCH_STALE = "Touch tooltip stale result (e2e #3375)";
// The document heading the coined analyte was reported under — a lab VENDOR name, the
// shape the taxonomy cannot map (#1502). Low-entropy and this spec's own.
const REPORTED_HEADING = "Bench Lab Panel 7";

// THE SENTENCES, BECAUSE AC 1 IS ABOUT THE LABEL AND NOTHING AT E2E COUNTS LABELS
// UNLESS YOU ASK BY ACCESSIBLE NAME. A testid-scoped absence assertion binds to an
// artifact of the FIX — the id this change introduced — so it catches a regression
// written the way this change would write one, and misses the regression that exists
// in history: at the merge base `PanelCell`'s mount carries NO testid at all, and the
// stale mount carries `clinical-age-help`. Measured 2026-08-31 — with both base mounts
// restored verbatim, the testid-bound version of this file returned 8 passed, green
// against the literal thing it exists to forbid. So every absence assertion below is
// stated twice: once by name (the property) and once by testid (the shape).
const STALE_SENTENCE = "Over a year old — consider retesting";
// The base spelled the same fact a second way, on the Stale badge.
const BASE_STALE_BADGE_SENTENCE =
  "Latest result over a year old — consider retesting";
const PANEL_COLUMN_SENTENCE =
  "A panel shown as plain text is not mapped to a clinical panel — it is the heading the result was reported under";
const BASE_PANEL_SENTENCE =
  "Not mapped to a clinical panel — showing the heading it was reported under";

// #2347: the band-less reading is dated off the RUN'S FROZEN CLOCK, far enough back
// that the yearly retest clock has run out, so ONE reading carries all three halves of
// the contradiction this spec now covers — a neutral value, a "Recheck" offer, and a
// staleness notice. Never wall time (the suite freezes its instant), and never a
// literal date, which would silently stop being stale as the calendar moves.
function daysAgo(n: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const BARE_DATE = daysAgo(500);

function withDb<T>(fn: (handle: Database.Database, pid: number) => T): T {
  const handle = new Database(DB_PATH);
  try {
    const pid = (
      handle.prepare("SELECT id FROM profiles ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;
    return fn(handle, pid);
  } finally {
    handle.close();
  }
}

function cleanup() {
  withDb((handle, pid) => {
    handle
      .prepare(
        "DELETE FROM saved_items WHERE profile_id = ? AND kind = 'clinical-result' AND key = ?"
      )
      .run(pid, TOUCH_STALE);
    handle.prepare("DELETE FROM medical_records WHERE source = ?").run(SOURCE);
  });
}

test.beforeEach(() => {
  cleanup();
  withDb((handle, pid) => {
    const insert = handle.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit,
          reference_range, flag, source)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Two draws of one band-less analyte carrying DIFFERENT printed ranges — the
    // issue's own evidence that the source's range is the only range that ever
    // applied to that draw, and why the catalog publishes none. Each keeps the flag
    // its document's range produced; nothing canonical can re-derive it.
    insert.run(
      pid,
      "2026-01-06",
      REPORTED,
      REPORTED,
      "1.8",
      1.8,
      "ng/mL",
      "3.0-15.0 ng/mL",
      "low",
      SOURCE
    );
    insert.run(
      pid,
      "2026-02-17",
      REPORTED,
      REPORTED,
      "2.1",
      2.1,
      "ng/mL",
      "0.5-13.8 ng/mL",
      "low",
      SOURCE
    );
    // A flagged reading whose document printed no range at all: nothing anywhere on
    // the page can say what it is low against.
    insert.run(
      pid,
      BARE_DATE,
      BARE,
      BARE,
      "42",
      42,
      "mg/dL",
      null,
      "low",
      SOURCE
    );
    // #2337: one glucose draw the document never qualified, and the same number under
    // the entry whose name states the patient fasted. 130 mg/dL is prediabetic
    // fasting and unremarkable an hour after lunch — which is the whole argument.
    insert.run(
      pid,
      "2026-02-17",
      "GLUCOSE",
      UNQUALIFIED_GLUCOSE,
      "130",
      130,
      "mg/dL",
      null,
      null,
      SOURCE
    );
    insert.run(
      pid,
      "2026-02-17",
      "GLUCOSE, FASTING",
      FASTING_GLUCOSE,
      "130",
      130,
      "mg/dL",
      null,
      "high",
      SOURCE
    );
    insert.run(
      pid,
      BARE_DATE,
      TOUCH_STALE,
      TOUCH_STALE,
      "7",
      7,
      "mg/L",
      null,
      null,
      SOURCE
    );
    handle
      .prepare(
        "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'clinical-result', ?)"
      )
      .run(pid, TOUCH_STALE);
    // A stored `panel` heading on the coined analyte. The taxonomy cannot place a
    // name it has never seen, so this row lands in the OTHER group and its Panel cell
    // renders the document's own heading — the ONE state that used to mount a
    // per-row explainer, and the state the panel-column test below needs to reach.
    handle
      .prepare(
        "UPDATE medical_records SET panel = ? WHERE source = ? AND name = ?"
      )
      .run(REPORTED_HEADING, SOURCE, TOUCH_STALE);
  });
});

test.afterEach(() => {
  cleanup();
});

// #3970 rule 1 rehomed the stale vocabulary. It used to be the SAME sentence on two
// buttons of every stale row — the amber age token's and the Stale badge's — and it is
// now stated once, on the Date column header the amber age sits under. `thead` is
// hidden below `sm` (app/globals.css `table-cards`), so this half of the claim is a
// desktop one; the phone card still shows the word "Stale" and the amber "⚠️ 1y".
test("the stale vocabulary is explained once, on the column that carries it (#3970)", async ({
  page,
}) => {
  await page.goto(`/results/clinical-results?q=${encodeURIComponent(BARE)}`);
  const table = page.getByTestId("clinical-results-table");
  const row = table.getByRole("row").filter({ hasText: BARE });
  await expect(row).toBeVisible();
  // Not "no row has one AND the header has one" as two independent reads: the SAME
  // locator, scoped two ways, so a stale sweep cannot pass by finding nothing.
  // BY NAME first — the property the criterion is about, and the only form that sees
  // a regression restored under the base's own ids.
  await expect(
    table.getByRole("button", { name: STALE_SENTENCE, exact: true })
  ).toHaveCount(1);
  await expect(
    row.getByRole("button", { name: STALE_SENTENCE, exact: true })
  ).toHaveCount(0);
  // The base's second spelling of the same fact, gone from the whole table.
  await expect(
    table.getByRole("button", { name: BASE_STALE_BADGE_SENTENCE, exact: true })
  ).toHaveCount(0);
  const help = page.getByTestId("clinical-stale-help");
  await expect(help).toHaveCount(1);
  await expect(row.getByTestId("clinical-stale-help")).toHaveCount(0);
  await expect(
    table.locator("thead").getByTestId("clinical-stale-help")
  ).toHaveCount(1);
  // Still reachable without a mouse at its new home — #3375's constraint binds the
  // single mount exactly as it bound the per-row ones.
  await help.click();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Over a year old — consider retesting"
  );
  // The row keeps the VERDICT in words and in colour; only the button left.
  await expect(row.getByTestId("clinical-result-age")).toContainText("⚠️");
});

// #3970 rule 1 for the other constant on this table: "not mapped to a clinical panel"
// used to mount a button on EVERY row of an unmapped group. It is a property of the
// COLUMN, so the column head states it, and the head carries the same
// `hidden md:table-cell` visibility the cells did — nothing that could reach the old
// mount loses the sentence, which is why this relocation has no phone half.
test("the unmapped-panel sentence is stated once, on the Panel column head (#3970)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results?q=${encodeURIComponent(TOUCH_STALE)}`
  );
  const table = page.getByTestId("clinical-results-table");
  const row = table.getByRole("row").filter({ hasText: TOUCH_STALE });
  await expect(row).toBeVisible();
  // The fixture REACHES the forbidden state: this row is unmapped and prints its
  // document's heading, so it is exactly the row that used to carry the button.
  await expect(row).toContainText(REPORTED_HEADING);

  // BY NAME first. The base's mount here carries no testid whatsoever, so a
  // testid-only absence assertion is green against it.
  await expect(
    table.getByRole("button", { name: PANEL_COLUMN_SENTENCE, exact: true })
  ).toHaveCount(1);
  await expect(
    row.getByRole("button", { name: PANEL_COLUMN_SENTENCE, exact: true })
  ).toHaveCount(0);
  await expect(
    table.getByRole("button", { name: BASE_PANEL_SENTENCE, exact: true })
  ).toHaveCount(0);
  const help = page.getByTestId("clinical-panel-column-help");
  await expect(help).toHaveCount(1);
  await expect(row.getByTestId("clinical-panel-column-help")).toHaveCount(0);
  await expect(
    table.locator("thead").getByTestId("clinical-panel-column-help")
  ).toHaveCount(1);
  // The head's mount keeps its OWN id. `clinical-reported-panel-help` belongs to the
  // date cell's per-row "Reported under …" disclosure, a different fact with a
  // different label, and one id over two labels is a trap for the next selector.
  await expect(
    table.locator("thead").getByTestId("clinical-reported-panel-help")
  ).toHaveCount(0);
  await help.click();
  await expect(page.getByRole("tooltip")).toHaveText(
    "A panel shown as plain text is not mapped to a clinical panel — it is the heading the result was reported under"
  );
});

test("a starred stale-result explanation is stated once and reachable by tap (#3375/#3970)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/results/clinical-results");
  const card = page.getByTestId("starred-results");
  await expect(card).toBeVisible();
  const tile = card
    .getByTestId("starred-tile")
    .filter({ hasText: TOUCH_STALE });
  await expect(tile).toHaveCount(1);
  if (!(await tile.isVisible()))
    await card.getByTestId("starred-fold-toggle").click();
  await expect(tile).toBeVisible();
  // The tile still says "stale" in words; the sentence behind the word is the card's,
  // once, and no tile mounts a button for it (#3970 rule 1).
  await expect(tile).toContainText("stale");
  await expect(
    tile.getByRole("button", { name: STALE_SENTENCE, exact: true })
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: STALE_SENTENCE, exact: true })
  ).toHaveCount(1);
  await expect(tile.getByTestId("starred-stale-help")).toHaveCount(0);
  const help = card.getByTestId("starred-stale-help");
  await expect(help).toHaveCount(1);

  const listUrl = page.url();
  await help.click();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Over a year old — consider retesting"
  );
  // The legend sits outside every tile's detail link, so the tap navigates nowhere.
  await expect(page).toHaveURL(listUrl);
});

test("a band-less analyte shows the source's own range, attributed, and keeps its colour", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(REPORTED)}`
  );

  const value = page.getByTestId("biomarker-latest-value");
  await expect(value).toBeVisible();
  await expect(value).toHaveAttribute("data-basis", "reported");

  // The range the flag actually came from, named as the LAB's — not a population
  // band the app endorses.
  const reported = page.getByTestId("biomarker-reported-range");
  await expect(reported).toBeVisible();
  await expect(reported).toContainText("Reference range (as reported)");
  await expect(reported).toContainText("0.5-13.8 ng/mL");

  // The flag survives, because it now has something on screen to point at. On the
  // header value the severity rides in an `sr-only` span; on the readings table
  // #2343 renders it as text.
  const word = value.getByTestId("medical-flag-text");
  await expect(word).toBeVisible();
  await expect(word).toHaveText("Low");
  const rows = page.getByRole("row").filter({ hasText: "3.0-15.0 ng/mL" });
  await expect(rows).toHaveCount(1);
  const olderWord = rows.getByTestId("medical-flag-text");
  await expect(olderWord).toBeVisible();
  await expect(olderWord).toHaveText("Low");
});

test("a reading with no band and no printed range is not coloured, and claims no severity", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(BARE)}`
  );

  const value = page.getByTestId("biomarker-latest-value");
  await expect(value).toBeVisible();
  await expect(value).toContainText("42");
  await expect(value).toHaveAttribute("data-basis", "none");

  // No range renders — that is the whole point — so no colour and no severity word
  // may be claimed either. #2343 made that word VISIBLE on the readings table, which
  // is precisely why the suppression happens at the flag: an unexplained red would
  // otherwise have become an unexplained red plus the word "Low".
  await expect(page.getByTestId("biomarker-reported-range")).toHaveCount(0);
  // Not even in the accessibility tree: the suppression is at the flag, so the
  // sr-only severity span the header would otherwise carry is gone too.
  await expect(value.getByTestId("medical-flag-text")).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "42 mg/dL" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("medical-flag-text")).toHaveCount(0);
  await expect(row.locator('[data-basis="none"]')).toBeVisible();

  // …AND the care offers on the same reading stay, each naming its own basis (#2347).
  // The ruling was to keep the control and make it honest, not to gate it on the
  // display rule: the stored flag is the source record's own and a reading the lab
  // itself flagged must not become un-recheckable. So the "Recheck" offer is still
  // here, and it now says where its premise came from instead of inheriting the
  // page's silence.
  const followUp = page.getByTestId("lab-followup");
  await expect(followUp).toContainText("Recheck");
  await expect(followUp.getByTestId("track-lab-followup")).toBeVisible();

  const recheckBasis = page.getByTestId("biomarker-recheck-basis");
  await expect(recheckBasis).toBeVisible();
  await expect(recheckBasis).toContainText("Why a recheck is offered.");
  await expect(recheckBasis).toContainText(
    "The record this reading came from flagged it"
  );
  await expect(recheckBasis).toContainText("not a judgment of ours");
  // It attributes the flag; it does not re-speak the severity the value above just
  // declined to claim.
  await expect(recheckBasis).not.toContainText(/\bLow\b/);

  // The staleness notice beside it is the same discipline, different sentence: its
  // premise was always the reading's AGE (its flag reads can only ever EXEMPT), so it
  // keeps its claim and says which of the two things on screen it is about.
  const retestBasis = page.getByTestId("biomarker-retest-basis");
  await expect(retestBasis).toBeVisible();
  await expect(retestBasis).toContainText(
    "This notice is about the reading's age"
  );
});

test("a reading the page CAN judge keeps its recheck offer with no note, because its basis is already on screen (#2347)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(REPORTED)}`
  );

  // Same flag, same offer — but the range that produced it is rendered right beside
  // the value, so there is nothing left for a note to add.
  await expect(page.getByTestId("biomarker-reported-range")).toBeVisible();
  await expect(page.getByTestId("track-lab-followup")).toBeVisible();
  await expect(page.getByTestId("biomarker-recheck-basis")).toHaveCount(0);
  await expect(page.getByTestId("biomarker-retest-basis")).toHaveCount(0);
});

test("the page explains the analyte and places the missing-band reason beside the value", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(REPORTED)}`
  );

  // The explainer card keeps the educational description.
  const explainer = page.getByTestId("biomarker-explainer");
  await expect(explainer).toBeVisible();
  await expect(explainer).toContainText("hormone released by fat tissue");

  // The missing-band reason belongs in the summary card beside the value and the
  // attributed range.
  const bandNote = page.getByTestId("biomarker-band-note");
  await expect(bandNote).toBeVisible();
  await expect(bandNote).toContainText("No reference band.");
  await expect(bandNote).toContainText("no single reference band applies");
});

test("an unqualified glucose shows its value unflagged and says why, while the fasting entry still judges the same number (#2337)", async ({
  page,
}) => {
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(UNQUALIFIED_GLUCOSE)}`
  );

  // The value is shown. Nothing judges it: the catalog publishes no band for a draw
  // whose fasting state was never recorded, and the document printed no range either.
  const value = page.getByTestId("biomarker-latest-value");
  await expect(value).toContainText("130");
  await expect(value).toHaveAttribute("data-basis", "none");
  await expect(value.getByTestId("medical-flag-text")).toHaveCount(0);
  await expect(page.getByTestId("biomarker-reported-range")).toHaveCount(0);

  // And the page can say WHY it is unflagged — the reason is curated, not inferred.
  const bandNote = page.getByTestId("biomarker-band-note");
  await expect(bandNote).toBeVisible();
  await expect(bandNote).toContainText("No reference band.");
  await expect(bandNote).toContainText(
    "Whether this draw was fasting is not recorded"
  );
  await expect(bandNote).toContainText("either band would be a guess");

  // The same number under the entry that DOES state a fasting draw: judged against
  // 70–99, coloured, and the band it was judged by is on screen. Asserted on THIS
  // spec's own row rather than the header, because the shared seed owns fasting
  // glucose draws of its own on this profile.
  await page.goto(
    `/results/clinical-results/view?name=${encodeURIComponent(FASTING_GLUCOSE)}`
  );
  await expect(page.getByText("70–99 mg/dL")).toBeVisible();
  await expect(page.getByTestId("biomarker-band-note")).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: "130 mg/dL" });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-basis="curated"]')).toBeVisible();
  await expect(row.getByTestId("medical-flag-text")).toHaveText("High");
});
