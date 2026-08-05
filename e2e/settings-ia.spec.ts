import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs, followLink } from "./nav";
import { settledClick, settledCheck, settledFill } from "./helpers";
import {
  E2E_LOGIN_NOTIF,
  E2E_LOGIN_NOTIF_SWEEP,
  E2E_LOGIN_CLOSURE_DQ,
  CLOSURE_DQ_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

const DB_PATH = workerDbPath();

// Clear the CLOSURE_DQ profile's birthdate so the "Set a birthdate" data-quality gap is
// active before the closure test (spec-owned). BLAST RADIUS: one attr on one dedicated
// fixture profile.
function resetClosureBirthdate(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(CLOSURE_DQ_PROFILE) as { id: number } | undefined;
    if (row)
      db.prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'birthdate'"
      ).run(row.id);
  } finally {
    db.close();
  }
}

// Settings IA (#1462, superseding #928). Settings is now TOPIC-first: ONE
// registry-driven navigation system — a /settings INDEX rendered on every viewport,
// plus a desktop group nav reading the SAME registry — over real group routes. It
// replaced three navigation systems (the tab strip, the Profile tab's anchor
// jump-nav, the admin pill row).
//
// What these cases pin:
//   • the index lists the right groups for a member vs an admin (nav visibility);
//   • a group page states its TIER as a label and carries the shared nav;
//   • the old tier-first URL 404s — the §2 no-redirect decision, so this asserts a
//     404 rather than a bounce;
//   • Notifications renders its three sections with exactly ONE control per kind;
//   • a group page round-trips an autosave write.
//
// Admin cases run on the shared admin storageState (profile 1); the kind-routing
// mutations run as a DEDICATED member login (NOTIF_PROFILE) so toggling notification
// prefs never races the shared profile-1 notification specs.

test.describe("Settings IA (#1462) — index and routing", () => {
  test("the index lists every group, grouped member-then-admin, for an admin", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByTestId("settings-index")).toBeVisible();

    for (const id of [
      "account",
      "display",
      "health",
      "training",
      "nutrition",
      "coaching",
      "notifications",
      "privacy",
    ]) {
      await expect(page.getByTestId(`settings-group-${id}`)).toBeVisible();
    }
    // …and the admin block, which a member never sees (asserted below).
    await expect(page.getByTestId("settings-index-admin")).toBeVisible();
    for (const id of ["people", "server", "logs"]) {
      await expect(page.getByTestId(`settings-group-${id}`)).toBeVisible();
    }
  });

  test("a group page states its tier and carries the shared group nav", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings");
    await followLink(
      page,
      page.getByTestId("settings-group-display"),
      /\/settings\/display$/
    );
    await expect(
      page.getByRole("heading", { name: "Display & units" })
    ).toBeVisible();
    // Tier is a LABEL now, not the navigation architecture.
    await expect(page.getByTestId("settings-tier-blurb")).toContainText(
      /applies to your login/i
    );
    // The breadcrumb back to the index renders on every viewport — on a phone it is
    // the whole navigation story (the index IS the nav).
    await expect(page.getByTestId("settings-breadcrumb")).toBeVisible();
  });

  test("the old tier-first Profile URL 404s (the §2 no-redirect decision)", async ({
    page,
  }) => {
    const resp = await page.goto("/settings/profile");
    expect(resp?.status()).toBe(404);
  });

  test("the Logs & audit group fronts AI logs | Errors | Audit via one sub-page strip", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/logs");
    const subnav = page.getByTestId("settings-subpage-nav");
    await expect(subnav).toBeVisible();

    await followLink(
      page,
      subnav.getByRole("link", { name: "Errors" }),
      /\/settings\/errors$/
    );
    await expect(page.getByText(/Unexpected exceptions/)).toBeVisible();

    await followLink(
      page,
      subnav.getByRole("link", { name: "Audit" }),
      /\/settings\/audit$/
    );
    await expect(
      page.getByRole("heading", { name: "Logs & audit" })
    ).toBeVisible();
  });

  test("the health cards stayed on Medical → Background", async ({ page }) => {
    test.slow();
    await page.goto("/records/care/overview#background");
    await expect(
      page.getByRole("heading", { name: "Background" })
    ).toBeVisible();
    await expect(page.getByTestId("smoking-history")).toBeVisible();
    await expect(page.getByTestId("risk-factors")).toBeVisible();
    // The Emergency Card settings left Background for the Passport (#1087) —
    // emergency-card.spec.ts covers their new home; Background must not render
    // the toggle anymore.
    await expect(page.getByTestId("emergency-toggle")).toHaveCount(0);
  });
});

test.describe("Settings IA (#1462) — Notifications group", () => {
  test("renders Channels, Schedule and Message kinds with ONE control per kind", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/notifications");

    // The three sections of §6.
    await expect(page.getByTestId("notify-channels")).toBeVisible();
    await expect(page.getByTestId("notify-schedule")).toBeVisible();
    await expect(page.getByTestId("notification-kinds")).toBeVisible();
    await expect(page.getByTestId("push-settings")).toBeVisible();

    // The kind list replaced BOTH the old mega-card toggles and the separate
    // matrix, so each kind has exactly ONE row and ONE enable control — the
    // duplicate-control problem §6 set out to remove.
    await expect(page.getByTestId("kind-row-digest")).toHaveCount(1);
    await expect(page.getByTestId("digest-hour")).toHaveCount(1);
    await expect(page.getByTestId("preventive-enabled")).toHaveCount(1);
    // One consolidated morning-digest row since #1108 — the "what's due" list is the
    // digest's Today section, so there is no separate `upcoming` row.
    await expect(page.getByTestId("kind-row-upcoming")).toHaveCount(0);

    // The instance-wide bot card left this page for Server (#1462 §1/§6), so a
    // member-visible page no longer embeds an admin-only block.
    await expect(page.getByTestId("server-telegram")).toHaveCount(0);

    // #1868 §4: the group is registered `mixed`, so the ONE header states the mixed
    // scope instead of claiming the profile over four login-scoped cards.
    await expect(page.getByTestId("settings-tier-blurb")).toContainText(
      /partly your login/i
    );

    // #1868 §3: the digest mirror is collapsed to a summary line — its ten checkboxes
    // exist behind a disclosure rather than always rendering.
    await expect(page.getByTestId("digest-tune-summary")).toBeVisible();
    await expect(page.getByTestId("digest-tune-list")).not.toBeVisible();
    await expect(page.getByTestId("digest-tune-disclosure")).toBeVisible();

    // The schedule/kind cards autosave now, so their explicit Save buttons are gone.
    // Two channel cards keep their own Save (Telegram validates a chat id; the
    // email card commits a deliberate content-mode choice, #1855) — so exactly TWO
    // remain, and a spec clicking "Save" here must scope to its card.
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(2);
  });

  test("a member sees the group index without admin groups, and no Server section", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings");
      await expect(member.getByTestId("settings-group-account")).toBeVisible();
      await expect(
        member.getByTestId("settings-group-notifications")
      ).toBeVisible();
      // No admin block, and none of its groups.
      await expect(member.getByTestId("settings-index-admin")).toHaveCount(0);
      for (const id of ["people", "server", "logs"]) {
        await expect(member.getByTestId(`settings-group-${id}`)).toHaveCount(0);
      }

      await member.goto("/settings/notifications");
      await expect(member.getByTestId("push-settings")).toBeVisible();
      await expect(member.getByTestId("notification-kinds")).toBeVisible();
      await expect(member.getByTestId("server-telegram")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });

  test("muting the profile as the last unmuted managing login warns about the safety tier (#1324)", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      const mute = member.getByTestId("profile-notify-mute");
      await expect(mute).toBeVisible();

      // NOTIF is this login's sole managing profile (no co-caregiver), so it is the
      // last unmuted managing login: checking the mute box warns (warn, never block).
      // State-relative + self-restoring so it stays repeat-each safe.
      const wasChecked = await mute.isChecked();
      await settledCheck(member, mute, true);
      await expect(member.getByTestId("mute-safety-warning")).toBeVisible();
      await expect(member.getByTestId("mute-safety-warning")).toContainText(
        /safety reminders/i
      );

      // Un-muting clears the warning; leave the fixture as we found it.
      await settledCheck(member, mute, false);
      await expect(member.getByTestId("mute-safety-warning")).toHaveCount(0);
      if (wasChecked) await settledCheck(member, mute, true);
    } finally {
      await member.context().close();
    }
  });

  test("channel routing: push can't deliver food, a Telegram toggle persists, and an all-off safety kind warns", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      const kinds = member.getByTestId("notification-kinds");
      await expect(kinds).toBeVisible();

      // Inherently-undeliverable cell: push × food renders as unavailable, not a box.
      await expect(
        member.getByTestId("matrix-unavailable-push-food")
      ).toBeVisible();
      await expect(member.getByTestId("matrix-cell-push-food")).toHaveCount(0);

      // Toggling a Telegram kind persists across a reload (tier-correct action).
      // State-relative + self-restoring so it's repeat-each safe (the fixture DB
      // persists across the 3 repeats).
      //
      // The routing checkbox fires its action from a CLIENT onChange (optimistic
      // flip + disabled-while-saving), so a click in the hydration window is
      // silently swallowed while an unrelated on-load POST can still satisfy
      // settledClick's any-POST arm (the #830 class — this spec failed exactly so
      // in CI). toPass is justified: "my click landed" is non-atomic and there is
      // no navigation for followLink — re-click until the OPTIMISTIC flip proves
      // onChange fired. React batches the flip with `disabled={saving}` into one
      // render, so once flipped, waiting for the box to re-ENABLE proves the save
      // round-trip (action + refresh) completed — only then is a reload safe.
      const toggleRoutingCell = async (testid: string, to: boolean) => {
        const cell = member.getByTestId(testid);
        await expect(async () => {
          await cell.click();
          await expect(cell).toBeChecked({ checked: to });
        }).toPass(); // topass-ok: re-click the routing cell until the optimistic flip proves onChange fired — 'my click landed' is non-atomic with no navigation to follow (#830)
        await expect(cell).toBeEnabled();
      };
      const tgRefill = member.getByTestId("matrix-cell-telegram-refill");
      const wasChecked = await tgRefill.isChecked();
      await toggleRoutingCell("matrix-cell-telegram-refill", !wasChecked);
      await member.reload();
      await expect(
        member.getByTestId("matrix-cell-telegram-refill")
      ).toBeChecked({ checked: !wasChecked });
      // Restore the fixture (leave the column as we found it).
      await toggleRoutingCell("matrix-cell-telegram-refill", wasChecked);

      // Configure Home Assistant so the profile has one CONFIGURED channel, then
      // turn a SAFETY kind (dose) off on it — with no other channel configured, the
      // row warns (warn, never block).
      const ha = member.getByTestId("ha-settings");
      const haEnable = member.getByTestId("ha-enable");
      // settledCheck waits for hydration (a pre-hydration toggle reverts — #1188) and
      // is idempotent, so it subsumes the isChecked() guard.
      await settledCheck(member, haEnable, true);
      await settledFill(
        member,
        member.getByTestId("ha-webhook-url"),
        "http://homeassistant.local:8123/api/webhook/allos-notif"
      );
      await settledClick(member, member.getByTestId("ha-save"));
      await member.reload();

      // #1868 §1: the HA card is the CHANNEL now — enable, URL, secret, test — and
      // carries no per-kind grid. Its routing lives in the matrix's HA column, which
      // the rest of this case drives. (Applying the card must also not silence the
      // channel: with the grid gone, a derived-from-form disabled set would have read
      // as "every kind unchecked" — asserted from the matrix side just below.)
      await expect(member.getByTestId("ha-kind-dose")).toHaveCount(0);
      await expect(member.getByTestId("ha-kinds-pointer")).toBeVisible();

      // Baseline: with HA configured and dose ON, no safety warning.
      const haDose = member.getByTestId("matrix-cell-ha-dose");
      if (!(await haDose.isChecked())) await settledClick(member, haDose);
      await expect(member.getByTestId("kind-safety-warning-dose")).toHaveCount(
        0
      );
      // Turn dose off for the only configured channel → the warning appears.
      await settledClick(member, member.getByTestId("matrix-cell-ha-dose"));
      await expect(
        member.getByTestId("kind-safety-warning-dose")
      ).toBeVisible();
      // Restore: dose back on, warning clears (leave clean for the next repeat).
      await settledClick(member, member.getByTestId("matrix-cell-ha-dose"));
      await expect(member.getByTestId("kind-safety-warning-dose")).toHaveCount(
        0
      );
      // ha card still rendered (sanity — the section didn't collapse).
      await expect(ha).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  // The column select-all (#1868 §2). What only a browser can prove: the tri-state
  // header renders, one tap rewrites the whole column through the real Server Action,
  // and — the case that must never regress — the SAFETY checkboxes survive a column
  // "turn off". The sweep's decision logic is pinned in the pure tier
  // (lib/__tests__/matrix-bulk.test.ts) and its write path in the action tier.
  //
  // Runs on its OWN login+profile: a sweep rewrites a whole channel's disabled-kinds
  // blob, which on a shared login would silence ten kinds for every other spec.
  test("a column select-all sweeps the whole column but never the safety kinds", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_NOTIF_SWEEP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");
      await expect(member.getByTestId("notification-kinds")).toBeVisible();

      // Same optimistic-flip re-click discipline the per-cell case documents above:
      // the control fires its action from a CLIENT onChange, so a click landing in the
      // hydration window is silently swallowed with no navigation to follow (#830).
      const tapUntil = async (testid: string, checked: boolean) => {
        const box = member.getByTestId(testid);
        await expect(async () => {
          await box.click();
          await expect(box).toBeChecked({ checked });
        }).toPass(); // topass-ok: re-tap until the optimistic flip proves onChange fired — "my tap landed" is non-atomic with no navigation to follow (#830)
        await expect(box).toBeEnabled();
      };

      const header = member.getByTestId("matrix-column-all-telegram");
      const refill = member.getByTestId("matrix-cell-telegram-refill");
      const digest = member.getByTestId("matrix-cell-telegram-digest");
      const dose = member.getByTestId("matrix-cell-telegram-dose");
      const escalation = member.getByTestId("matrix-cell-telegram-escalation");

      // The control names what it does AND states the carve-out, so nobody taps it
      // believing it silences everything.
      await expect(header).toHaveAttribute(
        "aria-label",
        /except safety reminders/i
      );

      // Drive to a known state — a --repeat-each run re-enters with the previous run's
      // writes. `check()` is a no-op once the column is already fully on.
      await expect(async () => {
        await header.check();
        await expect(header).toBeChecked();
      }).toPass(); // topass-ok: idempotent drive-to-known-state on a client-onChange control that may still be hydrating (#830); check() is a no-op once already on
      await expect(refill).toBeChecked();
      await expect(digest).toBeChecked();
      await expect(dose).toBeChecked();

      // ONE tap turns the column off — except the safety tier.
      await tapUntil("matrix-column-all-telegram", false);
      await expect(refill).not.toBeChecked();
      await expect(digest).not.toBeChecked();
      await expect(dose).toBeChecked();
      await expect(escalation).toBeChecked();

      // It was a real write, not local state.
      await member.reload();
      await expect(
        member.getByTestId("matrix-cell-telegram-refill")
      ).not.toBeChecked();
      await expect(
        member.getByTestId("matrix-cell-telegram-dose")
      ).toBeChecked();
      await expect(
        member.getByTestId("matrix-column-all-telegram")
      ).not.toBeChecked();

      // And one tap brings the column back.
      await tapUntil("matrix-column-all-telegram", true);
      await expect(
        member.getByTestId("matrix-cell-telegram-refill")
      ).toBeChecked();
      await expect(
        member.getByTestId("matrix-cell-telegram-dose")
      ).toBeChecked();

      // Turning ONE cell off makes the header indeterminate — neither on nor off.
      await tapUntil("matrix-cell-telegram-refill", false);
      const head = member.getByTestId("matrix-column-all-telegram");
      await expect(head).not.toBeChecked();
      await expect
        .poll(() => head.evaluate((el: HTMLInputElement) => el.indeterminate))
        .toBe(true);

      // Restore the column for the next repeat.
      await tapUntil("matrix-column-all-telegram", true);

      // A NON_CONFIGURABLE kind (#1873's `followup`) has no registry row, so it is
      // invisible to the matrix — and therefore unreachable by any sweep.
      await expect(member.getByTestId("kind-row-followup")).toHaveCount(0);
      await expect(
        member.getByTestId("matrix-cell-telegram-followup")
      ).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

test.describe("Settings IA (#1462) — group pages write", () => {
  test("setting a birthdate on the Health profile group clears the data-quality gap and toasts (#1305)", async ({
    browser,
  }) => {
    test.slow();
    resetClosureBirthdate();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CLOSURE_DQ,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/health");
      const bd = member.getByTestId("profile-birthdate");
      await expect(bd).toBeVisible();
      // Wait for hydration so the controlled field's onChange (and the autosave it drives)
      // is wired before filling — a pre-hydration fill would never save (#794 blur path).
      await expect(async () => {
        const hydrated = await bd.evaluate((el) =>
          Object.keys(el).some(
            (k) =>
              k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
          )
        );
        expect(hydrated, "birthdate field not hydrated yet").toBe(true);
      }).toPass(); // topass-ok: hydration gate for the controlled DateField whose display reformats a valid ISO, so a value assertion can't express the wait (#794)
      await bd.fill("1990-01-01");
      // The settings autosave path returns the closure acknowledgment as a toast (#1305).
      await expect(
        member.getByTestId("toast").filter({ hasText: /That cleared/i })
      ).toBeVisible();
    } finally {
      // Leave the profile gappy for the next repeat.
      resetClosureBirthdate();
      await member.context().close();
    }
  });
});
