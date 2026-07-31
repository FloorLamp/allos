import { test, expect } from "./fixtures";
import { hydratedClick, settledFill } from "./helpers";

// The MyChart card's setup flow (#1739): register a portal, map a patient to a profile,
// and see the mapping listed.
//
// The assertion that matters most is the REFUSAL of a URL. A portal is recorded by name
// only — allos owns the portal's identity, the companion tool owns its address — and that
// is what stops a compromised record from aiming an attended browser tool at a login form
// an attacker controls. The schema has no address column; this proves the one free-text
// field where one could be typed refuses it too.
//
// FIXTURE OWNERSHIP: every portal this spec creates carries a unique slug, and the spec
// removes what it adds, so it never counts or disturbs rows another spec owns.
test.describe("MyChart setup (#1739)", () => {
  test("register a portal, map a patient, and see the binding", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const slug = `spec-portal-${stamp}`;
    const label = `Spec Patient ${stamp}`;

    await page.goto("/integrations/mychart");
    await expect(page.getByTestId("mychart-portals")).toBeVisible();

    // 1. Register the portal.
    await settledFill(page, page.getByTestId("mychart-portal-slug"), slug);
    await settledFill(
      page,
      page.getByTestId("mychart-portal-name"),
      `Spec Portal ${stamp}`
    );
    await hydratedClick(page, page.getByTestId("mychart-portal-add"));
    await expect(page.getByTestId("mychart-status")).toHaveText(
      "Portal added."
    );
    const portalRow = page
      .getByTestId("mychart-portal-row")
      .filter({ hasText: slug })
      .first(); // first-ok: the slug is unique to this test, so this is spec-owned data
    await expect(portalRow).toBeVisible();

    // 2. Map a patient on it. The select lists portals by display name.
    await page
      .getByTestId("mychart-bind-portal")
      .selectOption({ label: `Spec Portal ${stamp}` });
    await settledFill(page, page.getByTestId("mychart-bind-label"), label);
    await hydratedClick(page, page.getByTestId("mychart-bind-add"));
    await expect(page.getByTestId("mychart-status")).toHaveText(
      "Patient mapped."
    );

    // 3. The binding is listed, naming both the portal and the profile it routes to.
    const identityRow = page
      .getByTestId("mychart-identity-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row, matched by its unique label
    await expect(identityRow).toBeVisible();
    await expect(identityRow).toContainText(`Spec Portal ${stamp}`);

    // …and it survives a reload (it is persisted, not optimistic).
    await page.reload();
    await expect(
      page.getByTestId("mychart-identity-row").filter({ hasText: label })
    ).toHaveCount(1);

    // 4. Clean up: removing the portal takes its binding with it.
    await hydratedClick(
      page,
      page
        .getByTestId("mychart-portal-row")
        .filter({ hasText: slug })
        .first() // first-ok: spec-owned row
        .getByTestId("mychart-portal-remove")
    );
    await expect(page.getByTestId("mychart-status")).toHaveText(
      "Portal removed."
    );
    await expect(
      page.getByTestId("mychart-identity-row").filter({ hasText: label })
    ).toHaveCount(0);
  });

  test("a portal refuses a web address in its name", async ({ page }) => {
    test.slow();
    const slug = `spec-url-${String(Date.now()).slice(-6)}`; // clock-ok: a uniqueness suffix for this spec's own fixture row, never a stored timestamp

    await page.goto("/integrations/mychart");
    await settledFill(page, page.getByTestId("mychart-portal-slug"), slug);
    await settledFill(
      page,
      page.getByTestId("mychart-portal-name"),
      "https://mychart.example.org/login"
    );
    await hydratedClick(page, page.getByTestId("mychart-portal-add"));

    // Refused, with the reason stated in the user's terms.
    await expect(page.getByTestId("mychart-error")).toContainText(
      "never a web address"
    );
    // And nothing was stored.
    await expect(
      page.getByTestId("mychart-portal-row").filter({ hasText: slug })
    ).toHaveCount(0);
  });

  test("the card links to token setup and explains what a quiet run means", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/integrations/mychart");
    // The tool needs an upload token, so the page points at where one is minted.
    await expect(
      page.getByRole("link", { name: "Settings → API tokens" })
    ).toBeVisible();
    // A run that found nothing is still a check — the card must not read as broken.
    await expect(page.getByTestId("mychart-status-line")).toBeVisible();
  });
});
