import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { type Locator, type Page } from "@playwright/test";
import {
  hydratedClick,
  openMeasurementGroup,
  settledClick,
  settledFill,
} from "./helpers";
import { sharedDayRestorePoint } from "./shared-profile-guard";
import { frozenLocalHHMM, frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { utcInstant, zonedWallTimeToUtc } from "@/lib/date";

// The "Log measurements" form's LAYOUT and DISCLOSURE (issue #2014).
//
// The form is authored once and mounted in hosts of very different widths, and its
// grid used to ask the WINDOW (`sm:grid-cols-2 lg:grid-cols-4`). At a 1280px desktop
// that laid four columns into the ~400px quick-entry sheet: 91px cells, wrapped
// labels, and unit rows whose min-content painted straight through the panel edge.
//
// So the assertion here is HOST-WIDTH AWARE rather than a class-name check: measure
// every field against the box it is actually inside, at the viewport where the bug
// appeared. A class assertion would have passed the whole time the screenshot was
// failing.

const LOG_DATE = "2026-01-03"; // deep past — no seeded row for profile 1 to collide with
const LOG_WEIGHT = "71.3";
const DB_PATH = workerDbPath();

function clearLoggedWeight(): void {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM body_metrics WHERE profile_id = 1 AND date = ?")
      .run(LOG_DATE);
  } finally {
    handle.close();
  }
}

// The frozen run's "today" for profile 1 (the pinned zone keeps the local date
// equal to the frozen instant's UTC date — see e2e/pinned-timezone.ts).
const TODAY = frozenNow().toISOString().slice(0, 10);

// The #2235 spec below owns today's MANUAL body row outright: profile 1's seeded
// weights stop at yesterday, and only the manual (source NULL) row is this spec's —
// clearing it restores the shared baseline exactly.
function clearTodayManualBodyRow(): void {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        "DELETE FROM body_metrics WHERE profile_id = 1 AND date = ? AND source IS NULL"
      )
      .run(TODAY);
  } finally {
    handle.close();
  }
}

// Every visible field of the form, measured against the CONTENT BOX of the host it
// is mounted in — the panel's border box less its own padding. Grid items do not
// clip, so an overflowing cell paints over its neighbour or past the panel edge;
// this catches both directions.
async function expectFieldsInsideHost(
  page: Page,
  hostSelector: string
): Promise<void> {
  const offenders = await page.evaluate((selector) => {
    const host = document.querySelector(selector);
    const form = document.getElementById("measurements-quick-add");
    if (!host || !form) return [`missing ${!host ? selector : "form"}`];
    const style = getComputedStyle(host);
    const box = host.getBoundingClientRect();
    const left = box.left + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.paddingRight);
    const bad: string[] = [];
    for (const el of Array.from(
      form.querySelectorAll("input, select, textarea, label")
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // inside a collapsed group
      if (r.right > right + 1 || r.left < left - 1) {
        bad.push(
          `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}> ` +
            `${Math.round(r.left)}–${Math.round(r.right)} vs content box ` +
            `${Math.round(left)}–${Math.round(right)}`
        );
      }
    }
    return bad;
  }, hostSelector);
  expect(offenders, offenders.join("\n")).toEqual([]);
}

async function openEveryGroup(page: Page, form: Locator): Promise<void> {
  for (const group of ["vitals", "body", "sleep"] as const) {
    await openMeasurementGroup(page, form, group);
  }
}

test("the Trends modal's fields stay inside the modal at a desktop viewport", async ({
  page,
}) => {
  test.slow();
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();

  // Trends → Overview → body census opens Body — the SAME component, a different entry point.
  await expect(form.locator("#measurements-group-body-fields")).toBeVisible();

  await openEveryGroup(page, form);
  await expectFieldsInsideHost(
    page,
    '[data-testid="log-measurements-modal-body"]'
  );
});

test("a collapsed group announces its value and still saves it", async ({
  page,
}) => {
  test.slow();
  clearLoggedWeight();
  try {
    await page.goto("/trends");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // A deep-past date so this write owns its row outright. settledFill can't
    // express this one: DateField accepts ISO and then re-renders the COMMITTED
    // value in the display format, so the post-fill assertion is that reformat —
    // which is itself the proof React took the value (a pre-hydration fill would
    // sit there as the raw ISO string until hydration reverted it).
    const dateField = form.locator("#m-date");
    await expect(async () => {
      await dateField.fill(LOG_DATE);
      await expect(dateField).toHaveValue(/Jan 3, 2026|2026-01-03/, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 10_000 }); // topass-ok: hydration-guarded fill of a controlled date field — absolute value, so re-application is a no-op (the settledFill contract, with the display-format reformat as the settle)
    const weight = form.locator("#m-weight");
    await settledFill(page, weight, LOG_WEIGHT);

    // Collapse the group holding it. HIDDEN, NOT UNMOUNTED: the input keeps its
    // value, so the form still posts it — and the header says what is behind the
    // chevron, so the value is never invisible.
    await hydratedClick(
      page,
      form.getByTestId("measurements-group-body-toggle")
    );
    await expect(form.locator("#measurements-group-body-fields")).toBeHidden();
    await expect(
      form.getByTestId("measurements-group-body-summary")
    ).toContainText(LOG_WEIGHT);
    await expect(weight).toHaveValue(LOG_WEIGHT);

    await settledClick(
      page,
      form.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();

    // Server truth, not the toast: the collapsed field reached the write core.
    const handle = new Database(DB_PATH);
    try {
      const row = handle
        .prepare(
          "SELECT weight_kg FROM body_metrics WHERE profile_id = 1 AND date = ?"
        )
        .get(LOG_DATE) as { weight_kg: number } | undefined;
      expect(row?.weight_kg).toBeCloseTo(Number(LOG_WEIGHT), 1);
    } finally {
      handle.close();
    }
  } finally {
    clearLoggedWeight();
  }
});

// The #2154 fold spec below needs today's MANUAL vitals rows for profile 1 to be
// ITS OWN — both server-truth reads below assert a single row — so it clears them
// first. That clear is not a cleanup and never was (#5037): profile 1's seed carries
// two `peak_flow_lmin` rows for today, and this took them from every later test on
// the worker while its comment said it deleted "exactly the rows the spec's own
// submission created". A copy of the day is taken BEFORE the clear and restored
// after, so the clear is a precondition this test owns rather than a hole it leaves.
//
// AND THE MEDICAL_RECORDS HALF OF THAT CLEAR HAD THE SAME HOLE (#5266). The seed
// carries exactly ONE today-dated `medical_records` row for profile 1 — a manual
// Body Temperature of 99.2 °F — and it is the row the first statement below
// deletes. So the copy has to cover both tables, not only the samples one.
function clearTodayManualVitals(): void {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM medical_records
          WHERE profile_id = 1 AND date = ? AND source = 'manual'
            AND canonical_name = 'Body Temperature'`
      )
      .run(TODAY);
    handle
      .prepare(
        `DELETE FROM metric_samples
          WHERE profile_id = 1 AND date = ? AND source = 'manual'
            AND metric = 'peak_flow_lmin'`
      )
      .run(TODAY);
  } finally {
    handle.close();
  }
}

test("the one Time drives temperature and peak flow — the folded per-measure inputs are gone (#2154)", async ({
  page,
}) => {
  test.slow();
  const restoreSharedDay = [
    sharedDayRestorePoint("metric_samples", TODAY),
    sharedDayRestorePoint("medical_records", TODAY),
  ];
  clearTodayManualVitals();
  try {
    await page.goto("/trends");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, form, "vitals");

    // THE FOLD: the two per-measure time inputs are gone — the sitting's one
    // shared Time is the only "when" the form asks (the time-input scan ratchet's
    // biggest single shrink, 2 → 0).
    await expect(form.locator("#m-temp-time")).toHaveCount(0);
    await expect(form.locator("#m-peak-flow-time")).toHaveCount(0);
    await expect(form.getByTestId("m-time")).toHaveCount(1);

    await settledFill(page, form.locator("#m-temperature"), "99.2");
    await settledFill(page, form.getByTestId("measurements-peak-flow"), "410");
    await hydratedClick(page, form.getByTestId("m-now"));
    const timeInput = form.getByTestId("m-time");
    await expect(timeInput).toHaveValue(/^\d{2}:\d{2}$/);
    const statedHhmm = await timeInput.inputValue();

    await settledClick(
      page,
      form.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();

    // Server truth: the ONE statement landed on BOTH stores, each on its own
    // convention — the observation's occurred_at in the canonical UTC shape, and
    // the peak-flow sample's started_at as the same instant's profile-local wall
    // clock (its natural key).
    const { zone } = pinnedTimezone(frozenNow().toISOString());
    const statedInstant = utcInstant(
      zonedWallTimeToUtc(zone, TODAY, statedHhmm)!
    );
    const handle = new Database(DB_PATH);
    try {
      const temp = handle
        .prepare(
          `SELECT occurred_at, notes FROM medical_records
            WHERE profile_id = 1 AND date = ? AND source = 'manual'
              AND canonical_name = 'Body Temperature'`
        )
        .all(TODAY) as { occurred_at: string | null; notes: string | null }[];
      expect(temp).toEqual([{ occurred_at: statedInstant, notes: null }]);
      const blow = handle
        .prepare(
          `SELECT started_at FROM metric_samples
            WHERE profile_id = 1 AND date = ? AND source = 'manual'
              AND metric = 'peak_flow_lmin'`
        )
        .all(TODAY) as { started_at: string }[];
      expect(blow).toEqual([{ started_at: `${TODAY}T${statedHhmm}:00` }]);
    } finally {
      handle.close();
    }
  } finally {
    clearTodayManualVitals();
    for (const restore of restoreSharedDay) restore();
  }
});

test("the sitting's Time (#2235): empty by default, one-tap Now, census renders it, reopening seeds it", async ({
  page,
}) => {
  test.slow();
  clearTodayManualBodyRow();
  try {
    await page.goto("/trends?view=tiles");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // Never defaults to now (#2053): the date opens on today, and the Time still
    // renders EMPTY, with the control's one-tap "Now" beside it.
    const timeInput = form.getByTestId("m-time");
    await expect(timeInput).toHaveValue("");

    // "Now" fills an ABSOLUTE local wall time the user sees and can adjust. The
    // stated value is read back from the field (the browser clock is frozen but
    // ticks), and every later assertion compares against exactly that statement.
    await hydratedClick(page, form.getByTestId("m-now"));
    await expect(timeInput).toHaveValue(/^\d{2}:\d{2}$/);
    const statedHhmm = await timeInput.inputValue();

    const weight = form.locator("#m-weight");
    await settledFill(page, weight, "71.8");
    await settledClick(
      page,
      form.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();

    // Server truth: the statement landed on today's manual row in the canonical
    // utcInstant shape — never a midnight anchor, never a re-dated row.
    const handle = new Database(DB_PATH);
    try {
      const row = handle
        .prepare(
          "SELECT occurred_at FROM body_metrics WHERE profile_id = 1 AND date = ? AND source IS NULL"
        )
        .get(TODAY) as { occurred_at: string | null } | undefined;
      expect(row?.occurred_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
      );
    } finally {
      handle.close();
    }

    // The retired Today card no longer repeats it; the census tile confirms the
    // reading landed while the DB assertion above owns its stated instant.
    await expect(page.getByTestId("body-tile-weight")).toContainText("71.8");

    // Re-opening the form for the day seeds the Time back from the row's own
    // occurred_at, so a resubmission preserves the statement unless cleared.
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    await expect(
      page.getByTestId("measurements-quick-add").getByTestId("m-time")
    ).toHaveValue(statedHhmm);
  } finally {
    clearTodayManualBodyRow();
  }
});

// #2311 — a refused stated time must not cost the reading, and must not be silent.
//
// The measurements form posts a RESOLVED INSTANT for the sitting (the WhenControl
// pair, anchored client-side on the row's own day), so unlike the food bar it is
// online-reachable: any wall time later than the server's own now — a device clock
// running fast, or a hand-typed hour — is past the five-minute skew window the
// acceptance gate tolerates. Until this shipped the weigh-in landed and the "when"
// vanished with nothing on screen saying so.
//
// DETERMINISTIC BY CONSTRUCTION, not by luck: the pinned e2e timezone puts the
// frozen clock at 13:mm LOCAL on every run (e2e/pinned-timezone.ts), so a
// late-evening wall time on today is always hours ahead and never crosses local
// midnight into the `other-day` rule. The guard below states that dependency out
// loud rather than letting a change to the pinning turn this red at 3am.
const REFUSED_HHMM = "21:45";
const REFUSED_WEIGHT = "73.6";

test("a stated time the gate refuses costs the time, not the reading — and SAYS so (#2311)", async ({
  page,
}) => {
  test.slow();
  clearTodayManualBodyRow();
  try {
    const { zone } = pinnedTimezone(frozenNow().toISOString());
    expect(frozenLocalHHMM(zone).slice(0, 2)).toBe("13");

    await page.goto("/trends?view=tiles");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    await settledFill(page, form.getByTestId("m-time"), REFUSED_HHMM);
    await settledFill(page, form.locator("#m-weight"), REFUSED_WEIGHT);
    await settledClick(
      page,
      form.getByRole("button", { name: "Save measurements" })
    );

    // THE FIX: the confirmation the user was already going to read admits what it
    // could not keep — same toast, same success tone, no second surface and no
    // inline error (the weight is sitting right there). And it names the rule that
    // fired rather than diagnosing a device whose clock the user can see.
    await expect(
      page.getByText(
        "Measurements saved without the time — that time hasn't happened yet."
      )
    ).toBeVisible();

    // The ruling's other half: the READING landed. Only the minute is gone, and the
    // row is on its own day rather than re-dated onto the refused instant's.
    const handle = new Database(DB_PATH);
    try {
      const rows = handle
        .prepare(
          `SELECT date, weight_kg, occurred_at, edited FROM body_metrics
            WHERE profile_id = 1 AND date = ? AND source IS NULL`
        )
        .all(TODAY) as {
        date: string;
        weight_kg: number | null;
        occurred_at: string | null;
        edited: number | null;
      }[];
      expect(rows).toHaveLength(1);
      // The reading is there (its canonical kg depends on the login's unit pref,
      // which this spec does not own — that it LANDED is the claim).
      expect(rows[0].weight_kg).not.toBeNull();
      expect(rows[0]).toMatchObject({
        date: TODAY,
        // Honest absence — and NOTHING persisted to chase the user later: no
        // marker, no review row, no edit flag. The Time is one tap away in the
        // same form, which is the whole reason a durable nag would be the same
        // misjudgement as the silence, pointed the other way.
        occurred_at: null,
        edited: 0,
      });
    } finally {
      handle.close();
    }

    // And the one census tile renders the reading without inventing the refused
    // clock time.
    await page.reload();
    const cell = page.getByTestId("body-tile-weight");
    await expect(cell).toBeVisible();
    await expect(cell).not.toContainText(`at ${REFUSED_HHMM}`);
  } finally {
    clearTodayManualBodyRow();
  }
});

// ── THE HOST DECLARES THE WIDTH THE GRID WAS BUILT FOR (#4977) ───────────────
//
// #2014 (above) made the grid ask its CONTAINER. The quick-entry sheet then never
// answered: it mounted every form in one `BottomSheet` with no `size`, so it took
// the default `sm` bucket and the form laid two fields a row inside a panel the
// same grid fills four-up in the Trends modal. The fix is a declared bucket on the
// host, so these assertions are about the DECLARATION and the TRACKS it produces —
// never about a class on the grid, which is the thing #2014 exists to keep out.
//
// WIDTH COMES FROM THE VIEWPORT, NEVER FROM A FORGED PANEL. A declared bucket is a
// CAP applied from the `sm` breakpoint up (OVERLAY_PANEL_MAX_WIDTH), so a `lg`
// panel is 896px wide only once the window has 896px to give it and is the window's
// own width below that. Narrowing the window is therefore the honest way to put
// this form in a narrow box, and every width below is one a real device has.
//
// THE `sm` (448px) AND `md` (672px) CAPS ARE NOT READINGS THIS HOST CAN PRODUCE,
// and they are deliberately absent rather than forged: this sheet declares `lg`, so
// a panel capped at 448 exists nowhere in the app and a test pinning one would red
// on a configuration nobody could go and look at. What the four widths below DO
// vary — and what the pair actually has to survive — is the COLUMN COUNT the
// intrinsic grid resolves to, from one track up to four.
const HOST_WIDTHS = [
  { label: "small phone", width: 320 },
  { label: "phone", width: 390 },
  { label: "large phone", width: 430 },
  { label: "tablet portrait", width: 768 },
  { label: "laptop", width: 1280 },
] as const;

/** The sheet panel that carries the declared size — the box the grid measures. */
function quickEntryPanel(page: Page): Locator {
  return page.getByTestId("quick-entry-sheet").locator("[data-sheet-panel]");
}

test("the quick-entry sheet declares `lg` for measurements and leaves its siblings alone (#4977 item 1)", async ({
  page,
}) => {
  await page.goto("/?quick=log-measurements");
  const sheet = page.getByTestId("quick-entry-sheet");
  await expect(sheet).toBeVisible();
  const form = sheet.getByTestId("measurements-quick-add");
  // WAIT FOR THE FORM, never the panel: `quick-entry-body` renders a loading
  // paragraph, and a paragraph fits any width (#3384).
  await expect(form).toBeVisible();

  // The DECISION, read off the host that made it.
  await expect(quickEntryPanel(page)).toHaveAttribute("data-size", "lg");

  // AND ITS CONSEQUENCE, which is the thing the owner saw: the Vitals group's
  // eight track-cells (seven fields, blood pressure taking two) lay out four to a
  // row, so the group is two rows rather than four. Track count and row count,
  // because "the panel is at least N px wide" would pass at every width including
  // the one that was wrong.
  await openMeasurementGroup(page, form, "vitals");
  const vitals = form.locator("#measurements-group-vitals-fields");
  const layout = await vitals.evaluate((node) => ({
    tracks: getComputedStyle(node)
      .gridTemplateColumns.split(" ")
      .filter(Boolean).length,
    rows: new Set(
      Array.from(node.children).map((cell) =>
        Math.round(cell.getBoundingClientRect().top)
      )
    ).size,
  }));
  expect(layout).toEqual({ tracks: 4, rows: 2 });

  // THE SIBLING FORMS ARE UNTOUCHED. One sheet hosts them all, so a width taken at
  // the mount would have moved every one of them; the registry declares per form.
  await page.goto("/?quick=log-food");
  await expect(
    page.getByTestId("quick-entry-sheet").getByTestId("food-log-bar")
  ).toBeVisible();
  await expect(quickEntryPanel(page)).toHaveAttribute("data-size", "sm");
});

test("blood pressure gets two tracks, so both inputs clear their own placeholders at every width a device has (#4977 item 2)", async ({
  page,
}) => {
  await page.goto("/?quick=log-measurements");
  const sheet = page.getByTestId("quick-entry-sheet");
  const form = sheet.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  await openMeasurementGroup(page, form, "vitals");

  const seen: string[] = [];
  for (const { label, width } of HOST_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // Re-read the panel after the resize rather than measuring across it: the
    // reading below has to describe one laid-out instant, not two.
    await expect(quickEntryPanel(page)).toBeVisible();

    const reading = await form.evaluate((root) => {
      const measure = (input: HTMLInputElement) => {
        const cs = getComputedStyle(input);
        // THE PLACEHOLDER'S OWN PAINTED WIDTH, in the input's own font. The
        // obvious reading — `scrollWidth <= clientWidth` on the input — is
        // VACUOUS: an empty input's scrollWidth equals its clientWidth whatever
        // the placeholder says, so it is true on the truncating tree too. Nor can
        // the usual workaround be used here (assigning the placeholder as a value
        // and re-reading), because these are `type="number"` inputs and the
        // browser rejects a text value outright. So the text is measured beside
        // the input instead, and compared to the room the input actually has.
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};letter-spacing:${cs.letterSpacing}`;
        probe.textContent = input.placeholder;
        document.body.append(probe);
        const needs = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          placeholder: input.placeholder,
          needs: Math.round(needs),
          room: Math.round(
            input.clientWidth -
              parseFloat(cs.paddingLeft) -
              parseFloat(cs.paddingRight)
          ),
        };
      };
      const cellOf = (id: string) =>
        root
          .querySelector<HTMLElement>(id)!
          .closest<HTMLElement>("div.min-w-0")!;
      const grid = root.querySelector<HTMLElement>(
        "#measurements-group-vitals-fields"
      )!;
      return {
        systolic: measure(root.querySelector<HTMLInputElement>("#m-systolic")!),
        diastolic: measure(
          root.querySelector<HTMLInputElement>("#m-diastolic")!
        ),
        trackWidths: getComputedStyle(grid)
          .gridTemplateColumns.split(" ")
          .map((track) => Math.round(parseFloat(track)))
          .filter((px) => px > 0),
        template: getComputedStyle(grid).gridTemplateColumns,
        escapes: grid.scrollWidth - grid.clientWidth,
        cellWidth: Math.round(
          cellOf("#m-systolic").getBoundingClientRect().width
        ),
        neighbourWidth: Math.round(
          cellOf("#m-resting-hr").getBoundingClientRect().width
        ),
      };
    });
    const columns = reading.trackWidths.length;
    seen.push(`${label} ${width}px: ${columns} cols [${reading.template}]`);

    // The placeholders say the words. Without this the fit assertion below is
    // satisfiable by shortening them back to "Sys" and "Dia".
    expect([
      reading.systolic.placeholder,
      reading.diastolic.placeholder,
    ]).toEqual(["Systolic", "Diastolic"]);
    for (const side of [reading.systolic, reading.diastolic]) {
      expect(
        side.room,
        `${label} (${width}px): "${side.placeholder}" needs ${side.needs}px and its box gives ${side.room}px`
      ).toBeGreaterThanOrEqual(side.needs);
    }

    // A SPAN MUST NOT COST THE ROW ITS EDGE. A grid does not clip, so a cell wider
    // than its container paints over the panel edge. This is the COARSE half of
    // the reading and it stays for that: it catches the loud failure. It does not
    // catch the quiet one below, where the grid still fits and a field inside it
    // is squeezed instead.
    expect(
      reading.escapes,
      `${label} (${width}px): the vitals grid overflows its own box by ${reading.escapes}px`
    ).toBeLessThanOrEqual(0);

    // EVERY COLUMN IS A REAL COLUMN — the assertion that actually watches the gate.
    // `auto-fit` lays EQUAL `1fr` tracks; a track the grid INVENTED to satisfy a
    // span is sized `auto` from that one cell's content, so it comes out a
    // different width from its neighbours and the next single-control field drops
    // into it. Uniform widths is that defect's absence stated positively, and it is
    // measured off the laid-out grid rather than asserted about a class. An
    // ungated `col-span-2` reds here at 320px with `168px 82px`, which an overflow
    // check cannot see (nothing overflows — a field is simply squeezed) and a
    // cell-versus-sibling ratio does not reliably catch either.
    expect(
      new Set(reading.trackWidths).size,
      `${label} (${width}px): the vitals grid laid out [${reading.template}] — an odd column out is a track a span invented`
    ).toBe(1);

    // THE RELATIONSHIP, not an absolute: the pair's cell against a one-control
    // cell in the same grid. A width bound alone passes on any panel wide enough,
    // including the wide panel the truncation survived in. Both sides of the
    // one-track case are stated, because "wider than its neighbour" is FALSE at a
    // width where every cell is the whole container — and that is correct there,
    // not a failure.
    if (columns === 1) {
      expect(
        reading.cellWidth,
        `${label} (${width}px): one column, so the pair's cell and a single-control cell are both the container`
      ).toBe(reading.neighbourWidth);
    } else {
      expect(
        reading.cellWidth,
        `${label} (${width}px): the pair's cell is ${reading.cellWidth}px beside a ${reading.neighbourWidth}px single-control cell`
      ).toBeGreaterThan(reading.neighbourWidth * 1.5);
    }
  }

  // CAN THIS SWEEP EVEN REACH THE SHAPES IT CLAIMS TO COVER? Four widths that all
  // resolved to the same column count would be one reading run four times, and it
  // would pass exactly as loudly. The layouts have to actually differ.
  expect(
    new Set(seen.map((line) => line.split(": ")[1])).size,
    seen.join("; ")
  ).toBeGreaterThanOrEqual(3);
});
