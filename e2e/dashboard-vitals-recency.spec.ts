import { test, expect } from "./fixtures";
import { type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs, openCommandPalette } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { shiftDateStr } from "@/lib/date";
import { setFixtureTimezone } from "./fixture-timezones";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import { hydratedClick, openDashboardAll, settledClick } from "./helpers";
import { dormantRecordSince } from "@/lib/domain-dormancy";

// THE LATEST-VITALS RECENCY FLOOR (issue #2303).
//
// The card had no date bound of any kind, so a profile's newest blood pressure rendered
// as a headline number with a trend arrow at ANY age — and because the tail is the last
// two readings by position, a single clinic visit's three sequential cuff readings
// produced an arrow claiming "up versus previous blood pressure" between reading #3 and
// reading #2 of one measurement. Beside a resting HR from yesterday, in identical
// typography, the whole card read as a snapshot of "my vitals now".
//
// The seeded shape here is exactly that: one visit's three same-day cuff readings, years
// old, plus a fresh resting HR. The assertions are what the card CLAIMS — the values
// themselves must still be on screen, because the fix is never to hide them.
//
// Fixture-OWNED (#868): its own login and profile, created and destroyed by the spec, so
// nothing depends on the shared seed and a --repeat-each run can't collide.
//
// The same fixture also carries one years-old LAB reading, because #2332 is about the
// two glance cards SIDE BY SIDE: they sit on one dashboard, mean the same thing by an
// age label, and used to say it two ways. Both now read one decision (lib/glance-age),
// and the assertions below check the pair rather than each card alone — which is the
// review the two cards never got.
//
// ── AND WHERE THAT TREATMENT STOPS (issue #3226) ────────────────────────────────────
//
// The age label is honest but it is PERMANENTLY amber: a reading that stopped arriving
// years ago can never improve on its own, and a number in that state, read daily, turns
// into wallpaper. So past a YEAR the row stops rendering a value at all and states the
// gap instead — the dormant line #3077's three-state doctrine calls for.
//
// The two spans are tested separately below because the whole point is that they are
// different spans, and each one's test would pass under the other's implementation if
// they shared a fixture age:
//   • BP_STALE_DAYS — past the 180-day floor, inside the year. The #2303 treatment, and
//     the reason this is not "collapse anything old".
//   • BP_DORMANT_DAYS — the owner's real shape, a cuff reading four and a half years
//     back. The dormant line, with the resting HR beside it untouched.
//
// The dormant test does NOT stop at the absence of the number: it logs a blood pressure
// through the real quick-entry form and watches the row come back as a value. That is
// what makes the absence assertion mean something — the same selector that must find
// nothing while the domain is quiet has to find the value once it is not.

const DB_PATH = workerDbPath();
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;
const TODAY = frozenNow().toISOString().slice(0, 10);
const day = (back: number) => shiftDateStr(TODAY, -back);

// A CURRENT reading's provenance line never prints the stored day (#3492). The fresh
// readings below are all seeded today or yesterday, so since #4757 they read as a word;
// each is still paired with `not.toHaveText(MACHINE_DATE)`, the half that would catch
// the ISO fallback coming back.
const MACHINE_DATE = /\d{4}-\d{2}-\d{2}/;

// Past the blood-pressure presentation floor (180 days) and comfortably INSIDE the year
// at which the row goes dormant: the span the age label owns, and the one #2303 is about.
const BP_STALE_DAYS = 300;

// Deep enough that the relative label rounds to whole years — the reported card's blood
// pressure was four and a half years old. Past the year floor, so this is the dormant
// shape rather than the amber one.
const BP_DORMANT_DAYS = 1600;

// The lab reading is always seeded at the deep age, in BOTH fixtures: its own floor is a
// year (RECENT_LAB_STALE_DAYS), so it is the stale-labelled card #2332 pairs with
// regardless of what the blood pressure is doing.
const LAB_DAYS_AGO = 1600;

interface VitalsFixture {
  username: string;
  loginId: number;
  profileId: number;
}

function createVitalsFixture(
  testInfo: TestInfo,
  { bpDaysAgo, tag }: { bpDaysAgo: number; tag: string }
): VitalsFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${tag}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_vitals_age_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_DAILY) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Vitals age ${suffix}`);
        loginId = Number(
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
        // Pin the profile's timezone to the run's, so the seeded days are the days the
        // card ages against.
        setFixtureTimezone(handle, profileId, "vitals-recency", TZ);

        // One visit, three sequential cuff readings on ONE day. SYNTHETIC values.
        const bp = handle.prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num)
           VALUES (?, ?, 'vitals', ?, ?, 'mmHg', ?, ?)`
        );
        for (const [sys, dia] of [
          [126, 82],
          [124, 80],
          [128, 84],
        ] as const) {
          const visit = day(bpDaysAgo);
          bp.run(
            profileId,
            visit,
            "Blood Pressure Systolic",
            String(sys),
            "Blood Pressure Systolic",
            sys
          );
          bp.run(
            profileId,
            visit,
            "Blood Pressure Diastolic",
            String(dia),
            "Blood Pressure Diastolic",
            dia
          );
        }

        // One lab result, as old as the blood pressure, so the Recent labs card on the
        // same dashboard has a stale row of its own. SYNTHETIC value.
        handle
          .prepare(
            `INSERT INTO medical_records
               (profile_id, date, category, name, value, unit, canonical_name, value_num)
             VALUES (?, ?, 'lab', 'LDL Cholesterol', '118', 'mg/dL',
                     'LDL Cholesterol', 118)`
          )
          .run(profileId, day(LAB_DAYS_AGO));

        // A resting HR from yesterday, with a prior reading on a DIFFERENT day so it
        // legitimately carries a direction.
        const hr = handle.prepare(
          `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
           VALUES (?, ?, ?, 'manual')`
        );
        hr.run(profileId, day(4), 59);
        hr.run(profileId, day(1), 61);
      })
      .immediate();
    return { username, loginId, profileId };
  } finally {
    handle.close();
  }
}

function destroyVitalsFixture(fixture: VitalsFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare("DELETE FROM sessions WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_profiles WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_settings WHERE login_id = ?")
          .run(fixture.loginId);
        handle.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
        handle
          .prepare("DELETE FROM medical_records WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM body_metrics WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM profile_settings WHERE profile_id = ?")
          .run(fixture.profileId);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

test("a months-old blood pressure is age-labeled and loses its arrow, while yesterday's resting HR is untouched", async ({
  browser,
}, testInfo) => {
  const fixture = createVitalsFixture(testInfo, {
    bpDaysAgo: BP_STALE_DAYS,
    tag: "stale",
  });
  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    await openDashboardAll(page);
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    const hrCandidate = dashboardCandidatePrefix(
      page,
      "vitals.resting-heart-rate:"
    );
    await expect(bpCandidate).toBeVisible();
    await expect(hrCandidate).toBeVisible();

    const bp = bpCandidate.getByTestId("vitals-latest-bp");
    // The VALUE stays — the newest of the visit's three readings, at full prominence.
    await expect(bp).toContainText("128/84");
    // ...and the raw ISO date is replaced by an age that reads as an age, amber, with a
    // disclosure explaining the tint (the treatment #1216 established on Recent labs).
    const bpAge = bpCandidate.getByTestId("vitals-latest-bp-age");
    await expect(bpAge).toHaveText("10 months ago");
    await expect(bpAge).toHaveAttribute("data-stale", "true");
    const bpAgeDetails = bpCandidate.getByRole("button", {
      name: "Older than six months — still your latest reading, but not a current one",
    });
    await bpAgeDetails.click();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Older than six months — still your latest reading, but not a current one"
    );
    // No arrow: the direction it used to claim was between two readings of one sitting.
    await expect(bp).not.toContainText("versus previous blood pressure");
    // Still a READING, not a dormant line: inside the year floor the value stays, which
    // is the boundary #3226 was careful not to move (#2303 stands).
    await expect(bpCandidate).toHaveAttribute("data-presence", "current");

    // The fresh row is unaffected: no tint, its arrow intact, and — seeded yesterday —
    // its day said in a word rather than a calendar date (#4757).
    const hr = hrCandidate.getByTestId("vitals-latest-resting-hr");
    await expect(hr).toContainText("61");
    const hrAge = hrCandidate.getByTestId("vitals-latest-resting-hr-age");
    await expect(hrAge).toHaveText("yesterday");
    await expect(hrAge).not.toHaveText(MACHINE_DATE);
    await expect(hrAge).not.toHaveAttribute("data-stale", "true");
    await expect(hr).toContainText("up versus previous resting heart rate");

    // #4841 item 4 (owner ruling 2026-09-03 12:25 UTC): the vitals family carries
    // ONE "Log a vital" door, not one per row — #4826 gated each row's door on
    // ITS OWN staleness, so this fixture (a stale BP beside a fresh, untouched
    // resting HR) used to grow a door on the BP row alone by accident of age
    // rather than by design. Both directions are asserted on the SAME pair of
    // locators the rest of this test already uses, so this cannot pass on a page
    // that lost the door everywhere: it seats on blood pressure, first in the
    // family's declared order, and the resting-HR row — fresh, not stale, and so
    // never eligible under the old per-row rule either — carries none.
    await expect(
      bpCandidate.getByRole("button", { name: "Log a vital" })
    ).toHaveCount(1);
    await expect(
      hrCandidate.getByRole("button", { name: "Log a vital" })
    ).toHaveCount(0);
    // The bootstrap Setup door retires once the family has any reading, even a
    // stale one (2026-09-02 report folded into item 4): the family's own door
    // above is this profile's one way in now.
    await expect(
      page.locator('[data-candidate-id="vitals.bootstrap"]')
    ).toHaveCount(0);

    // Nothing is hidden and nothing is emptied: the header still says "Latest vitals"
    // (latest is a fact; current was the claim removed) and the write that ends the
    // dormancy is still one gesture away. #3366 moved that gesture off the card and
    // into the app's one quick-write surface, so both halves are asserted: no write
    // control on the card, and the palette's own "Log vitals" door still there.
    await expect(
      dashboardCandidatePrefix(page, "vitals.manual-log")
    ).toHaveCount(0);
    await expect(page.getByTestId("vitals-log-reading")).toHaveCount(0);
    const paletteInput = await openCommandPalette(page);
    await paletteInput.fill("log vitals");
    await expect(page.getByTestId("palette-action-log-vitals")).toBeVisible();
    await page.keyboard.press("Escape");

    // #2332: the other glance card on the same dashboard, saying the same thing the
    // same way. Its column is narrow, so the age is compact rather than spelled out —
    // that is the one thing the surface declares — but the amber, the data-stale hook
    // and the hover SENTENCE are the shared decision, naming this card's own floor.
    // A quiet clinical result sits in the page's one fold (#4232); the row, its age
    // token and its hover sentence are unchanged inside it.
    await openDashboardAll(page);
    const labs = dashboardCandidatePrefix(page, "labs.latest:").filter({
      hasText: "LDL Cholesterol",
    });
    await expect(labs).toBeVisible();
    const labAge = labs.getByTestId("recent-lab-date");
    await expect(labAge).toHaveText("4y");
    await expect(labAge).toHaveAttribute("data-stale", "true");
    const labAgeDetails = labs.getByRole("button", {
      name: "Older than a year — still your latest reading, but not a current one",
    });
    await labAgeDetails.click();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Older than a year — still your latest reading, but not a current one"
    );
    // The value is not hidden here either — the fix is what the card claims.
    await expect(labs).toContainText("118");
  } finally {
    await page.context().close();
    destroyVitalsFixture(fixture);
  }
});

test("a blood pressure past the year floor states its gap instead of a number, the resting HR beside it is untouched, and one logged reading brings the value back", async ({
  browser,
}, testInfo) => {
  const fixture = createVitalsFixture(testInfo, {
    bpDaysAgo: BP_DORMANT_DAYS,
    tag: "dormant",
  });
  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    await openDashboardAll(page);
    // #3548 narrowed #3226 exactly this far and #4232 moved where the fold is: the
    // dormant row keeps its existence, its copy and its affordance and loses the
    // always-visible slot, so it sits in the page's one fold — already opened above.
    // After the reading is logged the row is `current` again and back in the stable
    // rest, which is why the post-reload half does not reopen anything.
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    const hrCandidate = dashboardCandidatePrefix(
      page,
      "vitals.resting-heart-rate:"
    );
    await expect(bpCandidate).toBeVisible();

    // THE ROW IS DORMANT, and it says so structurally — the three-state field the whole
    // dashboard reads, not a class name or a colour.
    await expect(bpCandidate).toHaveAttribute("data-presence", "dormant");

    // The SENTENCE is the dormancy substrate's, rendered for THIS row's source date.
    // Built from `dormantRecordSince` rather than typed out here: a hand-copied clause
    // would keep passing after the substrate's own copy changed underneath it, and the
    // wording itself is pinned in the pure tier. What this asserts is that the row shows
    // that domain's statement, dated by the reading actually seeded above.
    const statement = dormantRecordSince(
      "blood-pressure",
      day(BP_DORMANT_DAYS)
    );
    expect(statement).not.toBeNull();
    await expect(bpCandidate).toContainText(statement!);
    // …and the statement genuinely CARRIES a date. Asserting the substrate's output
    // alone cannot see a mutant that drops the date from every line at once — the
    // expectation would move with it — so the seeded year is checked on its own.
    await expect(bpCandidate).toContainText(day(BP_DORMANT_DAYS).slice(0, 4));

    // The number is retired, not merely re-styled. (This absence is only worth
    // asserting because the same locator is required to find the value further down,
    // once a reading exists.)
    await expect(bpCandidate.getByTestId("vitals-latest-bp")).toHaveCount(0);
    await expect(bpCandidate).not.toContainText("128/84");

    // REACH IS UNCHANGED — the dormant line is still one tap from the vitals history.
    await expect(bpCandidate.getByRole("link")).toHaveAttribute(
      "href",
      "/trends#body"
    );

    // PER MEMBER, NOT PER FAMILY: the neighbour is a live row with its value, its plain
    // date and its arrow. A family-level collapse would have taken this with it.
    await expect(hrCandidate).toBeVisible();
    await expect(hrCandidate).toHaveAttribute("data-presence", "current");
    const hr = hrCandidate.getByTestId("vitals-latest-resting-hr");
    await expect(hr).toContainText("61");
    const hrAgeToken = hrCandidate.getByTestId("vitals-latest-resting-hr-age");
    await expect(hrAgeToken).toHaveText("yesterday");
    await expect(hrAgeToken).not.toHaveText(MACHINE_DATE);
    await expect(hr).toContainText("up versus previous resting heart rate");

    // #4841 item 4: WITH BLOOD PRESSURE DORMANT (no seat in Standing to carry the
    // family's door — its own separate door is the dormant line's, asserted
    // below), the family's ONE "Log a vital" door seats on the resting-HR row
    // instead — live, and not itself stale, which is the "present whenever the
    // family exists, fresh or stale" half of the ruling: this row would have
    // carried no control at all under #4826's per-row rule.
    await expect(
      hrCandidate.getByRole("button", { name: "Log a vital" })
    ).toHaveCount(1);

    // The write that ends the dormancy is still one gesture from the row (#1892),
    // through the quick-write surface it moved to in #3366 rather than a card of its
    // own. The card itself no longer carries one — asserted here so this cannot pass
    // on a tree where the write disappeared instead of moving.
    await expect(
      dashboardCandidatePrefix(page, "vitals.manual-log")
    ).toHaveCount(0);

    // ── One logged reading, through the real form ──────────────────────────────────
    const input = await openCommandPalette(page);
    await input.fill("log vitals");
    await page.getByTestId("palette-action-log-vitals").click();
    const body = page.getByTestId("quick-entry-body");
    await expect(body).toHaveAttribute("data-form", "measurements");
    const form = body.getByTestId("measurements-quick-add");
    // The action opens the form ON the vitals group (#2014), resolved at the form's
    // FIRST render rather than in an effect — so the fields are already disclosed and
    // there is nothing to toggle. Reaching for `openMeasurementGroup` here is what a
    // reader expects to see, and it is wrong: its visibility probe can lose the race
    // with the modal's mount, and the click it then makes CLOSES the group it was
    // meant to open. Asserting the disclosure instead also pins the deep link itself.
    await expect(
      form.locator("#measurements-group-vitals-fields")
    ).toBeVisible();
    await body.locator("#m-systolic").fill("117");
    await body.locator("#m-diastolic").fill("74");
    await settledClick(
      page,
      body.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();

    // …and on the next render the row is a VALUE again. Nothing had to be dismissed:
    // dormancy is a statement about the record, so a new record ends it.
    await page.reload();
    await openDashboardAll(page);
    await expect(bpCandidate).toHaveAttribute("data-presence", "current");
    await expect(bpCandidate.getByTestId("vitals-latest-bp")).toContainText(
      "117/74"
    );
    await expect(bpCandidate).not.toContainText(statement!);
    // Today's reading is inside the floor, so it says so in a word rather than an
    // amber age — the row is all the way back, not merely un-collapsed.
    const bpAge = bpCandidate.getByTestId("vitals-latest-bp-age");
    await expect(bpAge).toHaveText("today");
    await expect(bpAge).not.toHaveText(MACHINE_DATE);
    await expect(bpAge).not.toHaveAttribute("data-stale", "true");
  } finally {
    await page.context().close();
    destroyVitalsFixture(fixture);
  }
});
// #4841 item 3 — THE DORMANT LINE IS AN ACT, AND ITS DOOR IS THE MEASUREMENT.
//
// "No blood pressure recorded since Mar 2022" is a prompt to take a reading. It sat
// under READ, filed as a report, and the only thing it opened was the history of the
// reading it says is missing — a door that cannot end the state the line describes.
//
// At 390px because the door is the whole of what a phone reader gets: the row has no
// hover, so what it opens is what it is.
test("the dormant blood-pressure line acts, and its control opens the vitals form", async ({
  browser,
}, testInfo) => {
  const fixture = createVitalsFixture(testInfo, {
    bpDaysAgo: BP_DORMANT_DAYS,
    tag: "dormant-act",
  });
  const page = await loginAs(
    browser,
    { username: fixture.username, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    await openDashboardAll(page);
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    // Still the dormant line #3226 wrote — the presence and the sentence are what
    // this issue leaves alone.
    await expect(bpCandidate).toHaveAttribute("data-presence", "dormant");

    // WHERE IT SITS. Both directions, because the group is a partition: naming Act
    // alone would pass on a tree that drew the row in both.
    await expect(
      page
        .getByTestId("dashboard-everything-act")
        .locator('[data-candidate-id="vitals.blood-pressure:dormant"]')
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("dashboard-everything-read")
        .locator('[data-candidate-id="vitals.blood-pressure:dormant"]')
    ).toHaveCount(0);

    // The family's door is unchanged — the history is still one tap away, as the
    // row's own words rather than as its only affordance.
    await expect(
      bpCandidate.getByRole("link", { name: "Vitals history" })
    ).toHaveAttribute("href", "/trends#body");

    // AND THE DOOR THAT CAN END THE DORMANCY. The row's control opens the app's one
    // quick-write surface on the vitals group — the same form, disclosed at first
    // render, that the palette route in the previous test opens.
    //
    // `hydratedClick`, not `settledClick`: opening the overlay is a pure client
    // toggle and posts nothing, so the Server-Action wait would time out on a
    // working control.
    await hydratedClick(
      page,
      bpCandidate.getByTestId("dashboard-quick-entry-action")
    );
    const body = page.getByTestId("quick-entry-body");
    await expect(body).toHaveAttribute("data-form", "measurements");
    await expect(
      body
        .getByTestId("measurements-quick-add")
        .locator("#measurements-group-vitals-fields")
    ).toBeVisible();
  } finally {
    await page.context().close();
    destroyVitalsFixture(fixture);
  }
});

// #4841 item 4 — THE DOOR NEEDS NO STALENESS AT ALL.
//
// The two tests above both happen to carry one aged row, so a door that reappeared
// only because #4826's OWN per-row gate still fired on it would slip past them.
// This fixture is neither: a blood pressure from yesterday beside a resting HR from
// yesterday, both inside every floor there is. The owner's ruling is "present
// whenever the family exists" — not "whenever a member is stale" — and this is the
// one shape that tells the two apart.
test("the vitals family's door is present with no stale reading in sight", async ({
  browser,
}, testInfo) => {
  const fixture = createVitalsFixture(testInfo, {
    bpDaysAgo: 1,
    tag: "both-fresh",
  });
  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    await openDashboardAll(page);
    const bpCandidate = dashboardCandidatePrefix(
      page,
      "vitals.blood-pressure:"
    );
    const hrCandidate = dashboardCandidatePrefix(
      page,
      "vitals.resting-heart-rate:"
    );
    await expect(
      bpCandidate.getByTestId("vitals-latest-bp-age")
    ).not.toHaveAttribute("data-stale", "true");
    await expect(
      hrCandidate.getByTestId("vitals-latest-resting-hr-age")
    ).not.toHaveAttribute("data-stale", "true");

    // ONE door despite NEITHER row being stale — the fold's core claim.
    await expect(
      bpCandidate.getByRole("button", { name: "Log a vital" })
    ).toHaveCount(1);
    await expect(
      hrCandidate.getByRole("button", { name: "Log a vital" })
    ).toHaveCount(0);
  } finally {
    await page.context().close();
    destroyVitalsFixture(fixture);
  }
});
