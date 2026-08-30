import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick, expectInView, openMobileDrawer } from "./helpers";
import { switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MVMEDS,
  MVMEDS_SELF_PROFILE,
  MVMEDS_RO_PROFILE,
  MVMEDS_SELF_MED,
  MVMEDS_RO_MED,
  E2E_LOGIN_VIEWONLY_WRITE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The unified profile switcher (issue #1801).
//
// One identity bar + one switcher panel replaced three surfaces: the sidebar
// profile menu, the ProfileViewStrip, and (on a phone) nothing at all. This spec
// pins the parts of that unification no other spec covers:
//
//   * the SAFETY RULE, made structural — after any switch the FIRST stacked
//     avatar is the acting profile, and it is the one carrying `data-acting`.
//     Writes land on that profile, so its position is not decoration;
//   * switching from the bar on BOTH viewports, with the page's data following —
//     on desktop that switch is dispatched from the OVERLAID panel, which is the
//     kept-mounted guarantee (#1823) re-pinned under `absolute`;
//   * the desktop expando OVERLAYING the sidebar rather than reflowing it
//     (#1823): opening it must not move a single thing below the bar;
//   * the #33 read-only hint on the bar AND on the row it describes;
//   * the multiProfile gate — a single-profile instance keeps the wordmark and
//     grows no identity chrome at all;
//   * the retired surfaces staying retired.
//
// The view-set round-trip (stacked avatars + "+N more" updating) is asserted by
// multi-view.spec.ts and shell.mobile.spec.ts, which inherited the strip-era
// assertions; the name-line composition itself is pinned purely in
// lib/__tests__/profile-identity.test.ts.
//
// Fixture hygiene (#868): read-only over the seeded MVMEDS fixture (a caregiver
// granted its own profile WRITE + a second profile READ-ONLY) and the seeded
// single-profile view-only login, each in its OWN cookie-less context — the
// acting profile is SESSION state, so switching here can never touch the shared
// admin storageState or a sibling worker.

function profileId(name: string): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

function medicationId(profileName: string, medicationName: string): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare(
          `SELECT i.id FROM intake_items i
             JOIN profiles p ON p.id = i.profile_id
            WHERE p.name = ? AND i.name = ? AND i.kind = 'medication'`
        )
        .get(profileName, medicationName) as { id: number }
    ).id;
  } finally {
    db.close();
  }
}

// The laid-out rect, or a failure that names the element — `boundingBox()` is
// nullable (a display:none element has no box) and the #1823 geometry pins below
// are arithmetic, not optional.
async function boxOf(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no layout box for ${locator}`);
  return box;
}

// Open the switcher past the pre-hydration disable gate (#830): the bar renders
// disabled until mounted, so wait for it to enable, then click.
//
// `within` SCOPES the lookup, and below `md` it is required rather than tidy: the
// desktop sidebar is hidden by a breakpoint but still in the DOM, so at 390px the
// plain testid resolves to TWO elements — the hidden sidebar's bar and the
// drawer's — and an unscoped locator is a strict-mode violation, not a preference.
async function openSwitcher(
  page: Page,
  mobile = false,
  within?: Locator
): Promise<void> {
  const barId = mobile ? "profile-identity-bar-mobile" : "profile-identity-bar";
  const panelId = mobile
    ? "profile-switcher-panel-mobile"
    : "profile-switcher-panel";
  const scope = within ?? page;
  const trigger = scope.getByTestId(barId);
  await expect(trigger).toBeEnabled();
  await trigger.click();
  // The panel is scoped for the same reason the trigger is, and for one more: it
  // is kept MOUNTED and toggled with a class, so the hidden sidebar's copy exists
  // in the DOM at every width and is never the one under test.
  await expect(scope.getByTestId(panelId)).toBeVisible();
}

// THE acting-emphasis pin: the bar's first stacked avatar is the acting profile,
// and it is the one marked `data-acting`. Asserted through the bar's own
// `data-acting-profile-id` too, so a reordering bug cannot pass by relabelling.
async function expectActing(
  page: Page,
  profileIdValue: number,
  mobile = false,
  within?: Locator
): Promise<void> {
  const bar = (within ?? page).getByTestId(
    mobile ? "profile-identity-bar-mobile" : "profile-identity-bar"
  );
  await expect(bar).toHaveAttribute(
    "data-acting-profile-id",
    String(profileIdValue)
  );
  await expect(
    bar.locator('[data-testid^="identity-avatar-"]').first() // first-ok: the assertion IS about the first avatar — acting-first is the safety rule this pins
  ).toHaveAttribute("data-testid", `identity-avatar-${profileIdValue}`);
  await expect(
    bar.getByTestId(`identity-avatar-${profileIdValue}`)
  ).toHaveAttribute("data-acting", "true");
}

test.describe("Unified profile switcher (issue #1801)", () => {
  test("a direct ward medication URL keeps the actor and names the subject (#3312)", async ({
    browser,
  }) => {
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const selfMedicationId = medicationId(MVMEDS_SELF_PROFILE, MVMEDS_SELF_MED);
    const wardMedicationId = medicationId(MVMEDS_RO_PROFILE, MVMEDS_RO_MED);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Direct/fabricated navigation is the only route that does not switch first.
      await page.goto(`/medications/${wardMedicationId}`);
      await expectActing(page, selfId);
      await expect(
        page.getByRole("heading", { level: 1, name: MVMEDS_RO_MED })
      ).toBeVisible();
      await expect(
        page.getByTestId("medication-identity-banner")
      ).toBeVisible();
      await expect(page.getByTestId("medication-subject-name")).toHaveText(
        MVMEDS_RO_PROFILE
      );
      await expect(page.getByTestId("medication-switch-profile")).toHaveText(
        `Act as ${MVMEDS_RO_PROFILE}`
      );
      await expect(
        page.getByTestId("medication-cross-profile-note")
      ).toContainText(`Viewing ${MVMEDS_RO_PROFILE}'s medication`);

      // The paired own-profile branch keeps the normal way back and no subject frame.
      await page.goto(`/medications/${selfMedicationId}`);
      await expect(
        page.getByRole("heading", { level: 1, name: MVMEDS_SELF_MED })
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Back to medications" })
      ).toBeVisible();
      await expect(page.getByTestId("medication-identity-banner")).toHaveCount(
        0
      );
      await expect(
        page.getByTestId("medication-cross-profile-note")
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("switching from the bar reorders acting-first, carries the read-only hint, and the page follows", async ({
    browser,
  }) => {
    // Local `next dev` compiles /medications on first hit.
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const roId = profileId(MVMEDS_RO_PROFILE);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications");

      // Acting is the WRITE profile (the lowest-id grant), so no read-only hint.
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        MVMEDS_SELF_PROFILE
      );
      await expectActing(page, selfId);
      await expectInView(page, 1);
      await expect(page.getByTestId("read-only-badge")).toHaveCount(0);

      // TWO VERBS, TWO CONTROLS: every accessible profile is a row with a
      // switch-to button AND its own view toggle — never one ambiguous tap.
      await openSwitcher(page);
      const panel = page.getByTestId("profile-switcher-panel");
      await expect(panel.getByTestId(`switch-to-${roId}`)).toBeVisible();
      await expect(panel.getByTestId(`view-toggle-${roId}`)).toBeEnabled();
      // You cannot un-view the profile you are acting as.
      await expect(panel.getByTestId(`view-toggle-${selfId}`)).toBeDisabled();
      // The #33 hint rides the ROW of the read-only profile, so "why can't I edit
      // here?" is answerable BEFORE switching rather than after.
      await expect(
        panel.getByTestId(`switcher-read-only-${roId}`)
      ).toBeVisible();
      await expect(
        panel.getByTestId(`switcher-read-only-${selfId}`)
      ).toHaveCount(0);

      // Switch to the read-only profile through the panel's switch-to control —
      // the existing switchProfileAction/setActiveProfile boundary, no new write
      // path. This is also the kept-mounted guarantee under `absolute` (#1823):
      // the row's <form> lives in an out-of-flow panel that `onSelect` hides via
      // a class, so React still has it mounted when it dispatches the Server
      // Action. If the overlay rewrite had reached for an unmount, the switch
      // below would silently never land.
      await settledClick(page, panel.getByTestId(`switch-to-${roId}`));

      // The bar reorders: the newly acting profile is FIRST and ringed.
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        MVMEDS_RO_PROFILE,
        { timeout: 20_000 }
      );
      await expectActing(page, roId);
      // …and the hint rides the bar, because that is where "who am I acting as"
      // is already being read.
      await expect(page.getByTestId("read-only-badge")).toBeVisible();

      // The PAGE follows the switch: the medications board is the read-only
      // profile's now, not the write profile's.
      await expect(
        page.getByTestId("medication-row").filter({ hasText: MVMEDS_RO_MED })
      ).toBeVisible();
      await expect(
        page.getByTestId("medication-row").filter({ hasText: MVMEDS_SELF_MED })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  // THE PHONE'S IDENTITY BAR MOVED, IT DID NOT GO (#4102). It used to ride a
  // `md:hidden` top bar and open a TOP drawer of its own; that bar retired with
  // the rest of the phone's top chrome, so the bar now sits at the top of the More
  // drawer and opens the ordinary sidebar-anchored panel — one switcher, one
  // vocabulary, which is the #1801 rule this move had to keep. The testids are
  // therefore the plain ones: there is no second, phone-shaped switcher any more.
  test("the drawer's top carries the identity, switches through the same panel, and shows no wordmark", async ({
    browser,
  }) => {
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const roId = profileId(MVMEDS_RO_PROFILE);

    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_MVMEDS, password: E2E_MEMBER_PASSWORD },
      { viewport: { width: 390, height: 844 } }
    );
    try {
      await page.goto("/medications");

      // Nothing identity-shaped is ON SCREEN with the drawer shut: the phone's one
      // chrome is the dock, and the dock never carries identity. Asserted as
      // not-VISIBLE rather than not-present, because the desktop sidebar is still
      // in the DOM at this width (it is hidden by a breakpoint, not unmounted) and
      // it renders the same testid — a count of 0 would be asking the wrong
      // question and would fail on a correct tree.
      await expect(page.getByTestId("profile-identity-bar")).not.toBeVisible();
      // The phone's OWN identity surface, on the other hand, is gone outright: the
      // top-drawer switcher retired with the bar that hosted it.
      await expect(page.getByTestId("profile-identity-bar-mobile")).toHaveCount(
        0
      );

      const drawer = await openMobileDrawer(page);
      // It took the wordmark's slot inside the drawer, exactly as it took it in the
      // bar: identity chrome when identity is ambiguous, brand chrome when it is
      // not, never both (#1801's XOR, now resolved one level in).
      await expect(drawer.getByTestId("profile-identity-bar")).toBeVisible();
      await expect(drawer.getByText("Allos")).toHaveCount(0);
      await expectActing(page, selfId, false, drawer);

      await openSwitcher(page, false, drawer);
      const panel = drawer.getByTestId("profile-switcher-panel");
      await expect(
        panel.getByTestId(`switcher-read-only-${roId}`)
      ).toBeVisible();
      await settledClick(page, panel.getByTestId(`switch-to-${roId}`));

      await expect(page.getByTestId("medication-row").first()).toBeVisible({
        timeout: 20_000,
      }); // first-ok: waiting for the switched page to paint, not asserting a particular row
      await expect(
        page.getByTestId("medication-row").filter({ hasText: MVMEDS_RO_MED })
      ).toBeVisible();

      // And the switched identity reads back from the drawer, which is now the one
      // place on a phone that answers "who am I acting as?".
      const reopened = await openMobileDrawer(page);
      await expect(reopened.getByTestId("profile-identity-bar")).toContainText(
        MVMEDS_RO_PROFILE
      );
      await expectActing(page, roId, false, reopened);
      await expect(reopened.getByTestId("read-only-badge")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("a single-profile login keeps the wordmark and grows no identity chrome", async ({
    browser,
  }) => {
    test.slow();
    // A member granted exactly ONE profile — identity is unambiguous, so the whole
    // apparatus gates off (brand chrome instead of identity chrome).
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_VIEWONLY_WRITE, password: E2E_MEMBER_PASSWORD },
      { viewport: { width: 390, height: 844 } }
    );
    try {
      await page.goto("/");
      // The drawer's top, since the phone bar retired (#4102): brand chrome is
      // what a single-profile instance gets there, and no switcher grows behind it.
      const drawer = await openMobileDrawer(page);
      await expect(drawer.getByText("Allos")).toBeVisible();
      await expect(drawer.getByTestId("profile-identity-bar")).toHaveCount(0);
      await expect(
        page.getByTestId("profile-switcher-panel")
      ).not.toBeVisible();
      await page.keyboard.press("Escape");

      // Same at desktop: the sidebar gains nothing.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.getByTestId("profile-identity-bar")).toHaveCount(0);
      await expect(page.getByTestId("profile-switcher-panel")).toHaveCount(0);
      // The login half still renders — it is not what gated off.
      await expect(page.getByTestId("signed-in-as")).toBeVisible();
      await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("the desktop expando overlays the sidebar instead of shifting it", async ({
    page,
  }) => {
    // Issue #1823. Read-only: opening and Escape-closing the switcher writes
    // nothing, so this is safe on the shared admin session (which is
    // multi-profile, hence has the bar).
    await page.goto("/");
    const sidebar = page.locator("aside", {
      has: page.getByTestId("profile-identity-bar"),
    });
    // Two witnesses below the bar: the control immediately beneath it (which the
    // panel now paints over) and a nav entry much further down (which the old
    // in-flow panel shoved by up to 50vh).
    const search = sidebar.getByRole("button", { name: /Search/ });
    const dashboard = sidebar.locator("nav").getByRole("link", {
      name: "Dashboard",
    });
    await expect(dashboard).toBeVisible();
    const searchBefore = await boxOf(search);
    const dashboardBefore = await boxOf(dashboard);

    await openSwitcher(page);
    const panel = page.getByTestId("profile-switcher-panel");
    const panelBox = await boxOf(panel);

    // THE NO-REFLOW PIN: an out-of-flow panel takes no space, so nothing below
    // the bar moves. `y` is the axis reflow acts on; a vertical scrollbar
    // appearing or leaving could legitimately move `x`.
    //
    // Sub-pixel tolerance, not exact equality (#2505): `boundingBox()` returns
    // fractional CSS pixels, and the sibling pin in workout-history red a shard
    // at 16 vs 16.5 — a line-box rounding artifact, not a reflow. A real reflow
    // moves these by whole pixels (measured 454 against this very assertion when
    // the panel was forced back into flow), so `< 1` still fails the defect the
    // pin exists for. `toBeCloseTo(y, 0)` would NOT do: its tolerance is < 0.5
    // and the observed delta was exactly 0.5.
    expect(Math.abs((await boxOf(search)).y - searchBefore.y)).toBeLessThan(1);
    expect(
      Math.abs((await boxOf(dashboard)).y - dashboardBefore.y)
    ).toBeLessThan(1);

    // …and it is genuinely OVER them, not merely beside them: the panel's box
    // covers the band the search control still occupies.
    const overlapTop = Math.max(panelBox.y, searchBefore.y);
    const overlapBottom = Math.min(
      panelBox.y + panelBox.height,
      searchBefore.y + searchBefore.height
    );
    expect(overlapBottom).toBeGreaterThan(overlapTop);

    // Stacking, proven by hit-testing rather than by reading a class: the point
    // inside that overlap belongs to the panel, so the z-index really does beat
    // the sidebar's own content.
    const hit = await page.evaluate(
      ([x, y]) =>
        Boolean(
          document
            .elementFromPoint(x, y)
            ?.closest('[data-testid="profile-switcher-panel"]')
        ),
      [
        searchBefore.x + searchBefore.width / 2,
        (overlapTop + overlapBottom) / 2,
      ]
    );
    expect(hit).toBe(true);

    // Escape light-dismisses, and the sidebar was never disturbed to begin with.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("profile-identity-bar")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    // Same no-reflow pin after the panel closes, same sub-pixel tolerance (#2505).
    expect(
      Math.abs((await boxOf(dashboard)).y - dashboardBefore.y)
    ).toBeLessThan(1);
  });

  test("switchToProfile is free when it is already acting, and still switches otherwise", async ({
    browser,
  }) => {
    // The shared helper's no-op fast path (#2600). A restore in a `finally` is the
    // natural call, and until now a redundant one still paid the whole
    // open-panel → submit → revalidate → re-render round trip (~1.5s measured)
    // for nothing. The fast path reads the bar's ACCESSIBLE NAME, which states
    // only who is acting — its TEXT also carries the view-set remainder, so a
    // substring match there could return early for a profile merely IN VIEW.
    //
    // Both directions, because a fast path that is only fast is a bug: the no-op
    // must not open the panel, and a real switch must still happen.
    test.slow();
    const selfId = profileId(MVMEDS_SELF_PROFILE);
    const roId = profileId(MVMEDS_RO_PROFILE);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications");
      const panel = page.getByTestId("profile-switcher-panel");

      // Already acting → returns without ever opening the panel.
      await switchToProfile(page, MVMEDS_SELF_PROFILE);
      await expect(panel).toBeHidden();
      await expectActing(page, selfId);

      // A DIFFERENT profile still switches, through the panel as before.
      await switchToProfile(page, MVMEDS_RO_PROFILE);
      await expectActing(page, roId);

      // …and the fast path now holds for the profile it switched TO, which is
      // what makes a restore-after-switch free rather than merely quick.
      await switchToProfile(page, MVMEDS_RO_PROFILE);
      await expect(panel).toBeHidden();
      await expectActing(page, roId);
    } finally {
      await page.context().close();
    }
  });

  test("the retired sidebar profile menu and view strip are gone", async ({
    page,
  }) => {
    await page.goto("/");
    // The two surfaces #1801 unified away. Asserted on the shared admin session
    // (multi-profile), which is exactly where both used to render.
    await expect(page.getByTestId("user-menu-trigger")).toHaveCount(0);
    await expect(page.getByTestId("user-menu-popover")).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    // What replaced them.
    await expect(page.getByTestId("profile-identity-bar")).toBeVisible();
    await expect(page.getByTestId("signed-in-as")).toBeVisible();
  });
});
