import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";
import { followLink, hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HXEVERY,
  HXEVERY_SELF_PROFILE,
  HXEVERY_RO_PROFILE,
  HXEVERY_SELF_DOSE,
  HXEVERY_RO_DOSE,
  HXEVERY_DAY,
} from "./fixture-logins";

// `/history?view=everyone` — THE MERGED RECORD (#4009 item 3, #3958, #2106).
//
// WHAT THE OTHER TIERS ALREADY PROVE, so this spec does not: the DB tier proves the
// composition (`mergeMemberTimelines` over per-member gathers) and the per-member age
// gate — the security-relevant half, i.e. that the page cannot widen exposure beyond
// what each member's own pages show this login — and the action tier proves that a
// forged cross-profile correction is REFUSED
// (lib/__action_tests__/history-cross-profile-correction.actions.test.ts). Neither can
// see a rendered page.
//
// SO WHAT IS HERE IS THE RENDERED SURFACE, and it is three claims:
//   1. Per-row SUBJECT attribution — whose row is whose, on a page that merges them.
//   2. The per-row WRITE GATE (#4009 item 1) — the ⋯ appears on the member this login
//      may write and not on the one it may not, asserted as the DIFFERENCE between two
//      rows in ONE render. An absence assertion alone cannot tell "the gate works"
//      from "the menu stopped rendering", which is why the fixture's two grants differ.
//   3. The mode is DEEP-LINKED, not chipped — reached from the household page (#1463),
//      with nothing on /history's own filter row advertising it. #3958 rules that out
//      explicitly: the sidebar is the app's one profile switcher, and a second
//      selection vocabulary is the parallel concept CLAUDE.md forbids.
//
// FIXTURE (#868 hygiene): spec-owned. E2E_LOGIN_HXEVERY holds one WRITE grant and one
// READ-ONLY grant, each member carrying one taken dose on a fixed past day. The
// correction below is a persistent write, so the log is reset before each test rather
// than assumed fresh — a retry must find the same tree the first run did.

function resetFixture(): { selfId: number; roId: number } {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    const idOf = (name: string) =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    const selfId = idOf(HXEVERY_SELF_PROFILE);
    const roId = idOf(HXEVERY_RO_PROFILE);
    // Put both members' logs back to exactly one `taken` row on the fixture day: the
    // correction test deletes one, and a re-run has to start where the first did.
    for (const [pid, item] of [
      [selfId, HXEVERY_SELF_DOSE],
      [roId, HXEVERY_RO_DOSE],
    ] as const) {
      const row = db
        .prepare(
          `SELECT i.id AS itemId, d.id AS doseId
             FROM intake_items i
             JOIN intake_item_doses d ON d.item_id = i.id
            WHERE i.profile_id = ? AND i.name = ?`
        )
        .get(pid, item) as { itemId: number; doseId: number };
      db.prepare("DELETE FROM intake_item_logs WHERE item_id = ?").run(
        row.itemId
      );
      db.prepare(
        `INSERT INTO intake_item_logs (item_id, dose_id, date, status)
         VALUES (?, ?, ?, 'taken')`
      ).run(row.itemId, row.doseId, HXEVERY_DAY);
    }
    return { selfId, roId };
  } finally {
    db.close();
  }
}

// The view-set is PERSISTED session state, and `?view=everyone` only merges when more
// than one profile is in it (`viewIds.length > 1`). The switcher panel's eye toggle is
// the one control that owns view membership — the same door multi-view.spec.ts drives.
// Past the pre-hydration disable gate (#830): the identity bar renders disabled until
// mounted, so wait for enabled before clicking or the tap is silently swallowed.
async function addToView(
  page: import("@playwright/test").Page,
  profileId: number
): Promise<void> {
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
  await settledClick(page, page.getByTestId(`view-toggle-${profileId}`));
}

test.describe("the record's merged household view (#4009 item 3)", () => {
  test("attributes every row and gates the ⋯ on the row's own profile", async ({
    browser,
  }) => {
    // Local `next dev` compiles /history and /household on first hit.
    test.slow();
    const { roId } = resetFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HXEVERY,
      password: E2E_MEMBER_PASSWORD,
    });

    // Acting profile is SELF — the lowest-id grant.
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      HXEVERY_SELF_PROFILE
    );

    // ── SINGLE VIEW FIRST, because it is the control ─────────────────────────
    // Everything below has to be attributable to the MODE rather than to the
    // fixture, and the only way to say that is to show the same page without it:
    // one member's row, no subject chip, and the other member's dose absent.
    await page.goto("/history");
    await expect(page.getByText(HXEVERY_SELF_DOSE)).toBeVisible();
    await expect(page.getByText(HXEVERY_RO_DOSE)).toHaveCount(0);
    await expect(page.getByTestId("history-row-subject")).toHaveCount(0);

    // ── THE MODE IS NOT ON THE FILTER ROW ────────────────────────────────────
    // #3958: no view switcher on this page, at any width. Scoped to the filter row
    // rather than to the page, because "everyone" is a word the sidebar and the nav
    // may legitimately use — a page-wide text search would pass or fail on a
    // neighbour's copy rather than on this claim.
    await expect(
      page.getByTestId("history-filters").getByText(/every(one|body)/i)
    ).toHaveCount(0);

    // ── THE DOOR IS THE HOUSEHOLD PAGE (#1463) ───────────────────────────────
    // Followed rather than typed. `?view=everyone` shipped with no door at all in
    // phase 1, which is the state this asserts is over: a capability reachable only
    // by hand-typing a query string is not demoted, it is retired.
    await page.goto("/household");
    await followLink(
      page,
      page.getByTestId("household-record-link"),
      /\/history\?view=everyone/
    );

    // The view-set is still one profile, so the mode has nothing to merge yet — and
    // that degrade is the honest one: the page renders, it just renders single view.
    await expect(page.getByTestId("history-page")).toBeVisible();

    // ── MERGED ───────────────────────────────────────────────────────────────
    await addToView(page, roId);
    await page.goto("/history?view=everyone");

    // BOTH members' doses, on one page, each naming its subject. Exact matching with
    // a count rather than a substring: the two fixture item names share the prefix
    // "Record", so `toContainText("Record")` would be satisfied by either row alone.
    await expect(page.getByText(HXEVERY_SELF_DOSE)).toBeVisible();
    await expect(page.getByText(HXEVERY_RO_DOSE)).toBeVisible();
    const subjects = page.getByTestId("history-row-subject");
    await expect(
      subjects.filter({ hasText: HXEVERY_SELF_PROFILE })
    ).toHaveCount(1);
    await expect(subjects.filter({ hasText: HXEVERY_RO_PROFILE })).toHaveCount(
      1
    );

    // ── THE PER-ROW WRITE GATE (#4009 item 1 / #2106) ────────────────────────
    // The claim is a RELATIONSHIP between the two rows, so it is asserted as one:
    // the writable member's row has the menu, the read-only member's does not, in
    // the same render. Either half alone is satisfiable by a page that draws no
    // menus at all, which is exactly the phase-1 behaviour this replaces.
    const selfRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_SELF_DOSE });
    const roRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_RO_DOSE });
    await expect(selfRow.getByTestId("overflow-menu-trigger")).toHaveCount(1);
    await expect(roRow.getByTestId("overflow-menu-trigger")).toHaveCount(0);
  });

  test("a correction on a writable member's row lands on that member", async ({
    browser,
  }) => {
    test.slow();
    const { selfId, roId } = resetFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HXEVERY,
      password: E2E_MEMBER_PASSWORD,
    });
    await addToView(page, roId);
    await page.goto("/history?view=everyone");

    // Delete the ACTING member's dose from the merged feed. The row is the acting
    // profile's, so this is the plain case — and it is the one that proves the
    // subject stamp did not break the ordinary path while adding the cross-profile
    // one: every form now posts `profile_id`, including on rows that never needed it.
    const selfRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_SELF_DOSE });
    await hydratedClick(page, selfRow.getByTestId("overflow-menu-trigger"));
    // The menu item opens the shared confirm dialog — a client toggle, no POST — and
    // the dialog's own Delete is what dispatches the Server Action.
    await page.getByTestId("history-row-delete").click();
    await settledClick(
      page,
      page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" })
    );

    await expect(page.getByText(HXEVERY_SELF_DOSE)).toHaveCount(0);
    // The OTHER member's row is untouched — a delete that reached across subjects
    // would be the worst defect this page could have, and "the row I clicked went
    // away" cannot see it.
    await expect(page.getByText(HXEVERY_RO_DOSE)).toBeVisible();

    // And in the store, per profile rather than per row count.
    const db = new Database(workerDbPath());
    db.pragma("busy_timeout = 5000");
    try {
      const takenFor = (pid: number) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM intake_item_logs l
                 JOIN intake_items i ON i.id = l.item_id
                WHERE i.profile_id = ? AND l.status = 'taken'`
            )
            .get(pid) as { n: number }
        ).n;
      expect(takenFor(selfId)).toBe(0);
      expect(takenFor(roId)).toBe(1);
    } finally {
      db.close();
    }
  });
});
