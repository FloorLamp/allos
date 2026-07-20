import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_PREVCODE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Coded records satisfy preventive rules end-to-end in the browser (#1035/#1037).
// The PREVENTIVE_CODES fixture profile (e2e/seed-events.ts) is a ~46-year-old
// whose ONLY visit evidence is:
//   • an imported-shaped encounter typed "Office Visit" carrying CPT 99396 —
//     no adult_physical name synonym matches, only the captured type code, and
//   • a completed dental row named "Prophy" carrying CDT D1110 — no
//     dental_cleaning synonym matches, only the cdt_code.
// Pre-fix, both rules nagged as overdue with the disproving records on file;
// post-fix their Upcoming items must be ABSENT while vision_exam (no evidence)
// stays due — the rendered anchor that proves the list actually loaded.
//
// Fixture-OWNED per e2e hygiene (#868): a dedicated login/profile, READ-ONLY
// here — no writes, so --repeat-each is trivially self-contained. (The shared
// profile 1 keeps its dental_cleaning item DUE for preventive-upcoming.spec.ts,
// which is why these rows live on their own profile.)

test("a coded encounter (CPT 99396) and a coded dental row (D1110) quiet their preventive items", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PREVCODE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    // Anchor: the eye exam has no satisfying evidence on this profile, so its
    // due item proves the preventive list is fully rendered before the absence
    // assertions below run.
    await expect(
      main.getByTestId("upcoming-item-visit:vision_exam")
    ).toBeVisible();

    // The coded "Office Visit" (99396) satisfies the adult physical …
    await expect(
      main.getByTestId("upcoming-item-visit:adult_physical")
    ).toHaveCount(0);
    // … and the coded completed "Prophy" (D1110) satisfies the dental cleaning.
    await expect(
      main.getByTestId("upcoming-item-visit:dental_cleaning")
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
});
