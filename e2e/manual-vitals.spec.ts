import { test, expect } from "./fixtures";
import { type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, openMeasurementGroup } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_TRENDS_BODY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";
import { utcInstant } from "@/lib/date";

// TODAY'S SLEEP NIGHT ON THE SHARED PROFILE BELONGS TO e2e/sleep-page.spec.ts.
//
// That spec asserts the seeded 5h synced night as the last-night hero, and says at its
// own top that it "drives no writes on the shared profile-1 session, so it can't disturb
// neighbors". Two tests in THIS file used to write today's sleep on that same profile —
// one a 7.5-hour duration, one a 23:15 → 07:05 window — so whichever ran first in a
// worker decided what the hero read. They never shared a worker until #5017 re-balanced
// the shard split, and then main went red at `sleep-page.spec.ts:234` with the hero
// showing "7h 30m" and "7h 50m" — this file's two numbers, exactly.
//
// The shared-profile guard in e2e/fixtures.ts did not catch it: it watches the
// `activities` table and a `metric_samples` row is outside it.
//
// So neither of those writes lands on today's shared night any more. The duration one
// moves to a date nothing asserts; the bed/wake one takes a profile of its own, which
// also turns its control from "whatever the seed put there" into a row it seeds itself.
const DB_PATH = workerDbPath();
const dayBefore = (days: number) =>
  new Date(frozenNow().getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * A login and profile of this test's own, carrying the SAME synced 5h night for today
 * that the shared seed carries — the control the bed/wake test needs, stated here
 * instead of borrowed.
 */
function createVitalsSleepFixture(testInfo: TestInfo): {
  username: string;
  today: string;
} {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const today = dayBefore(0);
    const suffix = `vitals-sleep-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `${E2E_LOGIN_TRENDS_BODY}_${suffix}`;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_TRENDS_BODY) as { password_hash: string }
        ).password_hash;
        const profileId = createFixtureProfile(
          handle,
          `Vitals Sleep (e2e) ${suffix}`
        );
        const loginId = Number(
          handle
            .prepare(
              "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
            )
            .run(username, passwordHash).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO login_profiles (login_id, profile_id, access)
             VALUES (?, ?, 'write')`
          )
          .run(loginId, profileId);
        // The night the typed window has to win: synced, 5h, 23:00 -> 04:00 today.
        // Built from the wake day's UTC midnight rather than interpolated, so these are
        // real instants in the canonical shape and not a `${date}T...` string standing
        // in for one (lib/__tests__/e2e-fixture-time.test.ts).
        const [y, m, d] = today.split("-").map(Number);
        const midnightMs = Date.UTC(y, m - 1, d);
        handle
          .prepare(
            `INSERT INTO metric_samples
               (profile_id, source, metric, date, started_at, ended_at, value)
             VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 300)`
          )
          .run(
            profileId,
            today,
            utcInstant(new Date(midnightMs - 60 * 60_000)),
            utcInstant(new Date(midnightMs + 4 * 60 * 60_000))
          );
      })
      .immediate();
    return { username, today };
  } finally {
    handle.close();
  }
}

// #16: manual vitals entry — the measures that previously could ONLY arrive via the
// Health Connect exporter (blood pressure, glucose, SpO2, temperature, sleep, HRV)
// are enterable by hand and write to the SAME tables/keys the integration uses.
//
// Re-pointed by #1486: the Vitals tab merged into Body, and the body + vitals
// quick-adds merged into ONE "Log measurements" form behind a desktop "+ Log"
// modal. Same write cores, same canonical rows — one door instead of
// three. (This project runs at desktop width; the phone's path is the #1468
// overlay, covered by e2e/trends-body-merge.mobile.spec.ts.)
async function openMeasurementsForm(page: Page) {
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  return form;
}

test("logging vitals persists and renders alongside synced readings (#16)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  // A distinctive-but-synthetic set: BP pair + SpO2 + sleep. The sitting is dated three
  // days back rather than today: the property under test is that the form's fields write
  // to the same tables the integration uses, which no date changes, and today's sleep
  // night on this shared profile is the last-night hero e2e/sleep-page.spec.ts asserts
  // (see the note at the top of this file). Every assertion below either widens its
  // window explicitly or reads a surface whose default window reaches three days back.
  await form.getByTestId("m-date").fill(dayBefore(3));
  // This entry point (Trends → Overview → body census) opens the BODY group, so Vitals and Sleep are
  // opened explicitly — and a blood pressure is now ONE field with two inputs
  // (#2014), each named by the number it takes rather than by a title carrying two
  // parentheticals.
  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByLabel("Oxygen Saturation", { exact: true }).fill("97");
  await openMeasurementGroup(page, form, "sleep");
  await form.getByLabel("Sleep", { exact: true }).fill("7.5");

  await form.getByRole("button", { name: "Save measurements" }).click();

  // End-to-end confirmation the server action wrote without error.
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading surfaces in the body census VITALS section (#1076/#1486),
  // widened so today's entry is in range regardless of the default window.
  await page.goto("/trends?view=all&from=2000-01-01&to=2100-01-01");
  const body = page.getByTestId("trends-body");
  await expect(body.getByTestId("vitals-systolic")).toBeVisible();
  await expect(body.getByTestId("vitals-spo2")).toBeVisible();

  // The sleep sample surfaces in the body census nightly-duration chart; detailed
  // regularity and stage analysis stays on the dedicated /sleep page (#1066).
  await page.goto("/trends?view=all");
  const sleep = page.getByTestId("sleep-summary-tile");
  await expect(sleep).toBeVisible();
  await expect(sleep.getByRole("application")).toBeVisible();

  // The clinical results catalog renders as the collapsed panel index.
  await page.goto("/results");
  const clinicalResults = page.getByTestId("results-clinical-results");
  await expect(
    clinicalResults.getByTestId("clinical-results-table")
  ).toBeVisible();
});

// #843 (door B): the measurements form carries an optional temperature reading time
// (#800 specced timed readings; it previously had none), so a manual temperature can
// build the same fever curve a synced thermometer does. Drive a timed reading and
// confirm it persisted without error.
//
// The TIME half moved (#2154): the temperature's own time input folded into the
// form's ONE shared WhenControl Time for the whole sitting, whose statement the
// write boundary lands on the reading's `occurred_at`. The property under test is
// unchanged — a manual temperature still carries the reading time that makes a
// fever curve possible — so this drives the control that now states it.
test("the measurements form logs a temperature with an optional reading time (#843)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  // Pin °F explicitly — the entry unit now defaults to the login's temperature
  // preference (#857); this reading is entered in Fahrenheit.
  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Body Temperature unit").selectOption("F");
  await form.getByLabel("Body Temperature", { exact: true }).fill("101.2");
  const timeField = form.getByTestId("m-time");
  await expect(timeField).toBeVisible();
  await timeField.fill("07:00");

  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The reading joins the Body Temperature acute view in the body census vitals
  // section (#1076/#1486): recent-readings grammar with a fever line, not a lab
  // trajectory.
  await page.goto("/trends?view=all&from=2000-01-01&to=2100-01-01");
  await expect(
    page.getByTestId("trends-body").getByTestId("vitals-temperature")
  ).toBeVisible();
});

// #1851: three measures that were charted, imported and consumed downstream but
// had no field. This drives the REAL form — the field names it posts are the
// names the Server Action reads, and nothing but an end-to-end save can tell you
// they still agree — then reads each value back off the metric's own detail page,
// which renders from the stored row.
test("the measurements form takes water, lean/bone mass and respiratory rate (#1851)", async ({
  page,
}) => {
  const form = await openMeasurementsForm(page);

  await openMeasurementGroup(page, form, "vitals");
  await form.getByLabel("Respiratory Rate", { exact: true }).fill("22");
  await openMeasurementGroup(page, form, "body");
  await form.getByLabel("Water today", { exact: true }).fill("2.4");
  await form.getByLabel("Lean Body Mass unit").selectOption("kg");
  await form.getByLabel("Lean Body Mass", { exact: true }).fill("56.4");
  await form.getByLabel("Bone Mass unit").selectOption("kg");
  await form.getByLabel("Bone Mass", { exact: true }).fill("2.9");

  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // Each value on its own detail page's readings table — the surface that renders
  // the STORED row, so a field that appears and writes nothing fails here. The
  // seed carries no reading of any of these, so the row count is the control: one
  // row, the one just typed.
  for (const [slug, shown] of [
    ["respiratory-rate", "22"],
    ["hydration", "2.4"],
    ["lean-mass", "56.4"],
    ["bone-mass", "2.9"],
  ] as const) {
    await page.goto(`/trends/metric/${slug}?from=2000-01-01&to=2100-01-01`);
    const rows = page.getByTestId("metric-readings-table").locator("tbody tr");
    // The slug is in the message because the four share one loop and one line: a
    // bare "expected 1, received 0" here names no metric, and the whole point of
    // the loop is that each of the four can fail on its own.
    await expect(rows, slug).toHaveCount(1);
    await expect(rows, slug).toContainText(shown);
  }
});

// #1851, the sleep half: the bed/wake pair. The whole reason it exists is that the
// Sleep Regularity Index needs two clocks and a duration cannot give it any, so this
// drives the real form and then reads the night back off the SLEEP LOG — the surface
// that renders the stored window, where a field posting under a name nothing reads
// would show a duration with no clocks beside it.
test("the measurements form takes a bed and wake time (#1851)", async ({
  browser,
}, testInfo) => {
  // Its OWN login and profile, seeded with the synced 5h night this test has to beat.
  // On the shared profile that night is the last-night hero another spec asserts, and
  // beating it there is what turned main red (see the note at the top of this file).
  const fixture = createVitalsSleepFixture(testInfo);
  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  const form = await openMeasurementsForm(page);
  // The date the form itself will post, so the log row below is addressed exactly
  // rather than by position.
  const date = await form.locator('input[name="date"]').inputValue();
  expect(date).toBe(fixture.today);
  await openMeasurementGroup(page, form, "sleep");
  await form.getByLabel("Bed time", { exact: true }).fill("23:15");
  await form.getByLabel("Wake time", { exact: true }).fill("07:05");
  await form.getByRole("button", { name: "Save measurements" }).click();
  await expect(page.getByText("Measurements saved")).toBeVisible();

  // The log's own row for today, not the page — scoping to the row is what keeps this
  // an assertion about THIS night. The fixture carries a SYNCED 5h night for today,
  // which makes the row a real control: the typed window has to win that night
  // (per-night resolution, manual first in SOURCE_PREFERENCE) for "7h 50m" to appear
  // at all.
  //
  // MUTATION: drop `bedTime`/`wakeTime` from the action's payload. Measured — the row
  // falls back to the synced night and names itself in the failure:
  //   unexpected value "Aug 30Sunday, August 305hBedtime · 1/1 taken…Naps13:00 → 13:45 · 45m…"
  await page.goto("/sleep");
  const row = page.locator(
    `[data-testid="sleep-mood-history-row"][data-date="${date}"]`
  );
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("7h 50m");
  await page.context().close();
});
