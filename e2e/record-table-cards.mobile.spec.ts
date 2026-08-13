import { test, expect } from "./fixtures";
import { type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledBoxes } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_BULKFIX } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";

// Mobile-viewport spec (390×844, the `mobile` project) because the feature IS what a
// RecordTable row becomes on a phone. Issue #2588, both halves:
//
//   1. A cell authored as a "—" placeholder for the DESKTOP grid was becoming a fully
//      labeled card line ("CHIEF COMPLAINT —") that distinguished nothing. `Td` has
//      had `empty` since #1426 for exactly this; `RecordColumn` had no way to declare
//      it, so it was never threaded.
//   2. The card's head line was whatever happened to fit: flex-wrap packs from base
//      sizes, and the title's `flex-1` base of 0 let any short meta join the identity
//      line, so one list rendered several different head shapes.
//
// At 1280px every assertion here is vacuous — the table renders as a table, `thead`
// is visible and no cell claims a card slot — which is why the desktop half of claim
// 1 (the "—" is STILL there, keeping the column aligned) is checked by widening the
// viewport at the end rather than in a second spec.
//
// SPEC-OWNED FIXTURE (#868): the claim is about a card with NOTHING in three of its
// columns, and an absence is exactly what a neighbour's write destroys.

const DB_PATH = workerDbPath();

// Distinctive enough to locate a row by, and nothing else in the app writes them.
const SPARSE_TYPE = "Sparse Card Study (e2e)";
const FULL_TYPE = "Full Card Visit (e2e)";
const FULL_REASON = "Persistent cough";

interface CardFixture {
  username: string;
  profileId: number;
}

function dayStr(daysAgo: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function createFixture(testInfo: TestInfo): CardFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_card_empty_${suffix}`;
    let profileId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_BULKFIX) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Card Empty (e2e) ${suffix}`);
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
        // The reported card: an imaging visit with no chief complaint, no
        // diagnoses and no provider — three placeholder columns, one card.
        handle
          .prepare(
            "INSERT INTO encounters (profile_id, date, type, source) VALUES (?, ?, ?, NULL)"
          )
          .run(profileId, dayStr(6), SPARSE_TYPE);
        // Its contrast: the same column filled, so the label's ABSENCE above is a
        // property of the data rather than of the column never rendering at all.
        handle
          .prepare(
            "INSERT INTO encounters (profile_id, date, type, reason, source) VALUES (?, ?, ?, ?, NULL)"
          )
          .run(profileId, dayStr(5), FULL_TYPE, FULL_REASON);
      })
      .immediate();
    return { username, profileId };
  } finally {
    handle.close();
  }
}

function destroyFixture(fixture: CardFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare("DELETE FROM encounters WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM logins WHERE username = ?")
          .run(fixture.username);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

// Two independent boundingBox reads can never be compared exactly (#2505). A few
// pixels of sub-pixel rounding is the only slack a "these are on different lines"
// comparison needs — the defect it guards against puts them on the SAME line, tens
// of pixels apart.
const LINE_TOLERANCE_PX = 2;

test("a RecordTable card drops its empty cells and keeps a deterministic head line (#2588)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo);
  let page: Page | null = null;
  try {
    page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/records/history/visits");
    const past = page.getByTestId("visits-past");
    await expect(past).toBeVisible();
    // The header strip is gone in card mode; each cell carries its own label.
    await expect(past.locator("thead")).toBeHidden();

    const sparse = past.locator("tbody tr").filter({ hasText: SPARSE_TYPE });
    const full = past.locator("tbody tr").filter({ hasText: FULL_TYPE });
    await expect(sparse).toHaveCount(1);
    await expect(full).toHaveCount(1);

    // 1 — the card of a visit with nothing recorded says nothing about it. It used
    // to spend three of its lines on "CHIEF COMPLAINT —", "DIAGNOSES —" and
    // "PROVIDER —".
    for (const label of ["Chief complaint", "Diagnoses", "Provider"]) {
      await expect(
        sparse.locator(".card-cell-label", { hasText: label })
      ).toHaveCount(0);
    }
    await expect(sparse.locator("td[data-card]")).toHaveCount(3); // date, visit type, actions
    // The same column, filled, still claims its card line — so the omission above
    // is the DATA's emptiness, not the column quietly disappearing.
    await expect(
      full.locator(".card-cell-label", { hasText: "Chief complaint" })
    ).toHaveCount(1);
    await expect(full).toContainText(FULL_REASON);

    // 2 — the head line is the row's IDENTITY plus its actions, and nothing else:
    // every meta wraps below the title rather than joining it when it happens to
    // fit. This is the assertion the old `flex-1` base of 0 could not satisfy —
    // "Sparse Card Study (e2e)" is short, so it packed onto the date's line.
    const title = sparse.locator('td[data-card="title"]');
    const actions = sparse.locator('td[data-card="actions"]');
    const meta = sparse.locator('td[data-card="meta"]');
    await expect(meta).toHaveCount(1);
    const [titleBox, actionsBox, metaBox] = await settledBoxes([
      title,
      actions,
      meta,
    ]);
    // The actions cell shares the title's line, pinned to its right edge.
    expect(actionsBox.y).toBeLessThan(
      titleBox.y + titleBox.height + LINE_TOLERANCE_PX
    );
    expect(actionsBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    // The meta starts on the NEXT line.
    expect(metaBox.y).toBeGreaterThanOrEqual(
      titleBox.y + titleBox.height - LINE_TOLERANCE_PX
    );

    // The desktop grid is untouched: the placeholder is still rendered, because a
    // table column with a hole in it needs one to stay aligned.
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopRow = page
      .getByTestId("visits-past")
      .locator("tbody tr")
      .filter({ hasText: SPARSE_TYPE });
    await expect(
      page.getByTestId("visits-past").locator("thead")
    ).toBeVisible();
    await expect(desktopRow.locator("td").nth(2)).toHaveText("—");
  } finally {
    if (page) await page.context().close();
    destroyFixture(fixture);
  }
});
