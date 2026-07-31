import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, settledFill, settledSelect } from "./helpers";
import { workerDbPath } from "./worker-env";

// The Patient portals card's setup flow (#1739): register a portal, map a patient to a
// profile, and see the mapping listed.
//
// The assertion that matters most is the REFUSAL of a URL. A portal is recorded by name
// only — allos owns the portal's identity, the companion tool owns its address — and that
// is what stops a compromised record from aiming an attended browser tool at a login form
// an attacker controls. The schema has no address column; this proves the one free-text
// field where one could be typed refuses it too.
//
// FIXTURE OWNERSHIP: every portal this spec creates carries a unique NAME (allos mints
// the slug from it), and the spec removes what it adds, so it never counts or disturbs
// rows another spec owns.
test.describe("Patient portals setup (#1739)", () => {
  test("register a portal, map a patient, and see the binding", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Spec Portal ${stamp}`;
    const label = `Spec Patient ${stamp}`;

    await page.goto("/integrations/patient-portals");
    await expect(page.getByTestId("portals-registry")).toBeVisible();

    // 1. Register the portal. There is NO slug field — allos mints the key from the name.
    await settledFill(page, page.getByTestId("portal-name"), portal);
    await hydratedClick(page, page.getByTestId("portal-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal added."
    );
    const portalRow = page
      .getByTestId("portal-row")
      .filter({ hasText: portal })
      .first(); // first-ok: the name is unique to this test, so this is spec-owned data
    await expect(portalRow).toBeVisible();
    // The minted slug is shown, because it is what the companion tool's config quotes.
    await expect(portalRow).toContainText(`spec-portal-${stamp}`);

    // 2. Map a patient on it. With one login the select names the portal alone — the
    //    account component is invisible until a second login exists.
    await page.getByTestId("bind-account").selectOption({ label: portal });
    await settledFill(page, page.getByTestId("bind-label"), label);
    await hydratedClick(page, page.getByTestId("bind-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Patient mapped."
    );

    // 3. The binding is listed, naming both the portal and the profile it routes to.
    const identityRow = page
      .getByTestId("portal-identity-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row, matched by its unique label
    await expect(identityRow).toBeVisible();
    await expect(identityRow).toContainText(portal);

    // …and it survives a reload (it is persisted, not optimistic).
    await page.reload();
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(1);

    // 4. Clean up: removing the portal takes its binding with it.
    await hydratedClick(
      page,
      page
        .getByTestId("portal-row")
        .filter({ hasText: portal })
        .first() // first-ok: spec-owned row
        .getByTestId("portal-remove")
    );
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal removed."
    );
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(0);
  });

  test("a portal refuses a web address in its name", async ({ page }) => {
    test.slow();
    await page.goto("/integrations/patient-portals");
    await settledFill(
      page,
      page.getByTestId("portal-name"),
      "https://mychart.example.org/login"
    );
    await hydratedClick(page, page.getByTestId("portal-add"));

    // Refused, with the reason stated in the user's terms.
    await expect(page.getByTestId("portals-error")).toContainText(
      "never a web address"
    );
    // And nothing was stored.
    await expect(
      page.getByTestId("portal-row").filter({ hasText: "mychart.example.org" })
    ).toHaveCount(0);
  });

  test("a second login on one portal keeps two identical patient labels apart", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Two Logins ${stamp}`;
    const label = `SHARED, LABEL ${stamp}`;

    await page.goto("/integrations/patient-portals");
    await settledFill(page, page.getByTestId("portal-name"), portal);
    await hydratedClick(page, page.getByTestId("portal-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal added."
    );

    // Add a named login. Now the portal has two (the implicit one and this), so the
    // account becomes visible everywhere it matters.
    await page.getByTestId("account-portal").selectOption({ label: portal });
    await settledFill(page, page.getByTestId("account-name"), "Mom");
    await hydratedClick(page, page.getByTestId("account-add"));
    await expect(page.getByTestId("portals-status")).toHaveText("Login added.");

    // The SAME label under both logins — two different people, two bindings.
    for (const login of ["Default login", "Mom"]) {
      await page
        .getByTestId("bind-account")
        .selectOption({ label: `${portal} — ${login}` });
      await settledFill(page, page.getByTestId("bind-label"), label);
      await hydratedClick(page, page.getByTestId("bind-add"));
      await expect(page.getByTestId("portals-status")).toHaveText(
        "Patient mapped."
      );
    }

    // Two rows, not one — the collapse a two-part key would have caused.
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(2);
    await expect(
      page
        .getByTestId("portal-identity-row")
        .filter({ hasText: label })
        .filter({ hasText: "Mom" })
    ).toHaveCount(1);

    await hydratedClick(
      page,
      page
        .getByTestId("portal-row")
        .filter({ hasText: portal })
        .first() // first-ok: spec-owned row
        .getByTestId("portal-remove")
    );
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal removed."
    );
  });

  test("the card links to token setup and explains what a quiet run means", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/integrations/patient-portals");
    // The tool needs an upload token, so the page points at where one is minted.
    await expect(
      page.getByRole("link", { name: "Settings → API tokens" })
    ).toBeVisible();
    // A run that found nothing is still a check — the card must not read as broken.
    await expect(page.getByTestId("portals-status-line")).toBeVisible();
  });

  // THE IMPLICIT LOGIN'S PARENTHETICAL IS CONDITIONAL (#1756). "Used when the tool names
  // no login" is true only while it is the portal's ONLY login: once a second exists,
  // resolveAccount REFUSES an account-less request rather than falling back to it. The
  // copy asserted a fallback that had stopped happening, exactly when a household most
  // needs to understand why its tool started erroring.
  test("the default login's note changes when a second login appears", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Implicit Copy ${stamp}`;

    await page.goto("/integrations/patient-portals");
    await settledFill(page, page.getByTestId("portal-name"), portal);
    await hydratedClick(page, page.getByTestId("portal-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal added."
    );

    const portalRow = page
      .getByTestId("portal-row")
      .filter({ hasText: portal })
      .first(); // first-ok: the name is unique to this test, so this is spec-owned data
    const note = portalRow.getByTestId("portal-account-implicit-note");
    await expect(note).toHaveText("(used when the tool names no login)");

    // A second login, and the promise of a fallback stops being true.
    await page.getByTestId("account-portal").selectOption({ label: portal });
    await settledFill(page, page.getByTestId("account-name"), "Mom");
    await hydratedClick(page, page.getByTestId("account-add"));
    await expect(page.getByTestId("portals-status")).toHaveText("Login added.");
    await expect(note).toHaveText("(the tool must name a login)");

    await hydratedClick(page, portalRow.getByTestId("portal-remove"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal removed."
    );
  });
});

// DISCOVERED / REFUSED IDENTITIES (#1739). The tool reports the proxy patients it saw, so
// this list is normally populated by DISCOVERY rather than by failure — the user binds a
// label allos was told, verbatim, instead of predicting how a portal renders a name.
//
// FIXTURE OWNERSHIP: this spec creates its own portal (unique name) and its own pending
// row on it, and removes the portal at the end — which takes both with it.
test.describe("Patient portals — waiting to be mapped (#1739)", () => {
  // Plant a pending row directly: the route that writes one needs a bearer token and a
  // JSON run report, which is the API's own DB-tier territory. What this spec owns is
  // what the CARD does with a pending row once one exists.
  function plantPending(portalName: string, label: string, outcome: string) {
    const handle = new Database(workerDbPath());
    try {
      const portal = handle
        .prepare("SELECT id FROM portals WHERE name = ?")
        .get(portalName) as { id: number };
      const account = handle
        .prepare("SELECT id FROM portal_accounts WHERE portal_id = ?")
        .get(portal.id) as { id: number };
      handle
        .prepare(
          `INSERT INTO pending_portal_identities
             (portal_id, account_id, patient_label, first_seen_at, last_seen_at, seen_count, last_outcome)
           VALUES (?, ?, ?, '2026-01-02 03:04:05', '2026-01-03 03:04:05', 2, ?)`
        )
        .run(portal.id, account.id, label, outcome);
    } finally {
      handle.close();
    }
  }

  async function addPortal(
    page: import("@playwright/test").Page,
    name: string
  ) {
    await page.goto("/integrations/patient-portals");
    await settledFill(page, page.getByTestId("portal-name"), name);
    await hydratedClick(page, page.getByTestId("portal-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal added."
    );
  }

  async function removePortal(
    page: import("@playwright/test").Page,
    name: string
  ) {
    await hydratedClick(
      page,
      page
        .getByTestId("portal-row")
        .filter({ hasText: name })
        .first() // first-ok: spec-owned row
        .getByTestId("portal-remove")
    );
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal removed."
    );
  }

  test("a reported patient shows up waiting, and one tap maps it", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Pending Portal ${stamp}`;
    const label = `Pending Patient ${stamp}`;

    await addPortal(page, portal);
    plantPending(portal, label, "discovered");
    await page.reload();

    // It is listed, saying which portal reported it and how long it has been waiting —
    // "seen twice since Friday" is the sentence that makes this actionable.
    const pendingRow = page
      .getByTestId("pending-row")
      .filter({ hasText: label })
      .first(); // first-ok: the label is unique to this test, so this is spec-owned data
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow).toContainText(portal);
    await expect(pendingRow).toContainText("2026-01-02");
    await expect(pendingRow).toContainText("seen 2×");

    // NOTHING IS PRESELECTED (#1756). The picker used to open on the first writable
    // profile, so "file this patient under whoever sorts first" was one click away —
    // the exact misfiling this card exists to prevent, and the one mistake nothing
    // downstream can catch. So Map is dead until a human has actually said who this is.
    const picker = pendingRow.getByTestId("pending-profile");
    await expect(picker).toHaveValue("");
    await expect(pendingRow.getByTestId("pending-map")).toBeDisabled();

    // Choose a real profile — whichever the picker offers first after the placeholder.
    const profileValue = await picker
      .locator("option")
      .nth(1)
      .getAttribute("value");
    expect(profileValue).toBeTruthy();
    await settledSelect(page, picker, profileValue!);
    await expect(pendingRow.getByTestId("pending-map")).toBeEnabled();

    // One tap maps it onto the chosen profile.
    await hydratedClick(page, pendingRow.getByTestId("pending-map"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Patient mapped."
    );

    // The pending row is GONE (binding clears it in the same write) and the binding is
    // listed instead — under the exact label that was reported, not a retyped one.
    await expect(
      page.getByTestId("pending-row").filter({ hasText: label })
    ).toHaveCount(0);
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(1);

    // …and it survives a reload: the mapping is persisted, the pending row really went.
    await page.reload();
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(1);
    await expect(
      page.getByTestId("pending-row").filter({ hasText: label })
    ).toHaveCount(0);

    await removePortal(page, portal);
  });

  test("ignoring a reported patient records a binding that points nowhere", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Ignore Portal ${stamp}`;
    const label = `Ignore Patient ${stamp}`;

    await addPortal(page, portal);
    plantPending(portal, label, "unmapped-sync-report");
    await page.reload();

    const pendingRow = page
      .getByTestId("pending-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row, matched by its unique label
    await expect(pendingRow).toBeVisible();

    await hydratedClick(page, pendingRow.getByTestId("pending-ignore"));
    await expect(page.getByTestId("portals-status")).toContainText(
      "Patient ignored"
    );

    // Gone from the prompt list, and present as a binding that syncs nothing — the
    // difference between "not now" and "not ever" is visible on the card.
    await expect(
      page.getByTestId("pending-row").filter({ hasText: label })
    ).toHaveCount(0);
    const ignoredRow = page
      .getByTestId("portal-identity-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row
    await expect(ignoredRow).toBeVisible();
    await expect(ignoredRow.getByTestId("portal-identity-ignored")).toHaveText(
      "not synced (ignored)"
    );

    await removePortal(page, portal);
  });

  test("dismissing a reported patient clears the prompt without binding anything", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Dismiss Portal ${stamp}`;
    const label = `Dismiss Patient ${stamp}`;

    await addPortal(page, portal);
    plantPending(portal, label, "discovered");
    await page.reload();

    const pendingRow = page
      .getByTestId("pending-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row, matched by its unique label
    await expect(pendingRow).toBeVisible();

    await hydratedClick(page, pendingRow.getByTestId("pending-dismiss"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Cleared for now."
    );
    await expect(
      page.getByTestId("pending-row").filter({ hasText: label })
    ).toHaveCount(0);
    // Dismissing is NOT binding and NOT ignoring: nothing was recorded about the patient.
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(0);

    await removePortal(page, portal);
  });

  // FIRST CONTACT (#1756). The card promises "the tool reports every run, so a quiet week
  // reads as healthy rather than broken" — and then said "No run reported yet." directly
  // above a list of patients a run had just reported, because that run's own patient was
  // unmapped and its report was refused. Status must not contradict the card it sits on.
  test("Status names what the run reported instead of claiming nothing happened", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `First Contact ${stamp}`;
    const label = `First Patient ${stamp}`;

    await addPortal(page, portal);
    const line = page.getByTestId("portals-status-line");
    // Nothing has happened yet, and the card says exactly that.
    await expect(line).toHaveText("No run reported yet.");

    plantPending(portal, label, "discovered");
    await page.reload();
    // Now it names the portal the tool reported on, and the action that finishes setup.
    await expect(line).toHaveAttribute("data-tone", "attention");
    await expect(line).toContainText(portal);
    await expect(line).toContainText("finish setup");

    await removePortal(page, portal);
  });
});
