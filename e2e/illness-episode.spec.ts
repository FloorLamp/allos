import { test, expect } from "./fixtures";
import { loginAs, followLink } from "./nav";
import { switchToProfile } from "./family-helpers";
import { medicationDetail, medicationOverview } from "./med-card-helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_ILLNESS_CAREGIVER,
  E2E_LOGIN_ILLNESS_RO,
} from "./fixture-logins";

// Illness-episode view (issue #801). The seed makes profile 1 currently sick — an
// ongoing "Illness" situation with day-by-day symptoms, a fever curve (#800), and PRN
// ibuprofen administrations (#797). These specs drive the surfaces that tell that story:
//   1. the Timeline episode card + its detail page (over the shared assembly);
//   2. the tokenized /share link rendering the summary anonymously;
//   3. the illness hero's cross-profile accordion (#858) for a granted member.
// All format over the SAME assembleIllnessEpisode — no second engine (#221).

test.describe("Illness-episode view (#801)", () => {
  test("the Timeline shows an episode story card that opens the detail page", async ({
    page,
  }) => {
    test.slow(); // local next dev compiles /timeline + /medical/episodes on first hit.

    await page.goto("/timeline?category=illness");

    // The episode card's title is a link — an "Illness" story headline with "day N".
    const link = page.getByRole("link", { name: /Illness · day \d+/ }).first(); // first-ok: the acting profile's Illness episode headline link — order-agnostic
    await expect(link).toBeVisible();
    await followLink(page, link, /\/medical\/episodes\//);

    // The detail page renders the full picture over the assembly.
    await expect(
      page.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
    await expect(page.getByTestId("episode-symptoms")).toBeVisible();
    await expect(page.getByTestId("episode-fever")).toBeVisible();
    await expect(page.getByTestId("episode-meds")).toBeVisible();
    const latest = page
      .getByTestId("episode-summary-header")
      .getByTestId("episode-latest-readings");
    await expect(latest.getByTestId("episode-last-temperature")).toContainText(
      /\d{2}:\d{2} \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
    await expect(latest.getByTestId("episode-last-dose")).toContainText(
      /\d{2}:\d{2} \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
  });

  test("the household page shows a 'sick' chip on the currently-ill profile's card", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/household");
    // Profile 1 is sick (seed), so at least one card carries the sick chip.
    const sickChip = page.getByTestId("household-sick-chip").first(); // first-ok: at least one card carries the sick chip (profile 1 is sick, see comment) — order-agnostic
    await expect(sickChip).toBeVisible();
    await expect(sickChip).toContainText(/sick/i);
  });
});
