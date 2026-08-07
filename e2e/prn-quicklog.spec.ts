import { test, expect } from "./fixtures";
import { settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import {
  medicationsToday,
  prnTodayItem,
  prnAdministrations,
  prnAdministrationRows,
  medicationOverview,
  medicationGuidance,
  openMedDetailViaLink,
} from "./med-card-helpers";

// #797 PRN administration ledger: a PRN (as-needed) medication can be logged
// multiple times a day with real times, and both the Medications-page card and the
// dashboard "Log a PRN dose" widget surface the day's administrations. The seed
// (e2e/seed-events.ts) ships "PRN Quicklog Med (e2e)" — active, as_needed, with TWO
// administrations already logged earlier today.
//
// #868 hygiene: this med is a SHARED-seed row, so these specs never pin its exact
// count (a neighbor's write or a --repeat-each run bumps it); they assert the count
// PATTERN, and the log test CLEANS UP the administration it adds so the fixture returns
// to its seeded state (the seed only resets at boot). Navigations use followLink and the
// log/remove Server-Action clicks use settledClick — the blessed settled interactions.
const MED = "PRN Quicklog Med (e2e)";

// Parse "N today · last …" → N.
function parseCount(text: string | null): number {
  const m = (text ?? "").match(/(\d+)\s+today/);
  return m ? Number(m[1]) : NaN;
}

test("Today panel shows the PRN med's administrations, detail shows the ledger (#797/#817)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/medications");

  // In the #817 redesign the daily-use surface is the Today panel: a PRN med is a
  // one-tap administration row (QuickLogPrnControl), NOT a scheduled dose pill.
  const todayPanel = medicationsToday(page);
  await expect(todayPanel).toBeVisible();
  const prnRow = prnTodayItem(todayPanel, MED);
  await expect(prnRow).toBeVisible();
  await expect(prnRow.getByTestId("prn-day-label")).toContainText(
    /\d+ today .* \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  // The med's clinical-record detail page keeps the day's administration ledger
  // ("N today · last …") and never a scheduled take/skip control for a PRN med.
  const detail = await openMedDetailViaLink(page, MED);
  const admin = prnAdministrations(detail);
  await expect(admin).toBeVisible();
  await expect(admin).toContainText(/\d+ today/);
  await expect(admin).toContainText(
    /last \d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );
  // The ledger renders newest-first, and this assertion checks a PROPERTY of the
  // newest row (it carries a relative-time label) — true of ANY recent administration,
  // not an exact-row identity — so "first" here is just "newest", not "whichever row
  // a neighbor left on a shared list".
  const newestAdmin = prnAdministrationRows(admin).first(); // first-ok: newest row on a newest-first ledger; the assertion is a property of "most recent", not a row identity
  await expect(newestAdmin).toContainText(
    /\d{1,2}:\d{2}(?:am|pm)? \((?:just now|\d+ (?:mins?|hrs?) ago)\)/
  );

  const overviewBox = await medicationOverview(detail).boundingBox();
  const guidanceBox = await medicationGuidance(detail).boundingBox();
  expect(overviewBox).not.toBeNull();
  expect(guidanceBox).not.toBeNull();
  expect(Math.abs(overviewBox!.y - guidanceBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(overviewBox!.width - guidanceBox!.width)).toBeLessThanOrEqual(
    2
  );
  expect(
    Math.abs(overviewBox!.height - guidanceBox!.height)
  ).toBeLessThanOrEqual(2);
  await expect(detail.getByTestId("dose-status")).toHaveCount(0);
});

test("dashboard quick-log widget logs an administration and updates the count (#797)", async ({
  page,
}) => {
  await page.goto("/");

  // The seed leaves profile 1 with an OPEN illness episode, so the acting profile's PRN
  // quick-log lives in the illness-hero cockpit (which embeds the SAME logger). The
  // folded "Take any meds?" branch of the "How are you today?" check-in deliberately
  // steps aside while illness is active (#1221) — the cockpit is the single dashboard
  // instance of the `quick-log-prn` control, so this locator stays unambiguous. (The
  // well-day check-in meds branch is covered by e2e/dashboard-daily-loop.spec.ts.)
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();

  const item = prnTodayItem(widget, MED);
  if (!(await item.isVisible())) {
    const more = widget.getByTestId("quick-log-prn-more");
    await expect(more).toContainText(/More medications/);
    await more.locator("summary").click();
  }
  await expect(item).toBeVisible();
  const label = item.getByTestId("prn-day-label");
  const before = parseCount(await label.textContent());
  expect(before).toBeGreaterThanOrEqual(1);

  await expect(item.getByTestId("prn-log-now")).toHaveAccessibleName(
    "Taken now"
  );
  await expect(item.getByTestId("prn-log-more")).toHaveAccessibleName(
    "Earlier dose"
  );

  // One-tap "Taken now" records a fresh administration NOW → the count rises by one.
  //
  // settledClick is necessary but NOT sufficient on the dashboard: it resolves on any
  // same-origin POST, and this page fires Server Actions of its own during load, so it
  // can return before THIS log's POST has even been sent. Worse, the dashboard's route
  // prefetching aborts and retries in-flight requests under load, which can push the
  // log POST seconds past the click. The action's own unambiguous completion signal is
  // its success toast — wait for that, then read the count, so the assertion is ordered
  // behind the write instead of behind an unrelated POST.
  //
  // Both waits carry the 15s budget settledClick itself uses, not the 5s default. This
  // is the heaviest page in the app: the write round-trips through it and the count is
  // then server-rendered again by router.refresh(). Under load either step alone can
  // exceed five seconds, and a slow dashboard must read as slow — not as a lost dose.
  await settledClick(page, item.getByTestId("prn-log-now"));
  await expect(
    page.getByRole("status").filter({ hasText: `Logged ${MED}` })
  ).toBeVisible({ timeout: 15_000 });
  await expect(label).toContainText(`${before + 1} today`, { timeout: 15_000 });

  // A second tap is deduplicated SERVER-side, and says so instead of showing the same
  // success copy as a newly persisted administration. The reload is what makes the tap
  // reach the server at all: a PRN dose is additive and never confirms, but it does
  // carry the post-success cooldown (#2007 layer 1), and a fresh mount is the honest
  // way past a two-second client window without sleeping through it.
  await page.reload();
  await expect(widget).toBeVisible();
  if (!(await item.isVisible())) {
    await widget.getByTestId("quick-log-prn-more").locator("summary").click();
  }
  await expect(item.getByTestId("prn-log-now")).toBeVisible();
  await settledClick(page, item.getByTestId("prn-log-now"));
  await expect(
    page.getByRole("status").filter({
      hasText: `${MED} was already logged just now.`,
    })
  ).toBeVisible({ timeout: 15_000 });
  await expect(label).toContainText(`${before + 1} today`, { timeout: 15_000 });

  // CLEAN UP (#868): remove the administration just logged so the shared fixture returns
  // to its seeded count — otherwise a --repeat-each run accumulates doses and the dedup
  // window collapses the next log. The dashboard widget has no remove affordance, so do
  // it on the med's detail page (the most-recent row is the one logged "now").
  await page.goto("/medications");
  const detail = await openMedDetailViaLink(page, MED);
  const admin = prnAdministrations(detail);
  const rows = prnAdministrationRows(admin);
  // The ledger is newest-first and this spec just logged an administration "now"
  // (settledClick-awaited above); CI runs workers=1 (sequential), so no neighbor can
  // interleave a newer row between the log and here — the newest row is deterministically
  // this spec's own just-logged one, so removing it undoes exactly this spec's write.
  const newestRow = rows.first(); // first-ok: newest row this spec just logged "now" on a newest-first ledger, under CI's sequential workers=1
  await expect(newestRow).toBeVisible();
  await settledClick(page, newestRow.getByTestId("prn-administration-remove"));
  // Order the count read behind the remove itself, for the same reason as the log above.
  await expect(
    page.getByRole("status").filter({ hasText: "Dose removed." })
  ).toBeVisible({ timeout: 15_000 });
  // Back to the seeded count (the "Dose removed." undo toast is left to expire — the
  // removal must persist for cleanup, so we do NOT click Undo). Same 15s budget as the
  // log above: the toast confirms the write, the count additionally awaits the re-render.
  await expect(admin).toContainText(`${before} today`, { timeout: 15_000 });
});

test("the earlier-dose panel is the shared when-control: absolute time today, empty until stated (#2236)", async ({
  page,
}) => {
  await page.goto("/");
  const widget = page.getByTestId("quick-log-prn");
  await expect(widget).toBeVisible();
  const item = prnTodayItem(widget, MED);
  if (!(await item.isVisible())) {
    await widget.getByTestId("quick-log-prn-more").locator("summary").click();
  }
  await expect(item).toBeVisible();
  const label = item.getByTestId("prn-day-label");
  const before = parseCount(await label.textContent());
  expect(before).toBeGreaterThanOrEqual(1);

  await item.getByTestId("prn-log-more").click();
  const options = item.getByTestId("prn-log-options");
  await expect(options).toBeVisible();

  // Relative offsets are not offered on a rendered page (#2236 decision 5): the
  // old "30 min ago" / "1 hr ago" chips are gone — a relative label computed at
  // tap time drifts with every minute the page sits open; an absolute time can't.
  await expect(options).not.toContainText("min ago");
  await expect(options).not.toContainText("hr ago");

  // The control owns the date+time PAIR; on this surface the day is fixed to the
  // profile's today and rendered, not implied.
  await expect(options.getByTestId("prn-log-when-date")).toHaveText("Today");

  // Never defaults to now: the time renders EMPTY until stated, and the save
  // stays disabled — an unstated time is not a submittable dose here.
  const timeInput = options.getByTestId("prn-log-when-time");
  await expect(timeInput).toHaveValue("");
  await expect(options.getByTestId("prn-log-custom")).toBeDisabled();

  // The one-tap "now" fills an ABSOLUTE local wall time into the field — the
  // user sees exactly what will be stated, and can adjust it.
  await options.getByTestId("prn-log-when-now").click();
  await expect(timeInput).toHaveValue(/^\d{2}:\d{2}$/);

  // State an explicit earlier time — 30 minutes before the frozen "now", which
  // the pinned zone (local 13:mm, see e2e/pinned-timezone.ts) keeps on today and
  // clear of the seeded administrations' 120s dedup proximity (45m/90m ago).
  const { offsetHours } = pinnedTimezone(frozenNow().toISOString());
  const statedHhmm = new Date(
    frozenNow().getTime() - 30 * 60 * 1000 + offsetHours * 3600_000
  )
    .toISOString()
    .slice(11, 16);
  await timeInput.fill(statedHhmm);
  await settledClick(page, options.getByTestId("prn-log-custom"));
  await expect(
    page.getByRole("status").filter({ hasText: `Logged ${MED}` })
  ).toBeVisible({ timeout: 15_000 });
  await expect(label).toContainText(`${before + 1} today`, { timeout: 15_000 });

  // CLEAN UP (#868): the stated dose (now − 30m) is the newest administration on
  // the seeded ledger (the seeds sit 45m/90m back), so removing the newest row
  // undoes exactly this spec's write and returns the shared fixture to baseline.
  await page.goto("/medications");
  const detail = await openMedDetailViaLink(page, MED);
  const admin = prnAdministrations(detail);
  const newestRow = prnAdministrationRows(admin).first(); // first-ok: newest row on a newest-first ledger is this spec's own now−30m dose, under CI's sequential workers=1
  await expect(newestRow).toBeVisible();
  await settledClick(page, newestRow.getByTestId("prn-administration-remove"));
  await expect(
    page.getByRole("status").filter({ hasText: "Dose removed." })
  ).toBeVisible({ timeout: 15_000 });
  await expect(admin).toContainText(`${before} today`, { timeout: 15_000 });
});
