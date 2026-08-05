import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledFill } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath, frozenNow } from "./worker-env";
import {
  E2E_LOGIN_PORTAL_A,
  E2E_LOGIN_PORTAL_NONE,
  E2E_MEMBER_PASSWORD,
  PORTAL_B_ACCOUNT,
  PORTAL_B_NAME,
  PORTAL_HOUSEHOLD_A_PROFILE,
} from "./fixture-logins";

// The Patient portals page (#1739, reshaped by #1826, re-reshaped by #1874): the
// portal → login → patient OBJECT MODEL rendered as permanent card-sections, with
// avatar chips as the mapping picker in both directions, the stage machine reduced to a
// checklist, and every outcome reported inline on the acted-on row (aria-live) — the
// Manage drawer and the page-bottom status line are gone.
//
// The assertion that matters most is still the REFUSAL of a URL. A portal is recorded by
// name only — allos owns the portal's identity, the companion tool owns its address — and
// that is what stops a compromised record from aiming an attended browser tool at a login
// form an attacker controls. The schema has no address column; this proves the one
// free-text field where one could be typed refuses it too.
//
// FIXTURE OWNERSHIP: every portal this spec creates carries a unique NAME, every patient
// label is unique to its test, and each test removes what it adds. Rows are addressed by
// their data-label / data-portal-name attributes — NEVER by row-scoped hasText, because
// the household's profile names render inside every row's chip picker and a name filter
// would match the wrong rows (the selector trap from the #1874 surface walk).

function sectionFor(page: Page, name: string): Locator {
  return page.locator(
    `[data-testid="portal-section"][data-portal-name="${name}"]`
  );
}

function pendingRowFor(page: Page, label: string): Locator {
  return page.locator(`[data-testid="pending-row"][data-label="${label}"]`);
}

function patientRowFor(page: Page, label: string): Locator {
  return page.locator(
    `[data-testid="portal-patient-row"][data-label="${label}"]`
  );
}

// Open one row's ⋯ menu, addressed by the trigger's accessible name — a portal section
// also contains its logins' triggers, so "the button in this row" is not unique.
async function openRowMenu(
  page: Page,
  scope: Locator,
  subject: string
): Promise<void> {
  await hydratedClick(
    page,
    scope.getByRole("button", { name: `Actions for ${subject}` })
  );
}

// The menu panel is portaled to <body> and only one menu is ever open, so a menu entry
// is addressed at page level rather than inside the row it belongs to.
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

// Register a portal through the ONE inline affordance (#1874 point 7): the ＋ toggle
// when the sections are up, or the pre-expanded guide/step-1 form on first contact.
// Success is asserted as the spec defines it — the portal section materializes in place.
async function addPortal(
  page: Page,
  name: string,
  softwareChip?: string
): Promise<void> {
  await page.goto("/integrations/patient-portals");
  const toggle = page.getByTestId("portal-add-toggle");
  if (await toggle.isVisible()) await hydratedClick(page, toggle);
  await settledFill(page, page.getByTestId("portal-name"), name);
  if (softwareChip) {
    await hydratedClick(
      page,
      page.getByTestId(`software-chip-${softwareChip}`)
    );
  }
  await hydratedClick(page, page.getByTestId("portal-add"));
  await expect(sectionFor(page, name)).toBeVisible();
}

async function removePortal(page: Page, name: string): Promise<void> {
  const section = sectionFor(page, name);
  await openRowMenu(page, section, name);
  await (await menuItem(page, "portal-remove")).click();
  await confirmWith(page, "Remove portal");
  await expect(section).toHaveCount(0);
}

// Choose a household chip inside one picker and return the profile name it carries —
// the round-trip assertions compare against exactly this name.
async function chooseChip(page: Page, scope: Locator): Promise<string> {
  const chip = scope.getByTestId("profile-chip").first(); // first-ok: any household chip works — the assertion is the round-trip against this SAME chip's name
  const name = (await chip.getByTestId("profile-chip-name").innerText()).trim();
  await hydratedClick(page, chip);
  return name;
}

// Pre-bind a label by hand on a portal's (only) login — the labelled escape hatch.
async function prebind(
  page: Page,
  portalName: string,
  label: string,
  profileName?: string
): Promise<string> {
  const section = sectionFor(page, portalName);
  await hydratedClick(page, section.getByTestId("prebind-toggle"));
  await settledFill(page, section.getByTestId("bind-label"), label);
  let chosen: string;
  if (profileName) {
    await hydratedClick(
      page,
      section
        .getByTestId("profile-picker")
        .getByRole("button", { name: profileName })
    );
    chosen = profileName;
  } else {
    chosen = await chooseChip(page, section.getByTestId("profile-picker"));
  }
  await hydratedClick(page, section.getByTestId("bind-add"));
  await expect(patientRowFor(page, label)).toBeVisible();
  return chosen;
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

function withDb<T>(fn: (db: Database.Database) => T): T {
  const handle = new Database(workerDbPath());
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

// Plant a pending row directly: the route that writes one needs a bearer token and a
// JSON run report, which is the API's own DB-tier territory. What this spec owns is what
// the PAGE does with a pending row once one exists. `accountName` picks a named login;
// omitted, the portal's implicit (and usually only) login takes it.
function plantPending(
  portalName: string,
  label: string,
  outcome: string,
  accountName?: string
) {
  withDb((handle) => {
    const portal = handle
      .prepare("SELECT id FROM portals WHERE name = ?")
      .get(portalName) as { id: number };
    const account = (
      accountName
        ? handle
            .prepare(
              "SELECT id FROM portal_accounts WHERE portal_id = ? AND name = ?"
            )
            .get(portal.id, accountName)
        : handle
            .prepare("SELECT id FROM portal_accounts WHERE portal_id = ?")
            .get(portal.id)
    ) as { id: number };
    handle
      .prepare(
        `INSERT INTO pending_portal_identities
           (portal_id, account_id, patient_label, first_seen_at, last_seen_at, seen_count, last_outcome)
         VALUES (?, ?, ?, '2026-01-02 03:04:05', '2026-01-03 03:04:05', 2, ?)`
      )
      .run(portal.id, account.id, label, outcome);
  });
}

// A run report for the caller's own portal. It goes away with the portal, so a test that
// removes what it added leaves no report behind for a neighbour to trip over.
//
// `at` defaults to the run's frozen instant — the newest a report can be. A caller that
// needs a request raised AFTERWARDS to read as open must pass an older stamp, because a
// report at or after a request's creation is what ANSWERS it (lib/sync-requests.ts).
function plantRunReport(portalName: string, at?: string) {
  withDb((handle) => {
    const portal = handle
      .prepare("SELECT id FROM portals WHERE name = ?")
      .get(portalName) as { id: number };
    const account = handle
      .prepare("SELECT id FROM portal_accounts WHERE portal_id = ?")
      .get(portal.id) as { id: number };
    const stamp =
      at ?? frozenNow().toISOString().replace("T", " ").slice(0, 19);
    // The CHECK CLOCK moves with the stamp (#1888). A real report writes `at` and its
    // two clock columns together — `checked_at` is what answers an open request and
    // `checked_ok_at` is what the staleness cadence reads — so a planted row that set
    // only `at` would describe a run no client could ever report.
    handle
      .prepare(
        `INSERT INTO portal_run_reports
           (account_id, portal_id, at, ok, status, message, discovered,
            checked_at, checked_ok_at)
         VALUES (?, ?, ?, 1, 'nothing-new', NULL, 0, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET at = excluded.at, ok = 1,
           checked_at = excluded.checked_at,
           checked_ok_at = excluded.checked_ok_at`
      )
      .run(account.id, portal.id, stamp, stamp, stamp);
  });
}

test.describe("Patient portals — the portal sections (#1874)", () => {
  test("adding a portal materializes its section in place, waiting for its first run", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Spec Portal ${stamp}`;
    const label = `Spec Patient ${stamp}`;

    // 1. Register the portal. There is NO slug field and NO login field — allos mints
    //    the key from the name, and "Add a login" lives in the portal ⋯ for the
    //    two-signers case.
    await addPortal(page, portal);
    const section = sectionFor(page, portal);
    // Creation names the next PHYSICAL step instead of jumping scenes.
    await expect(section.getByTestId("portal-waiting")).toContainText(
      `start the companion tool on the computer that signs in to ${portal}`
    );
    // A one-login portal IS its login: no login sub-groups, no "Default login".
    await expect(section.getByTestId("portal-login-group")).toHaveCount(0);
    await expect(section).not.toContainText("Default login");

    // 2. Pre-bind a patient by hand — the labelled escape hatch, chip-picked with no
    //    preselection (bind-add is dead until a face is tapped).
    await hydratedClick(page, section.getByTestId("prebind-toggle"));
    await expect(section).toContainText("a guess is refused, not corrected");
    await settledFill(page, section.getByTestId("bind-label"), label);
    await expect(section.getByTestId("bind-add")).toBeDisabled();
    const chosen = await chooseChip(
      page,
      section.getByTestId("profile-picker")
    );
    await expect(section.getByTestId("bind-add")).toBeEnabled();
    await hydratedClick(page, section.getByTestId("bind-add"));

    // 3. The mapping renders as label → ⟨avatar chip⟩, with inline feedback on the
    //    acted-on group — there is no page-bottom status line to look at.
    const row = patientRowFor(page, label);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("patient-chip")).toContainText(chosen);
    await expect(
      section.getByTestId("row-note").filter({ hasText: "✓ Mapped" })
    ).toBeVisible();

    // …and it survives a reload (it is persisted, not optimistic).
    await page.reload();
    await expect(patientRowFor(page, label)).toHaveCount(1);

    // 4. Clean up: removing the portal takes its binding with it.
    await removePortal(page, portal);
    await expect(patientRowFor(page, label)).toHaveCount(0);
  });

  test("a fresh portal offers the login layer, and stops once a second one exists (#1930)", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Login Prompt ${stamp}`;

    await addPortal(page, portal);
    const section = sectionFor(page, portal);

    // THE MIDDLE LAYER HAS A PRESENCE (#1930). A fresh portal has exactly one login —
    // the implicit one, which never surfaces — so the card used to render no login at
    // all, and its only affordance was a ⋯ entry nobody had a reason to open. The
    // prompt sits beside the waiting text, and the rule for WHEN you want one is out
    // here rather than inside the form it opens.
    const prompt = section.getByTestId("portal-login-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(
      `Only if two people sign in to ${portal} with their own accounts`
    );
    // ORDER IS THE POINT: the ask has to land before the run that freezes the name.
    await expect(prompt).toContainText("before");
    // Still no row for the implicit login — this prompts about adding a SECOND, and
    // "Default login" continues to surface nowhere.
    await expect(section.getByTestId("portal-login-group")).toHaveCount(0);
    await expect(section).not.toContainText("Default login");

    // The ⋯ entry STAYS — an affordance was added, not moved — and both routes open the
    // same form. While that form is open the prompt stands down, so the rule is never
    // on screen twice.
    await openRowMenu(page, section, portal);
    await (await menuItem(page, "portal-add-login")).click();
    await expect(section.getByTestId("portal-add-login-cta")).toHaveCount(0);
    await hydratedClick(page, section.getByTestId("account-add-cancel"));

    await hydratedClick(page, section.getByTestId("portal-add-login-cta"));
    // The form now says what the name IS: the key the companion tool quotes.
    await expect(section.getByTestId("account-name-note")).toContainText(
      "name it once and leave it"
    );
    await settledFill(page, section.getByTestId("account-name"), "Mom");
    await hydratedClick(page, section.getByTestId("account-add"));

    // Two logins: the titled sub-groups take over, and the prompt is finished — a
    // household that has named a login has met the concept.
    await expect(section.getByTestId("portal-login-group")).toHaveCount(2);
    await expect(section.getByTestId("portal-login-prompt")).toHaveCount(0);

    await removePortal(page, portal);
  });

  test("a portal refuses a web address in its name, inline on the form", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/integrations/patient-portals");
    const toggle = page.getByTestId("portal-add-toggle");
    if (await toggle.isVisible()) await hydratedClick(page, toggle);
    await settledFill(
      page,
      page.getByTestId("portal-name"),
      "https://mychart.example.org/login"
    );
    await hydratedClick(page, page.getByTestId("portal-add"));

    // Refused, with the reason stated beside the field it refuses.
    await expect(
      page
        .getByTestId("portal-add-form")
        .getByTestId("row-note")
        .filter({ hasText: "never a web address" })
    ).toBeVisible();
    // And nothing was stored.
    await expect(
      page.locator(
        '[data-testid="portal-section"][data-portal-name*="mychart.example.org"]'
      )
    ).toHaveCount(0);
  });

  test("software is chips at creation and editable from the portal ⋯ afterwards (#1836)", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Software Portal ${stamp}`;

    // eClinicalWorks is a first-class chip (#1836's ecw enum addition).
    await addPortal(page, portal, "ecw");
    const section = sectionFor(page, portal);
    await expect(section.getByTestId("portal-software-tag")).toHaveText(
      "eClinicalWorks"
    );

    // Edit it after creation — the ⋯ opens the same chips.
    await openRowMenu(page, section, portal);
    await (await menuItem(page, "portal-software-edit")).click();
    await hydratedClick(page, section.getByTestId("software-chip-generic-ccd"));
    await hydratedClick(page, section.getByTestId("portal-software-save"));
    await expect(
      section.getByTestId("row-note").filter({ hasText: "✓ Saved" })
    ).toBeVisible();
    await expect(section.getByTestId("portal-software-tag")).toHaveText(
      "Something else"
    );

    await removePortal(page, portal);
  });

  test("renaming a portal from its ⋯ keeps every mapping in place", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Typo Portal ${stamp}`;
    const fixed = `Fixed Portal ${stamp}`;
    const label = `Typo Patient ${stamp}`;

    await addPortal(page, portal);
    await prebind(page, portal, label);

    const section = sectionFor(page, portal);
    await openRowMenu(page, section, portal);
    await (await menuItem(page, "portal-rename")).click();
    await settledFill(page, section.getByTestId("portal-rename-input"), fixed);
    await hydratedClick(page, section.getByTestId("portal-rename-save"));

    const renamed = sectionFor(page, fixed);
    await expect(renamed).toBeVisible();
    await expect(
      renamed.getByTestId("row-note").filter({ hasText: "✓ Renamed" })
    ).toBeVisible();
    await expect(sectionFor(page, portal)).toHaveCount(0);
    // The mapping rode along — a rename touches the display name only; the slug every
    // tool config quotes never moves (that is the whole point of minting it).
    await expect(patientRowFor(page, label)).toBeVisible();

    await removePortal(page, fixed);
  });

  test("a second login turns the portal into titled sub-groups that keep identical labels apart", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Two Logins ${stamp}`;
    const label = `SHARED, LABEL ${stamp}`;

    await addPortal(page, portal);
    const section = sectionFor(page, portal);

    // "Add a login" lives in the portal ⋯ — there is no login field on the add form.
    await openRowMenu(page, section, portal);
    await (await menuItem(page, "portal-add-login")).click();
    await settledFill(page, section.getByTestId("account-name"), "Mom");
    await hydratedClick(page, section.getByTestId("account-add"));

    // Two logins now: BOTH render as titled sub-groups inside the portal.
    await expect(section.getByTestId("portal-login-group")).toHaveCount(2);
    const momGroup = section.locator(
      '[data-testid="portal-login-group"][data-login-name="Mom"]'
    );
    const firstGroup = section.locator(
      '[data-testid="portal-login-group"]:not([data-login-name="Mom"])'
    );
    await expect(momGroup).toBeVisible();

    // The SAME label under both logins — two different people, two rows. Pre-bind
    // through each group's own escape hatch.
    for (const group of [firstGroup, momGroup]) {
      await hydratedClick(page, group.getByTestId("prebind-toggle"));
      await settledFill(page, group.getByTestId("bind-label"), label);
      await chooseChip(page, group.getByTestId("profile-picker"));
      await hydratedClick(page, group.getByTestId("bind-add"));
      await expect(
        group.locator(
          `[data-testid="portal-patient-row"][data-label="${label}"]`
        )
      ).toHaveCount(1);
    }
    // Two rows, not one — the collapse a two-part key would have caused.
    await expect(patientRowFor(page, label)).toHaveCount(2);

    // Login rename lives in the login ⋯, and an email-shaped name is VALID (#1829).
    await openRowMenu(page, momGroup, "Mom");
    await (await menuItem(page, "account-rename")).click();
    await settledFill(
      page,
      section.getByTestId("account-rename-input"),
      "mom@example.com"
    );
    await hydratedClick(page, section.getByTestId("account-rename-save"));
    await expect(
      section.locator(
        '[data-testid="portal-login-group"][data-login-name="mom@example.com"]'
      )
    ).toBeVisible();

    await removePortal(page, portal);
  });
});

// THE CHECKLIST (#1874 point 1). The stage machine renders as guidance ABOVE the
// structure, never instead of it: the five-step guide before the first run, the compact
// strip while patients wait, nothing at steady state. One test walks the transitions a
// shared worker database can express, so every fact it depends on is one it planted.
// ("create-token" stays pinned in the pure tier: whether a live upload token exists is
// instance-global state other specs mint into and never revoke. The pre-expanded
// step-1 form of a truly EMPTY admin registry is likewise pure-tier territory — the
// shared seed always carries a portal.)
test.describe("Patient portals — checklist and mapping (#1874)", () => {
  test("guide → strip → steady, with the avatar-chip mapping round-trip", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Stage Walk ${stamp}`;
    const label = `Stage Patient ${stamp}`;

    await addPortal(page, portal);
    await mintToken(page, `stage walk ${stamp}`);

    // BEFORE THE FIRST RUN: the unrolled five-step guide renders BELOW the sections —
    // the portal materialized above it (progression, not a scene change) — with step 1
    // done and the later steps previewing where the token and the tool come from.
    await page.goto("/integrations/patient-portals");
    const guide = page.getByTestId("portal-guide");
    await expect(guide).toBeVisible();
    await expect(page.getByTestId("guide-step-1")).toHaveAttribute(
      "data-state",
      "done"
    );
    await expect(page.getByTestId("guide-token-link")).toBeVisible();
    // The page finally says where the companion tool comes from.
    await expect(page.getByTestId("guide-tool-link")).toBeVisible();
    // …and it names the LOGIN before the run that freezes it (#1930). The mention is
    // folded into step 3 rather than made a step of its own: a login is optional by
    // design, and a numbered step is a thing you owe.
    await expect(page.getByTestId("guide-login-note")).toBeVisible();
    await expect(page.getByTestId("guide-step-3")).toContainText(
      "add each login above"
    );
    await expect(sectionFor(page, portal)).toBeVisible();
    // No compact strip while the guide is the checklist's rendering.
    await expect(page.getByTestId("portal-checklist")).toHaveCount(0);

    // A RUN REPORTED, NOTHING PENDING: steady state — guide and strip both gone, and
    // the login's own status line answers instead of a page-level sentence.
    plantRunReport(portal);
    await page.reload();
    await expect(page.getByTestId("portal-guide")).toHaveCount(0);
    await expect(page.getByTestId("portal-checklist")).toHaveCount(0);
    const section = sectionFor(page, portal);
    await expect(section.getByTestId("login-status")).toContainText("Last run");

    // A PATIENT WAITS: the compact strip appears above the sections, counting it.
    plantPending(portal, label, "discovered");
    await page.reload();
    const strip = page.getByTestId("portal-checklist");
    await expect(strip).toBeVisible();
    await expect(strip.getByTestId("checklist-portal")).toHaveAttribute(
      "data-done",
      "true"
    );
    await expect(strip.getByTestId("checklist-token")).toHaveAttribute(
      "data-done",
      "true"
    );
    await expect(strip.getByTestId("checklist-first-run")).toHaveAttribute(
      "data-done",
      "true"
    );
    await expect(strip.getByTestId("checklist-map")).toContainText(
      "1 patient to map"
    );

    // THE PENDING ROW: amber, under its portal, with the household's faces as the
    // picker. Map is dead until a face is tapped — no preselection anywhere.
    const pending = pendingRowFor(page, label);
    await expect(pending).toBeVisible();
    await expect(pending).toContainText("first seen 2026-01-02");
    await expect(pending).toContainText("seen 2×");
    await expect(pending.getByTestId("pending-map")).toBeDisabled();
    const chosen = await chooseChip(
      page,
      pending.getByTestId("profile-picker")
    );
    await expect(pending.getByTestId("pending-map")).toBeEnabled();
    await hydratedClick(page, pending.getByTestId("pending-map"));

    // Inline feedback on the acted-on group; the row itself became the mapping.
    await expect(
      section.getByTestId("row-note").filter({ hasText: "✓ Mapped" })
    ).toBeVisible();
    await expect(pendingRowFor(page, label)).toHaveCount(0);
    const mapped = patientRowFor(page, label);
    await expect(mapped).toBeVisible();
    await expect(mapped.getByTestId("patient-chip")).toContainText(chosen);
    // Steady again: the strip is gone — a finished checklist is clutter.
    await expect(page.getByTestId("portal-checklist")).toHaveCount(0);
    // Per-patient "Last checked" lives on the row (the planted run belongs to the
    // login, not to this patient, so this row honestly says it was never checked).
    await expect(mapped.getByTestId("portal-patient-status")).toContainText(
      "Not checked yet"
    );

    await removePortal(page, portal);
  });

  test("tapping a mapped row's chip re-opens the picker and saves one atomic re-map (#1836)", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Remap Portal ${stamp}`;
    const label = `Remap Patient ${stamp}`;

    await addPortal(page, portal);
    const from = await prebind(page, portal, label);

    const row = patientRowFor(page, label);
    await hydratedClick(page, row.getByTestId("patient-chip"));
    const picker = row.getByTestId("profile-picker");
    await expect(picker).toBeVisible();
    // The picker opens with the CURRENT profile pressed…
    await expect(
      picker.getByRole("button", { name: from, pressed: true })
    ).toBeVisible();
    // …and Save is dead until the choice actually changes.
    await expect(row.getByTestId("remap-save")).toBeDisabled();

    // Choose a different household member.
    const other = picker
      .getByTestId("profile-chip")
      .filter({ hasNotText: from })
      .first(); // first-ok: any OTHER household chip works — the assertion is the round-trip against this SAME chip's name
    const to = (
      await other.getByTestId("profile-chip-name").innerText()
    ).trim();
    await hydratedClick(page, other);
    await hydratedClick(page, row.getByTestId("remap-save"));

    // One compare-and-swap re-points the row; feedback lands on the row itself.
    await expect(
      row.getByTestId("row-note").filter({ hasText: "✓ Profile changed" })
    ).toBeVisible();
    await expect(row.getByTestId("patient-chip")).toContainText(to);
    await page.reload();
    await expect(
      patientRowFor(page, label).getByTestId("patient-chip")
    ).toContainText(to);

    await removePortal(page, portal);
  });

  test("a pending label already mapped on another login offers the one-tap same-person assist", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Assist Portal ${stamp}`;
    const labelOne = `ASSIST, ONE ${stamp}`;
    const labelTwo = `ASSIST, TWO ${stamp}`;

    await addPortal(page, portal);
    const section = sectionFor(page, portal);
    await openRowMenu(page, section, portal);
    await (await menuItem(page, "portal-add-login")).click();
    await settledFill(page, section.getByTestId("account-name"), "Dana");
    await hydratedClick(page, section.getByTestId("account-add"));
    await expect(section.getByTestId("portal-login-group")).toHaveCount(2);

    // Map both labels on the OTHER login (the one that is not Dana's).
    const firstGroup = section.locator(
      '[data-testid="portal-login-group"]:not([data-login-name="Dana"])'
    );
    await hydratedClick(page, firstGroup.getByTestId("prebind-toggle"));
    await settledFill(page, firstGroup.getByTestId("bind-label"), labelOne);
    const person = await chooseChip(
      page,
      firstGroup.getByTestId("profile-picker")
    );
    await hydratedClick(page, firstGroup.getByTestId("bind-add"));
    await expect(patientRowFor(page, labelOne)).toHaveCount(1);
    await hydratedClick(page, firstGroup.getByTestId("prebind-toggle"));
    await settledFill(page, firstGroup.getByTestId("bind-label"), labelTwo);
    await hydratedClick(
      page,
      firstGroup
        .getByTestId("profile-picker")
        .getByRole("button", { name: person })
    );
    await hydratedClick(page, firstGroup.getByTestId("bind-add"));
    await expect(patientRowFor(page, labelTwo)).toHaveCount(1);

    // The tool now reports the SAME two labels on Dana's login — the state that used
    // to read as a duplicate bug.
    plantPending(portal, labelOne, "discovered", "Dana");
    plantPending(portal, labelTwo, "discovered", "Dana");
    await page.reload();

    // Row one: the dashed suggest-only pill names the person and where they are
    // already mapped; one tap maps them.
    const rowOne = pendingRowFor(page, labelOne);
    const pillOne = rowOne.getByTestId("assist-pill");
    await expect(pillOne).toBeVisible();
    await expect(pillOne).toContainText(person);
    await expect(pillOne).toContainText("same name is mapped on");
    await hydratedClick(page, pillOne.getByTestId("assist-map"));
    await expect(pendingRowFor(page, labelOne)).toHaveCount(0);
    await expect(patientRowFor(page, labelOne)).toHaveCount(2);

    // Row two: "Someone else…" declines the suggestion and opens the full picker,
    // with nothing preselected.
    const rowTwo = pendingRowFor(page, labelTwo);
    await hydratedClick(
      page,
      rowTwo.getByTestId("assist-pill").getByTestId("assist-someone-else")
    );
    await expect(rowTwo.getByTestId("assist-pill")).toHaveCount(0);
    await expect(rowTwo.getByTestId("pending-map")).toBeDisabled();
    await hydratedClick(
      page,
      rowTwo.getByTestId("profile-picker").getByRole("button", { name: person })
    );
    await hydratedClick(page, rowTwo.getByTestId("pending-map"));
    await expect(patientRowFor(page, labelTwo)).toHaveCount(2);

    await removePortal(page, portal);
  });
});

// PENDING MAINTENANCE VERBS (#1874 point 5): Ignore and Not now are ⋯ entries, not
// co-equal CTAs beside Map — and Ignore, the durable one, confirms and is admin-only
// (#1875; the member half is proven in the member-view suite below).
test.describe("Patient portals — ignore and dismiss (#1739)", () => {
  test("ignoring from the ⋯ records a binding that points nowhere, reversibly", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Ignore Portal ${stamp}`;
    const label = `Ignore Patient ${stamp}`;

    await addPortal(page, portal);
    plantPending(portal, label, "unmapped-sync-report");
    await page.reload();

    const pending = pendingRowFor(page, label);
    await expect(pending).toBeVisible();
    await openRowMenu(page, pending, label);
    await (await menuItem(page, "pending-ignore")).click();
    // Durable, so it confirms — and the copy states the admin-only gate (#1875).
    await expect(page.getByTestId("confirm-dialog")).toContainText(
      "until an admin stops ignoring them"
    );
    await confirmWith(page, "Ignore patient");

    // Gone from the prompts, present as a binding that syncs nothing — the difference
    // between "not now" and "not ever" stays visible on the page.
    const section = sectionFor(page, portal);
    await expect(
      section.getByTestId("row-note").filter({ hasText: "Patient ignored" })
    ).toBeVisible();
    await expect(pendingRowFor(page, label)).toHaveCount(0);
    const ignored = patientRowFor(page, label);
    await expect(ignored.getByTestId("portal-identity-ignored")).toHaveText(
      "not synced (ignored)"
    );

    // AND IT IS REVERSIBLE: "never sync this person" is not a one-way door.
    await openRowMenu(page, ignored, label);
    await (await menuItem(page, "portal-identity-unignore")).click();
    await expect(
      section.getByTestId("row-note").filter({ hasText: "No longer ignored" })
    ).toBeVisible();
    await expect(patientRowFor(page, label)).toHaveCount(0);

    await removePortal(page, portal);
  });

  test("Not now clears the prompt without binding anything", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Dismiss Portal ${stamp}`;
    const label = `Dismiss Patient ${stamp}`;

    await addPortal(page, portal);
    plantPending(portal, label, "discovered");
    await page.reload();

    const pending = pendingRowFor(page, label);
    await expect(pending).toBeVisible();
    await openRowMenu(page, pending, label);
    await (await menuItem(page, "pending-dismiss")).click();

    await expect(
      sectionFor(page, portal)
        .getByTestId("row-note")
        .filter({ hasText: "Cleared for now." })
    ).toBeVisible();
    await expect(pendingRowFor(page, label)).toHaveCount(0);
    // Dismissing is NOT binding and NOT ignoring: nothing was recorded.
    await expect(patientRowFor(page, label)).toHaveCount(0);

    await removePortal(page, portal);
  });

  // SYNC REQUESTS (#1757). Allos cannot run a portal sync, so each login row offers
  // "Request sync" — asking the person whose machine holds the login. The open ask
  // replaces the button, shows its expiry, and clears itself when a run reports.
  test("Request sync on the login row: refusal, open ask, and self-clearing", async ({
    page,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Request Portal ${stamp}`;
    const label = `Request Patient ${stamp}`;

    await addPortal(page, portal);
    // An OLD run, so the request raised below stays open — a report at or after a
    // request's creation is what answers it.
    plantRunReport(portal, "2026-01-05 09:00:00");
    await page.reload();

    const section = sectionFor(page, portal);
    // A login with no mapped patient can be asked, and the refusal says why — a nudge
    // there would have nobody to reach. Typed outcome, rendered inline.
    await hydratedClick(page, section.getByTestId("sync-request-ask"));
    await expect(
      section
        .getByTestId("row-note")
        .filter({ hasText: "Map at least one patient" })
    ).toBeVisible();

    await prebind(page, portal, label);
    await hydratedClick(page, section.getByTestId("sync-request-ask"));
    // The ask AND its deadline — a request expires rather than hangs.
    const open = section.getByTestId("sync-request-open");
    await expect(open).toContainText("Sync requested");
    await expect(open).toContainText("expires");

    // The next reported run answers it; nothing acknowledges anything.
    plantRunReport(portal);
    await page.reload();
    await expect(
      sectionFor(page, portal).getByTestId("sync-request-open")
    ).toHaveCount(0);

    await removePortal(page, portal);
  });
});

// MEMBER VIEW (#1874 point 11, with #1875). Members see only logins covering profiles
// they can access, under a scope note; portal management and durable Ignore are
// admin-only; member × empty is a promise, not a dead end. The seeded two-household
// fixture (e2e/seed/portals.ts) provides the negative: household B's portal is claimed
// only by B's profile, so it must be INVISIBLE to household A's member in full —
// stronger than #1787's message-scoping, because unclaimed accounts are admin-only now.
test.describe("Patient portals — member view (#1874/#1875)", () => {
  test("a caregiver sees only covering logins, cannot manage portals, cannot durably Ignore", async ({
    browser,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Member Scope Portal ${stamp}`;
    const boundLabel = `MEMBER, BOUND ${stamp}`;
    const pendingLabel = `MEMBER, PENDING ${stamp}`;

    // A portal claimed by household A's profile, with one pending on the same login —
    // planted directly (registry writes are admin-only by design).
    const cleanup = withDb((db) => {
      const profileA = (
        db
          .prepare("SELECT id FROM profiles WHERE name = ?")
          .get(PORTAL_HOUSEHOLD_A_PROFILE) as { id: number }
      ).id;
      const portalId = Number(
        db
          .prepare(
            "INSERT INTO portals (slug, name, created_at) VALUES (?, ?, datetime('now'))"
          )
          .run(`member-scope-portal-${stamp}`, portal).lastInsertRowid
      );
      const accountId = Number(
        db
          .prepare(
            `INSERT INTO portal_accounts (portal_id, slug, name, implicit, created_at)
             VALUES (?, 'default', 'Default login', 1, datetime('now'))`
          )
          .run(portalId).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO portal_identities
           (portal_id, account_id, patient_label, profile_id, ignored, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      ).run(portalId, accountId, boundLabel, profileA);
      db.prepare(
        `INSERT INTO pending_portal_identities
           (portal_id, account_id, patient_label, first_seen_at, last_seen_at, seen_count, last_outcome)
         VALUES (?, ?, ?, '2026-01-02 03:04:05', '2026-01-03 03:04:05', 1, 'discovered')`
      ).run(portalId, accountId, pendingLabel);
      return { portalId };
    });

    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_A,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");

      // Scope, stated once, in the member's terms.
      await expect(member.getByTestId("portals-scope-note")).toContainText(
        `You're seeing the logins that cover ${PORTAL_HOUSEHOLD_A_PROFILE}`
      );

      // The covering login's portal renders, with its mapping and its pending.
      await expect(
        member.locator(
          `[data-testid="portal-section"][data-portal-name="${portal}"]`
        )
      ).toBeVisible();
      await expect(
        member.locator(
          `[data-testid="portal-patient-row"][data-label="${boundLabel}"]`
        )
      ).toBeVisible();
      const pending = member.locator(
        `[data-testid="pending-row"][data-label="${pendingLabel}"]`
      );
      await expect(pending).toBeVisible();

      // Household B's portal is claimed by a profile this member cannot reach: not a
      // trace of it — name, login nickname, or patient — reaches this page (#1875
      // closed the unclaimed side too, so the whole section is gone, not just its
      // failure text as in #1787).
      await expect(member.locator("body")).not.toContainText(PORTAL_B_NAME);
      await expect(member.locator("body")).not.toContainText(PORTAL_B_ACCOUNT);

      // Portal management is admin-only: no add affordance, no portal ⋯ menu.
      await expect(member.getByTestId("portal-add-toggle")).toHaveCount(0);
      await expect(member.getByTestId("portal-name")).toHaveCount(0);
      await expect(
        member.getByRole("button", { name: `Actions for ${portal}` })
      ).toHaveCount(0);

      // The pending row's ⋯ offers "Not now" but never the durable Ignore (#1875).
      await hydratedClick(
        member,
        pending.getByRole("button", { name: `Actions for ${pendingLabel}` })
      );
      await expect(member.getByTestId("pending-dismiss")).toBeVisible();
      await expect(member.getByTestId("pending-ignore")).toHaveCount(0);
      await member.keyboard.press("Escape");

      // …and the member can still finish their own mapping: the chip picker offers
      // exactly the profile they may write, and Map works.
      await expect(pending.getByTestId("profile-chip")).toHaveCount(1);
      await hydratedClick(
        member,
        pending
          .getByTestId("profile-picker")
          .getByRole("button", { name: PORTAL_HOUSEHOLD_A_PROFILE })
      );
      await hydratedClick(member, pending.getByTestId("pending-map"));
      await expect(
        member.locator(
          `[data-testid="pending-row"][data-label="${pendingLabel}"]`
        )
      ).toHaveCount(0);
      await expect(
        member.locator(
          `[data-testid="portal-patient-row"][data-label="${pendingLabel}"]`
        )
      ).toBeVisible();
    } finally {
      await member.context().close();
      withDb((db) => {
        db.prepare("DELETE FROM portal_identities WHERE portal_id = ?").run(
          cleanup.portalId
        );
        db.prepare(
          "DELETE FROM pending_portal_identities WHERE portal_id = ?"
        ).run(cleanup.portalId);
        db.prepare("DELETE FROM portal_accounts WHERE portal_id = ?").run(
          cleanup.portalId
        );
        db.prepare("DELETE FROM portals WHERE id = ?").run(cleanup.portalId);
      });
    }
  });

  test("a member with no covering login gets the promise, not a dead end", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_NONE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");
      const empty = member.getByTestId("portals-member-empty");
      await expect(empty).toContainText(
        "an admin on this instance can add one"
      );
      await expect(empty).toContainText(PORTAL_HOUSEHOLD_A_PROFILE);
      // No sections, no forms, no checklist — nothing here is theirs yet.
      await expect(member.getByTestId("portal-section")).toHaveCount(0);
      await expect(member.getByTestId("portal-name")).toHaveCount(0);
      await expect(member.getByTestId("portal-checklist")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
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
  function activeProfile(): { id: number; name: string } {
    return withDb((handle) => {
      const row = handle
        .prepare(
          `SELECT s.active_profile_id AS id
             FROM sessions s JOIN logins l ON l.id = s.login_id
            WHERE l.username = 'admin' AND s.active_profile_id IS NOT NULL
            ORDER BY s.last_used_at DESC LIMIT 1`
        )
        .get() as { id: number } | undefined;
      const id = row
        ? row.id
        : (
            handle.prepare("SELECT MIN(id) AS id FROM profiles").get() as {
              id: number;
            }
          ).id;
      const name = (
        handle.prepare("SELECT name FROM profiles WHERE id = ?").get(id) as {
          name: string;
        }
      ).name;
      return { id, name };
    });
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
    const profileId = activeProfile().id;
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
    const acting = activeProfile();

    // Register a portal and bind a patient on it to the acting profile, so a push
    // through the IDENTITY form lands a document carrying acquired-by provenance.
    await addPortal(page, portal);
    await prebind(page, portal, label, acting.name);

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
    const manual = await request.post(`/api/documents?profile=${acting.id}`, {
      headers: auth,
      multipart: {
        file: {
          name: `manual-${stamp}.pdf`,
          mimeType: "application/pdf",
          buffer: pdfBytes(`manual-${stamp}`),
        },
      },
    });
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

// THE QUIET DECLINED NOTE (#1889). A portal that offers a proxy a preview with no
// Download button is a settled answer, not a fault — so it is said ONCE, on that
// patient's own row, and the other patient on the SAME login says nothing. That
// per-identity grain is the whole ruling: one run downloads the account holder's records
// and is refused the proxies, and no run-level word can express it.
//
// FIXTURE OWNERSHIP: this test plants its own portal, login and two patients, addresses
// rows by data-label, and removes everything it added.
test.describe("Patient portals — the portal declines one patient (#1889)", () => {
  test("says so once, quietly, on that patient's row only", async ({
    browser,
  }) => {
    test.slow();
    const stamp = String(Date.now()).slice(-6); // clock-ok: a uniqueness suffix for this spec's own fixture rows, never a stored timestamp
    const portal = `Declined Portal ${stamp}`;
    const holderLabel = `DECLINED, HOLDER ${stamp}`;
    const proxyLabel = `DECLINED, PROXY ${stamp}`;

    const cleanup = withDb((db) => {
      const profileA = (
        db
          .prepare("SELECT id FROM profiles WHERE name = ?")
          .get(PORTAL_HOUSEHOLD_A_PROFILE) as { id: number }
      ).id;
      const portalId = Number(
        db
          .prepare(
            "INSERT INTO portals (slug, name, created_at) VALUES (?, ?, datetime('now'))"
          )
          .run(`declined-portal-${stamp}`, portal).lastInsertRowid
      );
      const accountId = Number(
        db
          .prepare(
            `INSERT INTO portal_accounts (portal_id, slug, name, implicit, created_at)
             VALUES (?, 'default', 'Default login', 1, datetime('now'))`
          )
          .run(portalId).lastInsertRowid
      );
      const bind = db.prepare(
        `INSERT INTO portal_identities
           (portal_id, account_id, patient_label, profile_id, ignored, declined,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`
      );
      bind.run(portalId, accountId, holderLabel, profileA, 0);
      // Bound to a real profile AND declined — the two are not exclusive, which is
      // exactly how this differs from `ignored`.
      bind.run(portalId, accountId, proxyLabel, profileA, 1);
      return { portalId };
    });

    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_A,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");

      const proxyRow = patientRowFor(member, proxyLabel);
      await expect(proxyRow).toBeVisible();
      await expect(proxyRow.getByTestId("portal-identity-declined")).toHaveText(
        /the portal doesn’t offer downloads for this proxy — nothing to fix/
      );
      // Still a real binding: the profile chip is there, and the row is not "ignored".
      await expect(proxyRow.getByTestId("portal-identity-ignored")).toHaveCount(
        0
      );

      // The other patient on the SAME login says nothing about it.
      const holderRow = patientRowFor(member, holderLabel);
      await expect(holderRow).toBeVisible();
      await expect(
        holderRow.getByTestId("portal-identity-declined")
      ).toHaveCount(0);
    } finally {
      await member.context().close();
      withDb((db) => {
        db.prepare("DELETE FROM portal_identities WHERE portal_id = ?").run(
          cleanup.portalId
        );
        db.prepare("DELETE FROM portal_accounts WHERE portal_id = ?").run(
          cleanup.portalId
        );
        db.prepare("DELETE FROM portals WHERE id = ?").run(cleanup.portalId);
      });
    }
  });
});
