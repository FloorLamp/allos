import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import sharp from "sharp";
import { capturePhotoFile, settledClick } from "./helpers";
import { E2E_LOGIN_ENDURANCE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { frozenNow } from "./worker-env";

// Endurance event plans on the Training overview (issue #839): create a race plan and the
// Event-plans bar renders the recomputed this-week trajectory (target vs actual volume +
// long session), driven by the fixture profile's seeded run history.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_ENDURANCE in its OWN cookie
// context on a dedicated adult profile (seeded with a few weeks of runs, NO plan row). The
// spec OWNS the endurance_plans lifecycle — clearPlans() deletes every plan card beforeAll
// AND afterAll (and again at the top of the test body, so --repeat-each is self-contained).
// Every interaction settles via settledClick (the awaited Server-Action POST) — no
// networkidle / waitForTimeout.

// A future event date (~16 weeks out) as YYYY-MM-DD, so the plan is comfortably feasible.
function futureEventDate(): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() + 112);
  return d.toISOString().slice(0, 10);
}

// Race day, for the event-page test: the seed logs a race-labelled run on the
// fixture's TODAY (e2e/seed/training.ts), and the pinned timezone keeps the
// profile-local day equal to the frozen clock's UTC day.
function todayEventDate(): string {
  return frozenNow().toISOString().slice(0, 10);
}

// Delete every endurance plan card, asserting the count drops each time so a re-render
// never lets a detaching button get re-clicked (the #868 settled-interaction rule).
async function clearPlans(page: Page): Promise<void> {
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("endurance-plan-bar")).toBeVisible();
  const cards = page.getByTestId("endurance-plan-card");
  let n = await cards.count();
  while (n > 0) {
    await settledClick(
      page,
      page.getByRole("button", { name: /^Delete / }).first() // first-ok: deletes the endurance plan THIS spec created
    );
    await expect(cards).toHaveCount(n - 1);
    n--;
  }
}

test.describe("endurance event plans (#839)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_ENDURANCE,
      password: E2E_MEMBER_PASSWORD,
    });
    await clearPlans(page);
  });

  test.afterAll(async () => {
    await clearPlans(page);
    await page.close();
  });

  test("create a plan → overview card shows target vs actual", async () => {
    test.slow(); // local `next dev` compiles /training on first hit
    // Self-contained under --repeat-each: start from a clean slate.
    await clearPlans(page);

    const bar = page.getByTestId("endurance-plan-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("endurance-plan-card")).toHaveCount(0);

    // Open the add form and fill a 10 km run plan.
    await page.getByTestId("endurance-add-toggle").click();
    const form = page.getByTestId("endurance-form");
    await expect(form).toBeVisible();
    await page.getByTestId("endurance-event-name").fill("E2E 10k");
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await page.getByTestId("endurance-distance").fill("10");
    await settledClick(page, page.getByTestId("endurance-submit"));

    // The plan card renders with its title, the target-vs-actual line, and the honest
    // feasibility message.
    const card = page.getByTestId("endurance-plan-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("endurance-plan-title")).toHaveText(
      "E2E 10k"
    );
    await expect(card.getByTestId("endurance-plan-target")).toContainText(
      /target/i
    );
    await expect(card.getByTestId("endurance-plan-message")).toContainText(
      /week/i
    );

    // A second active run plan is refused (one active plan per discipline).
    await page.getByTestId("endurance-add-toggle").click();
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await page.getByTestId("endurance-distance").fill("21.1");
    await settledClick(page, page.getByTestId("endurance-submit"));
    // Still exactly one card — the duplicate was rejected.
    await expect(page.getByTestId("endurance-plan-card")).toHaveCount(1);

    // #1019: the Upcoming event item formats its distance per the login's
    // distanceUnit pref — a miles login sees "6.21 mi", not a hardcoded km.
    // This login owns its own dedicated prefs; restore km before the test ends
    // so --repeat-each starts from the same state.
    try {
      await page.goto("/settings/display");
      const distanceSelect = page.getByTestId("distance-unit-select");
      await distanceSelect.selectOption("mi");
      await expect(page.getByLabel("Saved")).toBeVisible();
      await page.goto("/upcoming");
      const eventItem = page
        .locator('[data-testid^="upcoming-item-endurance-event:"]')
        .first(); // first-ok: the endurance-event upcoming item from the plan THIS spec created
      await expect(eventItem).toBeVisible();
      await expect(eventItem).toContainText("6.21 mi");
      await expect(eventItem).not.toContainText("10 km");
    } finally {
      await page.goto("/settings/display");
      await page.getByTestId("distance-unit-select").selectOption("km");
      await expect(page.getByLabel("Saved")).toBeVisible();
    }
  });

  // #3285 acceptance criterion 1. The trajectory block is what a meet does NOT
  // have, so the absence half is asserted alongside a POSITIVE reading of the same
  // card (badge + title) — an empty result would otherwise pass just as well on a
  // card that failed to render at all. The converse (a coached plan still carrying
  // both blocks) is the test above, on real elements, in this same file.
  test("a lifting meet is creatable with no discipline, and completes", async () => {
    test.slow();
    await clearPlans(page);

    await page.getByTestId("endurance-add-toggle").click();
    await expect(page.getByTestId("endurance-form")).toBeVisible();
    await page.getByRole("combobox", { name: "Kind" }).fill("meet");
    await page.getByTestId("endurance-discipline").selectOption("");
    await page.getByTestId("endurance-event-name").fill("E2E County Meet");
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    // No target distance: a meet has none, and the field is no longer required.
    await settledClick(page, page.getByTestId("endurance-submit"));

    const card = page.getByTestId("endurance-plan-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("endurance-plan-title")).toHaveText(
      "E2E County Meet"
    );
    // The badge carries the KIND where a cardio plan carries its discipline.
    await expect(card).toContainText("Meet");
    // …and there is no trajectory to show.
    await expect(card.getByTestId("endurance-plan-target")).toHaveCount(0);
    await expect(card.getByTestId("endurance-plan-message")).toHaveCount(0);

    // A second active meet is allowed — the one-per-scope rule is about a cardio
    // discipline, and a meet has none.
    await page.getByTestId("endurance-add-toggle").click();
    await page.getByRole("combobox", { name: "Kind" }).fill("tournament");
    await page.getByTestId("endurance-discipline").selectOption("");
    await page.getByTestId("endurance-event-name").fill("E2E Club Open");
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await settledClick(page, page.getByTestId("endurance-submit"));
    await expect(card).toHaveCount(2);

    // Completing the meet retires it from the bar (the lifecycle is unchanged).
    await settledClick(
      page,
      page.getByTestId("endurance-set-completed").first() // first-ok: the meet card THIS test created
    );
    await expect(card).toHaveCount(1);

    await clearPlans(page);
  });

  // #3285 item 2: the event page reads the plan, the day and the result in one
  // place. An event dated today lists the seeded race-day run under the day; one
  // tap links it as the result, and one tap unlinks it. Every lookup is scoped to
  // the app content root (the #4890 rule), which is why the test names no bare
  // page.getByTestId.
  test("an event's page lists the day's run and links it as the result", async () => {
    test.slow();
    await clearPlans(page);
    const content = page.getByTestId("app-content-container");

    await content.getByTestId("endurance-add-toggle").click();
    await content.getByTestId("endurance-event-name").fill("E2E Race Day");
    await content.getByTestId("endurance-event-date").fill(todayEventDate());
    await content.getByTestId("endurance-distance").fill("10");
    await settledClick(page, content.getByTestId("endurance-submit"));
    const card = content.getByTestId("endurance-plan-card");
    await expect(card).toHaveCount(1);

    // The card's title opens the event page.
    await card.getByTestId("endurance-plan-title").click();
    await expect(page).toHaveURL(/\/training\/event\/\d+$/);
    await expect(content.getByTestId("event-summary")).toContainText("Race");

    // Nothing linked yet; the day offers the seeded race-labelled run.
    const linked = content
      .getByTestId("event-linked-list")
      .getByTestId("event-activity");
    const dayRows = content
      .getByTestId("event-day-list")
      .getByTestId("event-activity");
    await expect(linked).toHaveCount(0);
    await expect(dayRows).toHaveCount(1);
    await expect(dayRows).toContainText("race");

    await settledClick(
      page,
      page.getByRole("button", { name: "Link Running" })
    );
    await expect(linked).toHaveCount(1);
    await expect(dayRows).toHaveCount(0);

    await settledClick(
      page,
      page.getByRole("button", { name: "Unlink Running" })
    );
    await expect(linked).toHaveCount(0);
    await expect(dayRows).toHaveCount(1);

    // #3285 item 3: the event's photos, through the SHARED add-media door — the
    // same walk every other photo domain takes (#3286), so this proves the tenant
    // is wired to the core rather than to a bespoke input. The strip's own
    // lifecycle is the plan's: clearPlans below deletes the event, and
    // deleteEndurancePlanCore takes its photos and their files with it.
    const strip = content.getByTestId("training-photos");
    await expect(strip).toContainText("No photos yet");
    await capturePhotoFile(page, strip.getByTestId("training-photo-add"), {
      name: "podium.jpg",
      mimeType: "image/jpeg",
      buffer: await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 20, g: 120, b: 90 },
        },
      })
        .jpeg()
        .toBuffer(),
    });
    // capturePhotoFile STAGES the file; the shared surface waits for a confirm, which
    // is what makes a batch a list of named things (#3286).
    await expect(page.getByTestId("media-input-preview-0")).toBeVisible();
    await settledClick(page, page.getByTestId("media-input-submit"));
    await expect(page.getByTestId("media-input-preview-0")).toBeHidden();

    const thumbs = strip.locator("img");
    await expect(thumbs).toHaveCount(1);
    // The grid reads the THUMBNAIL asset, not the original (#1119).
    await expect(thumbs).toHaveAttribute(
      "src",
      /\/api\/training-photo\/\d+\?thumb=1$/
    );

    await clearPlans(page);
  });
});
