import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledFill, settledSelect } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath, frozenNow } from "./worker-env";
import { E2E_LOGIN_PORTAL_A, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Patient portals page (#1739, reshaped by #1826): register a portal, map a patient to
// a profile, and see the mapping listed — through a GUIDED flow that renders one stage's
// card at a time instead of eight flat siblings.
//
// The assertion that matters most is still the REFUSAL of a URL. A portal is recorded by
// name only — allos owns the portal's identity, the companion tool owns its address — and
// that is what stops a compromised record from aiming an attended browser tool at a login
// form an attacker controls. The schema has no address column; this proves the one
// free-text field where one could be typed refuses it too.
//
// WHAT #1826 CHANGED FOR THIS FILE. The registry, the add forms, the row maintenance verbs
// and the manual bind moved into the collapsed "Manage portals & logins" disclosure, and
// remove/unbind became ⋯ menu entries behind a real confirm. Every assertion below is the
// same assertion it was; it is the route to the control that moved. Reaching setup through
// Manage is also what makes these specs stage-INDEPENDENT: Manage opens from any stage, so
// a test never has to know which card the shared worker database happens to be showing.
//
// FIXTURE OWNERSHIP: every portal this spec creates carries a unique NAME (allos mints the
// slug from it), and the spec removes what it adds, so it never counts or disturbs rows
// another spec owns.

// Manage is a native <details>, so a reload closes it and a Server-Action re-render leaves
// it as it was. This reads the element's own open state instead of assuming either, which
// makes it safe to call at any point in a test.
async function openManage(page: Page): Promise<void> {
  const manage = page.getByTestId("portals-manage");
  await expect(manage).toBeVisible();
  const alreadyOpen = await manage.evaluate(
    (el) => (el as HTMLDetailsElement).open
  );
  if (!alreadyOpen) await manage.getByTestId("portals-manage-toggle").click();
  await expect(page.getByTestId("portal-identities")).toBeVisible();
}

// Open one row's ⋯ menu. Addressed by the trigger's accessible name, which names the row's
// subject — a portal row also contains its logins' triggers, so "the button in this row"
// is not a unique thing to ask for.
async function openRowMenu(
  page: Page,
  row: Locator,
  subject: string
): Promise<void> {
  await hydratedClick(
    page,
    row.getByRole("button", { name: `Actions for ${subject}` })
  );
}

// The menu panel is portaled to <body> and only one menu is ever open, so a menu entry is
// addressed at page level rather than inside the row it belongs to.
async function menuItem(page: Page, testId: string): Promise<Locator> {
  const item = page.getByTestId(testId);
  await expect(item).toBeVisible();
  return item;
}

// Destructive row verbs confirm through the shared dialog (#1587), never a native one.
async function confirmWith(page: Page, label: string): Promise<void> {
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label }).click();
}

async function addPortal(page: Page, name: string): Promise<void> {
  await page.goto("/integrations/patient-portals");
  await openManage(page);
  await settledFill(page, page.getByTestId("portal-name"), name);
  await hydratedClick(page, page.getByTestId("portal-add"));
  await expect(page.getByTestId("portals-status")).toHaveText("Portal added.");
}

async function removePortal(page: Page, name: string): Promise<void> {
  await openManage(page);
  const row = page
    .getByTestId("portal-row")
    .filter({ hasText: name })
    .first(); // first-ok: the name is unique to the calling test, so this is spec-owned data
  await openRowMenu(page, row, name);
  await (await menuItem(page, "portal-remove")).click();
  await confirmWith(page, "Remove portal");
  await expect(page.getByTestId("portals-status")).toHaveText(
    "Portal removed."
  );
}

// Mint a real `upload:documents` token through the UI — the same path an operator uses,
// and the only place the secret is ever shown.
async function mintToken(page: Page, name: string): Promise<string> {
  await page.goto("/settings/tokens");
  await settledFill(page, page.getByTestId("api-token-name"), name);
  await hydratedClick(page, page.getByTestId("api-token-create"));
  const panel = page.getByTestId("api-token-secret");
  await expect(panel).toBeVisible();
  return (await panel.locator("code").innerText()).trim();
}

// Plant a pending row directly: the route that writes one needs a bearer token and a JSON
// run report, which is the API's own DB-tier territory. What this spec owns is what the
// PAGE does with a pending row once one exists.
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

// A run report for the caller's own portal. It goes away with the portal, so a test that
// removes what it added leaves no report behind for a neighbour to trip over.
//
// `at` defaults to the run's frozen instant — the newest a report can be. A caller that
// needs a request raised AFTERWARDS to read as open must pass an older stamp, because a
// report at or after a request's creation is what ANSWERS it (lib/sync-requests.ts).
function plantRunReport(portalName: string, at?: string) {
  const handle = new Database(workerDbPath());
  try {
    const portal = handle
      .prepare("SELECT id FROM portals WHERE name = ?")
      .get(portalName) as { id: number };
    const account = handle
      .prepare("SELECT id FROM portal_accounts WHERE portal_id = ?")
      .get(portal.id) as { id: number };
    const stamp =
      at ?? frozenNow().toISOString().replace("T", " ").slice(0, 19);
    handle
      .prepare(
        `INSERT INTO portal_run_reports
           (account_id, portal_id, at, ok, status, message, discovered)
         VALUES (?, ?, ?, 1, 'nothing-new', NULL, 0)
         ON CONFLICT(account_id) DO UPDATE SET at = excluded.at, ok = 1`
      )
      .run(account.id, portal.id, stamp);
  } finally {
    handle.close();
  }
}

test.describe("Patient portals setup (#1739)", () => {
  test("register a portal, map a patient, and see the binding", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Spec Portal ${stamp}`;
    const label = `Spec Patient ${stamp}`;

    // 1. Register the portal. There is NO slug field — allos mints the key from the name.
    await addPortal(page, portal);
    const portalRow = page
      .getByTestId("portal-row")
      .filter({ hasText: portal })
      .first(); // first-ok: the name is unique to this test, so this is spec-owned data
    await expect(portalRow).toBeVisible();
    // The minted slug is shown, because it is what the companion tool's config quotes.
    await expect(portalRow).toContainText(`spec-portal-${stamp}`);

    // 2. Map a patient on it, through the manual bind — which is now an ESCAPE HATCH
    //    inside Manage rather than the page's primary affordance (#1826), and says so.
    await expect(page.getByTestId("portal-identities")).toContainText(
      "use this only to pre-bind a label you know exactly"
    );
    // With one login the select names the portal alone — the account component is
    // invisible until a second login exists.
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
    await openManage(page);
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(1);

    // 4. Clean up: removing the portal takes its binding with it.
    await removePortal(page, portal);
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(0);
  });

  test("a portal refuses a web address in its name", async ({ page }) => {
    test.slow();
    await page.goto("/integrations/patient-portals");
    await openManage(page);
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

    await addPortal(page, portal);

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

    await removePortal(page, portal);
  });

  // THE NUMBERED OVERVIEW IS A COLLAPSIBLE NOW (#1826). It used to be a permanent card
  // whose five steps did not match the order of the cards below it. Each stage states its
  // own next step; the whole shape is one click away for whoever wants it.
  test("the page names one next step, with the five-step overview one click away", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/integrations/patient-portals");

    // Exactly one stage card, always — the page never renders two next steps.
    await expect(page.getByTestId("portal-stage")).toHaveCount(1);

    // Closed by default: the overview is in the page but not in the way.
    const overviewTokenLink = page.getByTestId("how-it-works-token-link");
    await expect(overviewTokenLink).toBeHidden();
    await page.getByTestId("portals-how-it-works-toggle").click();
    // The tool needs an upload token, so the overview points at where one is minted.
    await expect(overviewTokenLink).toBeVisible();
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

    await addPortal(page, portal);

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

    await removePortal(page, portal);
  });

  // RENAME WAS A SHIPPED ACTION WITH NO UI (#1826). `renamePortalAction` existed from
  // #1739 and nothing rendered it — the slug/name split exists precisely so a rename is
  // safe, and a typo was permanent anyway.
  test("renaming a portal from its ⋯ menu changes the name and not the slug", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Typo Portal ${stamp}`;
    const fixed = `Fixed Portal ${stamp}`;

    await addPortal(page, portal);
    const row = page
      .getByTestId("portal-row")
      .filter({ hasText: portal })
      .first(); // first-ok: spec-owned row, matched by its unique name
    await openRowMenu(page, row, portal);
    await (await menuItem(page, "portal-rename")).click();
    await settledFill(page, page.getByTestId("portal-rename-input"), fixed);
    await hydratedClick(page, page.getByTestId("portal-rename-save"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Portal renamed."
    );

    const renamed = page
      .getByTestId("portal-row")
      .filter({ hasText: fixed })
      .first(); // first-ok: spec-owned row
    await expect(renamed).toBeVisible();
    // The key every tool config quotes is untouched — that is the whole point.
    await expect(renamed).toContainText(`typo-portal-${stamp}`);
    await expect(
      page.getByTestId("portal-row").filter({ hasText: portal })
    ).toHaveCount(0);

    await removePortal(page, fixed);
  });
});

// THE STAGES (#1826). The page derives where a household is from data it already holds and
// renders only that step. This walks the transitions a shared worker database can express
// end to end, inside ONE test so every fact it depends on is one it planted itself.
//
// The "create a token" stage is deliberately absent here and pinned in the pure tier
// instead: whether a live `upload:documents` token exists is instance-global state that
// other specs mint into and never revoke, so a browser assertion on its ABSENCE would pass
// or fail on test scheduling rather than on behaviour.
test.describe("Patient portals — the guided stages (#1826)", () => {
  test("the page walks a household from first run to steady state and back", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Stage Walk ${stamp}`;
    const label = `Stage Patient ${stamp}`;
    const stage = page.getByTestId("portal-stage");

    await addPortal(page, portal);
    // A token exists from here on, so the token stage cannot be the answer.
    await mintToken(page, `stage walk ${stamp}`);

    // STAGE: nothing has ever run. The page asks for a run and says how long the first
    // one takes — the only stage that needs that note.
    await page.goto("/integrations/patient-portals");
    await expect(stage).toHaveAttribute("data-stage", "first-run");
    await expect(stage).toContainText("Run the tool on that computer");
    await expect(stage).toContainText("can take several minutes");
    // No status sentence yet: nothing has happened for one to describe.
    await expect(page.getByTestId("portals-status-line")).toHaveCount(0);

    // STAGE: a run has reported. Status leads, and the sync history is one link away.
    plantRunReport(portal);
    await page.reload();
    await expect(stage).toHaveAttribute("data-stage", "steady");
    await expect(page.getByTestId("portals-status-line")).toBeVisible();
    await expect(page.getByTestId("sync-history-link")).toBeVisible();

    // STAGE: the tool reported a patient allos cannot place. Mapping becomes the page.
    plantPending(portal, label, "discovered");
    await page.reload();
    await expect(stage).toHaveAttribute("data-stage", "map-patients");
    const pendingRow = page
      .getByTestId("pending-row")
      .filter({ hasText: label })
      .first(); // first-ok: the label is unique to this test, so this is spec-owned data
    await expect(pendingRow).toBeVisible();
    // The manual bind is no longer a standing primary affordance — it is one click away
    // inside Manage, which is progressive disclosure rather than lockout.
    await expect(page.getByTestId("bind-add")).toBeHidden();
    await openManage(page);
    await expect(page.getByTestId("bind-add")).toBeVisible();

    // Map it, and the page settles back into steady state with the patient summarised.
    const picker = pendingRow.getByTestId("pending-profile");
    const profileValue = await picker
      .locator("option")
      .nth(1)
      .getAttribute("value");
    expect(profileValue).toBeTruthy();
    await settledSelect(page, picker, profileValue!);
    await hydratedClick(page, pendingRow.getByTestId("pending-map"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Patient mapped."
    );
    await expect(stage).toHaveAttribute("data-stage", "steady");
    await expect(
      page.getByTestId("portal-patient-row").filter({ hasText: label })
    ).toHaveCount(1);

    await removePortal(page, portal);
  });

  // A login that can reach no portal sees the introduction, and nothing else — no status
  // sentence, no forms, and no Manage drawer, because there is nothing in it for them.
  // Household A holds write access to its own profile and none to the profile the seeded
  // portal is bound to, so its VISIBLE registry (#1796) is empty by construction.
  test("a household with no portal of its own sees only the introduction", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_A,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");
      const stage = member.getByTestId("portal-stage");
      await expect(stage).toHaveAttribute("data-stage", "no-portals");
      // A member cannot register a portal, so the card says who can instead of showing a
      // form that would be refused at the gate.
      await expect(stage).toContainText("An admin on this instance can add one");
      await expect(member.getByTestId("portal-name")).toHaveCount(0);
      await expect(member.getByTestId("portals-status-line")).toHaveCount(0);
      await expect(member.getByTestId("portals-manage")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

// DISCOVERED / REFUSED IDENTITIES (#1739). The tool reports the proxy patients it saw, so
// this list is normally populated by DISCOVERY rather than by failure — the user binds a
// label allos was told, verbatim, instead of predicting how a portal renders a name. A
// refused upload lands here too, as the safety net for a patient who appears between runs.
//
// FIXTURE OWNERSHIP: this spec creates its own portal (unique name) and its own pending
// row on it, and removes the portal at the end — which takes both with it.
test.describe("Patient portals — waiting to be mapped (#1739)", () => {
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
    await openManage(page);
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(1);

    // …and it survives a reload: the mapping is persisted, the pending row really went.
    await page.reload();
    await openManage(page);
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
    // difference between "not now" and "not ever" is visible on the page.
    await expect(
      page.getByTestId("pending-row").filter({ hasText: label })
    ).toHaveCount(0);
    await openManage(page);
    const ignoredRow = page
      .getByTestId("portal-identity-row")
      .filter({ hasText: label })
      .first(); // first-ok: spec-owned row
    await expect(ignoredRow).toBeVisible();
    await expect(ignoredRow.getByTestId("portal-identity-ignored")).toHaveText(
      "not synced (ignored)"
    );

    // AND IT IS REVERSIBLE (#1826). "Never sync this person" was previously a one-way
    // door in the UI even though the lib half to undo it has always existed.
    await openRowMenu(page, ignoredRow, label);
    await (await menuItem(page, "portal-identity-unignore")).click();
    await expect(page.getByTestId("portals-status")).toContainText(
      "No longer ignored"
    );
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(0);

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
    await openManage(page);
    await expect(
      page.getByTestId("portal-identity-row").filter({ hasText: label })
    ).toHaveCount(0);

    await removePortal(page, portal);
  });

  // FIRST CONTACT (#1756). The page promised "the tool reports every run, so a quiet week
  // reads as healthy rather than broken" — and then said "No run reported yet." directly
  // above a list of patients a run had just reported, because that run's own patient was
  // unmapped and its report was refused. The ONE status computation now leads the mapping
  // stage as well as the steady one (#1826), which is where its first-contact sentence
  // always pointed ("map them below to finish setup").
  test("Status names what the run reported instead of claiming nothing happened", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `First Contact ${stamp}`;
    const label = `First Patient ${stamp}`;

    await addPortal(page, portal);
    // Nothing has happened yet, so the page states a next step rather than a status.
    await expect(page.getByTestId("portals-status-line")).toHaveCount(0);

    plantPending(portal, label, "discovered");
    await page.reload();
    // Now it names the portal the tool reported on, and the action that finishes setup.
    const line = page.getByTestId("portals-status-line");
    await expect(line).toHaveAttribute("data-tone", "attention");
    await expect(line).toContainText(portal);
    await expect(line).toContainText("finish setup");

    await removePortal(page, portal);
  });

  // SYNC REQUESTS (#1757). Allos cannot run a portal sync, so the page cannot offer
  // "Sync now" — what it offers is asking the person whose machine holds the login. The
  // open ask is shown with its expiry, and it CLEARS when a run is reported, because the
  // request answers itself rather than needing an acknowledgment protocol.
  //
  // It lives in the steady-state card (#1826) — asking someone to run a sync is a thing a
  // running household does — so this test plants the run report that puts the page there.
  test("an open sync request shows on the page and clears when a run is reported", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Request Portal ${stamp}`;
    const label = `Request Patient ${stamp}`;

    await addPortal(page, portal);
    // An OLD run puts the page in steady state without answering the request raised
    // below — a report at or after a request's creation is what clears it.
    plantRunReport(portal, "2026-01-05 09:00:00");
    await page.reload();

    // A login with no mapped patient can be asked, and the refusal says why — a nudge
    // there would have nobody to reach.
    const row = page
      .getByTestId("sync-request-row")
      .filter({ hasText: portal })
      .first(); // first-ok: the portal name is unique to this test
    await expect(row).toBeVisible();
    await hydratedClick(page, row.getByTestId("sync-request-ask"));
    await expect(page.getByTestId("portals-error")).toContainText(
      "Map at least one patient"
    );

    // Map a patient, then ask again.
    await openManage(page);
    await page.getByTestId("bind-account").selectOption({ label: portal });
    await settledFill(page, page.getByTestId("bind-label"), label);
    await hydratedClick(page, page.getByTestId("bind-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Patient mapped."
    );

    await hydratedClick(page, row.getByTestId("sync-request-ask"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Sync requested."
    );
    // The page shows the ask AND its deadline — a request expires rather than hangs, so
    // the surface that raised it says when it stops mattering.
    await expect(row.getByTestId("sync-request-open")).toContainText(
      "Sync requested"
    );
    await expect(row.getByTestId("sync-request-open")).toContainText("expires");

    // The next reported run answers it. Nothing acknowledges the request and nothing
    // clears a flag — the row simply stops being open once a report is newer than it.
    plantRunReport(portal);
    await page.reload();
    await expect(
      page
        .getByTestId("sync-request-row")
        .filter({ hasText: portal })
        .first() // first-ok: spec-owned row
        .getByTestId("sync-request-open")
    ).toHaveCount(0);

    await removePortal(page, portal);
  });
});

// ── Content-hash document tombstones (#1777) + the inventory endpoint (#1776) ──
//
// The property under test is the one the whole cluster exists for: a document the user
// DELETED must not come back on the next acquirer run. Proving it needs both halves in
// one place — the endpoint a client diffs against, and the refusal that holds even when
// a client ignores it — so this drives the real bearer API alongside the real UI.
//
// FIXTURE OWNERSHIP: every document carries bytes unique to its own test (the stamp is
// inside the file), so its content hash is this test's alone and no assertion here can
// see or disturb another spec's rows.
test.describe("Document tombstones and the held inventory (#1776/#1777)", () => {
  // The profile this browser session is acting as — the one whose Data → Review the
  // blocked list renders, so the API pushes must target exactly it.
  function activeProfileId(): number {
    const handle = new Database(workerDbPath());
    try {
      const row = handle
        .prepare(
          `SELECT s.active_profile_id AS id
             FROM sessions s JOIN logins l ON l.id = s.login_id
            WHERE l.username = 'admin' AND s.active_profile_id IS NOT NULL
            ORDER BY s.last_used_at DESC LIMIT 1`
        )
        .get() as { id: number } | undefined;
      if (row) return row.id;
      return (
        handle.prepare("SELECT MIN(id) AS id FROM profiles").get() as {
          id: number;
        }
      ).id;
    } finally {
      handle.close();
    }
  }

  // A minimal, valid PDF whose bytes are unique to the caller — so its content hash is
  // this test's own fixture identity.
  function pdfBytes(marker: string): Buffer {
    return Buffer.from(`%PDF-1.4\n% allos e2e document ${marker}\n%%EOF\n`);
  }

  test("delete blocks re-acquisition; the inventory says so; allow-again lifts it", async ({
    page,
    request,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-8); // clock-ok: a uniqueness suffix for this spec's own fixture bytes, never a stored timestamp
    const filename = `tombstone-spec-${stamp}.pdf`;
    const body = pdfBytes(stamp);
    const token = await mintToken(page, `tombstone spec ${stamp}`);
    const profileId = activeProfileId();
    const auth = { authorization: `Bearer ${token}` };
    const upload = () =>
      request.post(`/api/documents?profile=${profileId}`, {
        headers: auth,
        multipart: {
          file: { name: filename, mimeType: "application/pdf", buffer: body },
        },
      });
    const inventory = async () => {
      const res = await request.get(
        `/api/documents/held?profile=${profileId}`,
        { headers: auth }
      );
      expect(res.status()).toBe(200);
      return (await res.json()) as { held: string[]; deleted: string[] };
    };

    // 1. The acquirer pushes the document and it stores.
    const first = await upload();
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.documents[0].outcome).toBe("stored");
    const docId = firstBody.documents[0].id as number;

    // 2. The inventory reports it HELD — this is what tells a client not to re-send it.
    //    The hash is the server's to compute; the spec learns it from the answer rather
    //    than re-deriving it, so a client and allos can never disagree here by accident.
    const afterUpload = await inventory();
    // Held and deleted are disjoint by construction, and the endpoint must say so.
    expect(
      afterUpload.held.filter((h) => afterUpload.deleted.includes(h))
    ).toEqual([]);
    const heldBefore = afterUpload.held.length;
    expect(heldBefore).toBeGreaterThan(0);

    // 3. The user deletes it, through the real confirm dialog.
    await page.goto(`/import/${docId}`);
    const del = page.getByTestId("delete-document");
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog.isVisible())) await del.click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 }); // topass-ok: re-open the client confirm until it appears — no Server-Action POST to settle on, and the discrete onClick can be swallowed pre-hydration
    await dialog
      .getByRole("button", { name: "Delete document & its records" })
      .click();
    await page.waitForURL(/\/data/);

    // 4. The inventory has moved it from held to deleted. A client diffing against this
    //    now sends neither — which is the whole contract.
    const afterDelete = await inventory();
    const nowDeleted = afterDelete.deleted.filter(
      (h) => !afterUpload.deleted.includes(h)
    );
    expect(nowDeleted).toHaveLength(1);
    const blockedHash = nowDeleted[0];
    expect(afterDelete.held).not.toContain(blockedHash);
    expect(afterDelete.held).toHaveLength(heldBefore - 1);

    // 5. The acquirer re-offers the very same bytes — the nightly reconciliation a
    //    client that ignored the `deleted` list would perform. It is REFUSED, and no
    //    document row is created, so the document count cannot creep with each attempt.
    const reoffer = await upload();
    expect(reoffer.status()).toBe(200);
    const reofferDoc = (await reoffer.json()).documents[0];
    expect(reofferDoc.outcome).toBe("blocked");
    expect(reofferDoc.id).toBeNull();
    expect(reofferDoc.reason).toContain("deleted in allos");

    // 6. The block is VISIBLE and named, on Data → Review.
    await page.goto("/data?section=review");
    const blockedRow = page
      .getByTestId("blocked-document-row")
      .filter({ hasText: filename })
      .first(); // first-ok: the filename is unique to this test, so this is spec-owned data
    await expect(blockedRow).toBeVisible();

    // 7. …and reversible with one tap. The action revalidates, so the entry LEAVES the
    //    list — the block is gone, and a row still describing one would be stale.
    await hydratedClick(page, blockedRow.getByTestId("allow-reacquisition"));
    await expect(blockedRow).toHaveCount(0);

    // 8. The next offer ingests again — the block is genuinely lifted, not just hidden.
    const afterAllow = await upload();
    const afterAllowDoc = (await afterAllow.json()).documents[0];
    expect(afterAllowDoc.outcome).toBe("stored");

    // Clean up this test's own document so the feed it shares stays as it was found.
    await request.post(`/api/documents?profile=${profileId}`, {
      headers: auth,
      multipart: {
        file: { name: filename, mimeType: "application/pdf", buffer: body },
      },
    });
    const cleanupId = afterAllowDoc.id as number;
    await page.goto(`/import/${cleanupId}`);
    const del2 = page.getByTestId("delete-document");
    const dialog2 = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog2.isVisible())) await del2.click();
      await expect(dialog2).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 }); // topass-ok: same pre-hydration guard as the delete above
    await dialog2
      .getByRole("button", { name: "Delete document & its records" })
      .click();
    await page.waitForURL(/\/data/);
    await page.goto("/data?section=review");
    const leftover = page
      .getByTestId("blocked-document-row")
      .filter({ hasText: filename })
      .first(); // first-ok: spec-owned row
    await hydratedClick(page, leftover.getByTestId("allow-reacquisition"));
    await expect(leftover).toHaveCount(0);
  });

  test("the delete confirm names the tombstone only for a portal-acquired document", async ({
    page,
    request,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-8); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Tombstone Copy Portal ${stamp}`;
    const label = `Tombstone Patient ${stamp}`;
    const token = await mintToken(page, `tombstone copy ${stamp}`);
    const auth = { authorization: `Bearer ${token}` };

    // Register a portal and bind a patient on it to the acting profile, so a push
    // through the IDENTITY form lands a document carrying acquired-by provenance.
    await addPortal(page, portal);
    await page.getByTestId("bind-account").selectOption({ label: portal });
    await settledFill(page, page.getByTestId("bind-label"), label);
    await hydratedClick(page, page.getByTestId("bind-add"));
    await expect(page.getByTestId("portals-status")).toHaveText(
      "Patient mapped."
    );

    const slug = `tombstone-copy-portal-${stamp}`;
    const acquired = await request.post(
      `/api/documents?portal=${slug}&patient=${encodeURIComponent(label)}`,
      {
        headers: auth,
        multipart: {
          file: {
            name: `acquired-${stamp}.pdf`,
            mimeType: "application/pdf",
            buffer: pdfBytes(`acquired-${stamp}`),
          },
        },
      }
    );
    expect(acquired.status()).toBe(200);
    const acquiredDoc = (await acquired.json()).documents[0];
    expect(acquiredDoc.outcome).toBe("stored");

    // A PORTAL-ACQUIRED document's confirm states the consequence: the acquirer will
    // not bring it back, and that is reversible from Data → Review.
    await page.goto(`/import/${acquiredDoc.id}`);
    const del = page.getByTestId("delete-document");
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog.isVisible())) await del.click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 }); // topass-ok: re-open the client confirm until it appears — the discrete onClick can be swallowed pre-hydration
    await expect(dialog.getByTestId("delete-tombstone-note")).toContainText(
      "will not bring this back"
    );
    await expect(dialog.getByTestId("delete-tombstone-note")).toContainText(
      "Data → Review"
    );

    // Go through with it, so the portal fixture can be removed cleanly below.
    await dialog
      .getByRole("button", { name: "Delete document & its records" })
      .click();
    await page.waitForURL(/\/data/);

    // A MANUALLY uploaded document keeps the copy it always had — there is no acquirer
    // to block, so the dialog says nothing about one.
    const manual = await request.post(
      `/api/documents?profile=${activeProfileId()}`,
      {
        headers: auth,
        multipart: {
          file: {
            name: `manual-${stamp}.pdf`,
            mimeType: "application/pdf",
            buffer: pdfBytes(`manual-${stamp}`),
          },
        },
      }
    );
    const manualDoc = (await manual.json()).documents[0];
    await page.goto(`/import/${manualDoc.id}`);
    const del2 = page.getByTestId("delete-document");
    const dialog2 = page.getByRole("dialog");
    await expect(async () => {
      if (!(await dialog2.isVisible())) await del2.click();
      await expect(dialog2).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 }); // topass-ok: same pre-hydration guard as above
    await expect(dialog2).toContainText("every record it imported");
    await expect(dialog2.getByTestId("delete-tombstone-note")).toHaveCount(0);
    await dialog2
      .getByRole("button", { name: "Delete document & its records" })
      .click();
    await page.waitForURL(/\/data/);

    // Remove this spec's own blocked entries and the portal it registered.
    await page.goto("/data?section=review");
    for (const name of [`acquired-${stamp}.pdf`, `manual-${stamp}.pdf`]) {
      const row = page
        .getByTestId("blocked-document-row")
        .filter({ hasText: name })
        .first(); // first-ok: the filename is unique to this test
      await hydratedClick(page, row.getByTestId("allow-reacquisition"));
      await expect(row).toHaveCount(0);
    }
    await page.goto("/integrations/patient-portals");
    await removePortal(page, portal);
  });
});
