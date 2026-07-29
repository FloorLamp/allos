import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_FOLDREOPEN,
  E2E_LOGIN_FOLDTAIL,
  E2E_LOGIN_FOLDWELL,
  FOLD_REOPEN_KID_A_PROFILE,
  FOLD_REOPEN_KID_B_PROFILE,
  FOLD_REOPEN_KID_A_SITUATION,
  FOLD_REOPEN_KID_B_SITUATION,
} from "./fixture-logins";

// The just-recovered dashboard's household bands (#1548 / #1549), at a phone viewport
// — which is where the stacking is felt, and the state the issues were written from.
//
// TWO behaviors, one surface, so one spec:
//
//   #1549 PLACEMENT. The "See the household's illness episodes & visits →" link used
//   to be its own full-width block between the reopen band and the household strip.
//   Because the reopen window (7 days) is a strict SUBSET of the promo window (14),
//   that stacked THREE adjacent household-shaped bands in every just-recovered state,
//   and in the 8–14-day tail left the link floating after the all-clear card with the
//   illness hero that justified it long gone. The link now renders as a ROW of
//   whichever household band is already on screen — one render, never two. The three
//   tests below are the three states: inside the reopen band (≤7d), inside the
//   household strip's label row (8–14d), and absent (>14d).
//
//   #1548 PERSISTENCE. The band's X was client state only, so a dismissed line came
//   back on the next reload. The last test dismisses, RELOADS, and proves the line
//   stays gone while its sibling is untouched — then dismisses the sibling too and
//   watches the promo relocate, which is the two issues meeting.
//
// FIXTURE OWNERSHIP (#868): three spec-owned caregiver logins, one per state, seeded
// by e2e/seed/dashboard.ts. No shared-seed counting anywhere — every assertion is
// scoped to a container this spec's own fixture owns.
//
// VIEWPORT NOTE (the #1416 lesson): a context from `loginAs` does NOT inherit the
// project viewport, so PHONE is restated on every context below.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

function dbHandle(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The stable episode row id for a fixture profile's situation, so the spec can target
// one specific reopen line by its `recently-resolved-<id>` testid rather than guessing
// at row order.
function episodeId(profileName: string, situation: string): number {
  const db = dbHandle();
  try {
    const row = db
      .prepare(
        `SELECT e.id AS id FROM illness_episodes e
           JOIN profiles p ON p.id = e.profile_id
          WHERE p.name = ? AND e.situation = ?
          ORDER BY e.id DESC LIMIT 1`
      )
      .get(profileName, situation) as { id: number } | undefined;
    if (!row) throw new Error(`no episode ${situation} for ${profileName}`);
    return row.id;
  } finally {
    db.close();
  }
}

// The dismissal is PERSISTED per login (that's the fix), so a spec that dismisses has
// to reset it or its second `--repeat-each` iteration starts with the lines already
// hidden. Clearing the login_settings key restores the fixture's shipped state — the
// re-entrancy discipline the attention-hero spec applies to its collapse preference.
function resetDismissals(username: string): void {
  const db = dbHandle();
  try {
    db.prepare(
      `DELETE FROM login_settings
        WHERE key = 'recently_resolved_dismissed'
          AND login_id = (SELECT id FROM logins WHERE username = ?)`
    ).run(username);
  } finally {
    db.close();
  }
}

async function openDashboard(
  browser: Browser,
  creds: { username: string }
): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: creds.username, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  await page.goto("/");
  return page;
}

test("≤7 days: the promo folds into the reopen band, with no standalone block (#1549 a)", async ({
  browser,
}) => {
  resetDismissals(E2E_LOGIN_FOLDREOPEN);
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_FOLDREOPEN,
  });
  try {
    const band = page.getByTestId("recently-resolved-reopen");
    await expect(band).toBeVisible();
    // Both children are inside their 7-day window, so both lines render.
    await expect(
      band.getByTestId(
        `recently-resolved-${episodeId(FOLD_REOPEN_KID_A_PROFILE, FOLD_REOPEN_KID_A_SITUATION)}`
      )
    ).toBeVisible();
    await expect(
      band.getByTestId(
        `recently-resolved-${episodeId(FOLD_REOPEN_KID_B_PROFILE, FOLD_REOPEN_KID_B_SITUATION)}`
      )
    ).toBeVisible();

    // ONE promo on the page, and it is a row of the reopen band — not a third
    // sibling band beneath it.
    await expect(page.getByTestId("household-history-promo")).toHaveCount(1);
    await expect(band.getByTestId("household-history-promo")).toBeVisible();
    await expect(
      page.getByTestId("household-strip").getByTestId("household-history-promo")
    ).toHaveCount(0);

    // It still goes where it always went — placement changed, the href did not.
    await expect(band.getByTestId("household-history-promo")).toHaveAttribute(
      "href",
      "/medical/episodes"
    );

    // The band really is ONE band: the promo row sits inside the same section as the
    // lines, so its top edge is within the section's box rather than below it.
    const bandBox = await band.boundingBox();
    const promoBox = await band
      .getByTestId("household-history-promo")
      .boundingBox();
    if (!bandBox || !promoBox) throw new Error("no bounding boxes");
    expect(promoBox.y).toBeGreaterThan(bandBox.y);
    expect(promoBox.y + promoBox.height).toBeLessThanOrEqual(
      bandBox.y + bandBox.height + 1
    );
  } finally {
    await page.context().close();
  }
});

test("8–14 days: the promo lands in the household strip's label row (#1549 b)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_FOLDTAIL,
  });
  try {
    // Past the reopen window — no band to hang the link on.
    await expect(page.getByTestId("recently-resolved-reopen")).toHaveCount(0);

    const strip = page.getByTestId("household-strip");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId("household-history-promo")).toHaveCount(1);
    await expect(strip.getByTestId("household-history-promo")).toBeVisible();

    // THE ORPHAN CASE #1549's sketch assumed away, and the reason the strip can now
    // raise itself on the promo alone: the strip's chips are filtered to members with
    // a NON-ZERO attention count, so a household that has dealt with everything has NO
    // chips — and the "anchor that always exists" does not. Were the section still
    // gated on chips, the link the 8–14-day tail is supposed to carry would simply
    // have vanished. This fixture's household is deliberately all-clear.
    // (`household-chip-count-*` shares the `household-chip-` prefix, so the count
    // badges are excluded explicitly — a prefix match alone counts each chip twice.)
    await expect(
      strip.locator(
        "[data-testid^='household-chip-']:not([data-testid^='household-chip-count-'])"
      )
    ).toHaveCount(0);

    // It belongs to the strip's LABEL ROW, not to some trailing corner of the
    // section — asserted structurally, because at 390px the row wraps the long link
    // beneath "Household" rather than squeezing either side, and demanding a shared
    // pixel row on a phone would be asserting a layout nobody asked for.
    await expect(
      strip
        .getByTestId("household-strip-header")
        .getByTestId("household-history-promo")
    ).toBeVisible();
  } finally {
    await page.context().close();
  }

  // Where the row DOES fit, the design's "right-aligned in the label row" is literal:
  // same row as "Household", pushed to the far side.
  const wide = await loginAs(
    browser,
    { username: E2E_LOGIN_FOLDTAIL, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 1280, height: 900 }, hasTouch: false }
  );
  try {
    await wide.goto("/");
    const header = wide
      .getByTestId("household-strip")
      .getByTestId("household-strip-header");
    await expect(header).toBeVisible();
    const labelBox = await header
      .getByText("Household", { exact: true })
      .boundingBox();
    const promoBox = await header
      .getByTestId("household-history-promo")
      .boundingBox();
    if (!labelBox || !promoBox) throw new Error("no bounding boxes");
    // Same row: the vertical spans overlap. Right-aligned: it starts past the label.
    expect(promoBox.y).toBeLessThan(labelBox.y + labelBox.height);
    expect(promoBox.y + promoBox.height).toBeGreaterThan(labelBox.y);
    expect(promoBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
  } finally {
    await wide.context().close();
  }
});

test(">14 days: the house has recovered and the promo is gone everywhere (#1549 c)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_FOLDWELL,
  });
  try {
    // The all-clear hero proves the dashboard actually rendered before we assert
    // absences — otherwise a blank page would pass this test vacuously.
    await expect(page.getByTestId("needs-attention")).toBeVisible();
    await expect(page.getByTestId("recently-resolved-reopen")).toHaveCount(0);
    await expect(page.getByTestId("household-history-promo")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("the reopen dismissal survives a reload, and takes only its own line (#1548)", async ({
  browser,
}) => {
  resetDismissals(E2E_LOGIN_FOLDREOPEN);
  const kidA = episodeId(
    FOLD_REOPEN_KID_A_PROFILE,
    FOLD_REOPEN_KID_A_SITUATION
  );
  const kidB = episodeId(
    FOLD_REOPEN_KID_B_PROFILE,
    FOLD_REOPEN_KID_B_SITUATION
  );
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_FOLDREOPEN,
  });
  try {
    const band = page.getByTestId("recently-resolved-reopen");
    const rowA = band.getByTestId(`recently-resolved-${kidA}`);
    const rowB = band.getByTestId(`recently-resolved-${kidB}`);
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // hydratedClick, not a bare click: the X is a client handler, so a tap in the
    // hydration window is silently swallowed and nothing would ever be written.
    await hydratedClick(page, rowA.getByTestId("recently-resolved-dismiss"));
    // `data-saved-count` is the race-free settle (the attention-hero precedent): the
    // row is hidden OPTIMISTICALLY, so neither a reader nor this spec can otherwise
    // tell "stored" from "not sent yet", and reloading too early would abort the
    // in-flight write — which is precisely the bug's shape.
    await expect(band).toHaveAttribute("data-saved-count", "1");
    await expect(rowA).toHaveCount(0);

    // THE BUG: before #1548 this reload brought the line straight back.
    await page.reload();
    const bandAfter = page.getByTestId("recently-resolved-reopen");
    await expect(bandAfter).toBeVisible();
    await expect(
      bandAfter.getByTestId(`recently-resolved-${kidA}`)
    ).toHaveCount(0);
    // Per EPISODE, not per band: the sibling's line is untouched.
    await expect(
      bandAfter.getByTestId(`recently-resolved-${kidB}`)
    ).toBeVisible();
    // Lines remain, so the promo is still the band's footer.
    await expect(page.getByTestId("household-history-promo")).toHaveCount(1);
    await expect(
      bandAfter.getByTestId("household-history-promo")
    ).toBeVisible();

    // Dismiss the LAST line: the band goes, and #1549's case 2 takes over — the promo
    // relocates to the household strip rather than vanishing with the band it was
    // folded into. Waiting on that relocation is also the settle for this write (it
    // can only happen once the action's revalidation has come back).
    await hydratedClick(
      page,
      bandAfter
        .getByTestId(`recently-resolved-${kidB}`)
        .getByTestId("recently-resolved-dismiss")
    );
    const strip = page.getByTestId("household-strip");
    await expect(strip.getByTestId("household-history-promo")).toBeVisible();
    await expect(page.getByTestId("household-history-promo")).toHaveCount(1);
    await expect(page.getByTestId("recently-resolved-reopen")).toHaveCount(0);

    // And that survives a reload too — both hides are stored, the band stays gone,
    // and the promo keeps its second home.
    await page.reload();
    await expect(page.getByTestId("recently-resolved-reopen")).toHaveCount(0);
    await expect(page.getByTestId("household-history-promo")).toHaveCount(1);
    await expect(
      page.getByTestId("household-strip").getByTestId("household-history-promo")
    ).toBeVisible();
  } finally {
    // Leave the fixture as found: the next iteration re-clears anyway, but a spec
    // that persists a preference should not hand its state to whatever runs next.
    resetDismissals(E2E_LOGIN_FOLDREOPEN);
    await page.context().close();
  }
});
