import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { deleteActivitiesTitled } from "./shared-profile-guard";
import { loginAs } from "./nav";
import { appContent, hydratedClick, followLink, settledClick } from "./helpers";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The equipment MANAGER (issue #391), now hosted on the top-level /equipment
// registry index instead of a Settings tab (issue #343). equipment-lifecycle
// covers retire/restore; this covers the untested rest: adding an implement WITH
// its own weight (shown in the login's weight unit), deleting one that a logged
// set references (the link nulls, no FK 500, history survives — the #342
// side-state rule), and age-neutral access for a minor profile.
test.describe("Equipment manager (#391)", () => {
  test("add and edit equipment from the catalog and detail page", async ({
    page,
  }) => {
    // Local `next dev` compiles the equipment route on first hit.
    test.slow();

    await page.goto("/equipment");
    await expect(
      page.getByRole("heading", { name: "Your equipment" })
    ).toBeVisible();

    // Unique name so a CI retry against the same DB doesn't collide on the
    // per-profile name-uniqueness guard.
    const name = `E2E Own Weight Bar ${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique fixture-name suffix, never a stored timestamp
    await page.getByRole("button", { name: "Add equipment" }).click();
    await page.getByLabel("Name").fill(name);
    // The equipment-weight label carries the login's unit — match it
    // unit-agnostically.
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "Equipment weight", exact: true })
      .click();
    await page.getByLabel(/Equipment weight/).fill("15");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Equipment added")).toBeVisible();

    // The row lists the recorded own-weight rendered in the login's weight unit
    // ("15 kg" by default; "15 lb" if a sibling spec left the unit on lb — either
    // way the round-tripped number is what was entered).
    const row = page.getByTestId("equipment-row").filter({ hasText: name });
    // Renders on the save action's revalidated tree — a cold shard can outrun the default 5s (imaging/#1306 precedent).
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/15\s*(kg|lb)/);

    await hydratedClick(
      page,
      row.getByRole("button", { name: "Equipment actions" })
    );
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit equipment" });
    await edit.getByRole("button", { name: /^15 (kg|lb)$/ }).click();
    await edit.getByLabel(/Equipment weight/).fill("16");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row).toContainText(/16\s*(kg|lb)/);

    await followLink(page, row.getByRole("link", { name }), /\/equipment\/\d+/);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await edit.getByRole("button", { name, exact: true }).click();
    const renamed = `${name} renamed`;
    await edit.getByLabel("Name", { exact: true }).fill(renamed);
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    await edit.getByRole("button", { name: /^16 (kg|lb)$/ }).click();
    await edit.getByLabel(/Equipment weight/).fill("20");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: renamed, exact: true })
    ).toBeVisible();
    await page.goto("/equipment");
    await expect(
      appContent(page).getByTestId("equipment-row").filter({ hasText: renamed })
    ).toContainText(/20\s*(kg|lb)/);
  });

  test("equipment Undo survives navigation and restores the original detail and usage", async ({
    page,
  }) => {
    test.slow();
    const name = "Equipment manager undo bar";
    const title = "Equipment manager undo session";
    const db = new Database(workerDbPath());
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    function cleanup() {
      // Only this test's rows, including a capture left by an interrupted attempt.
      deleteActivitiesTitled(title);
      db.prepare("DELETE FROM equipment WHERE profile_id = 1 AND name = ?").run(
        name
      );
      db.prepare(
        "DELETE FROM deleted_rows WHERE profile_id = 1 AND kind = 'equipment' AND json_extract(payload, '$.rows.equipment[0].name') = ?"
      ).run(name);
    }
    try {
      cleanup();
      const equipmentId = Number(
        db
          .prepare(
            "INSERT INTO equipment (profile_id, name, category) VALUES (1, ?, 'Barbell')"
          )
          .run(name).lastInsertRowid
      );
      const activityId = Number(
        db
          .prepare(
            "INSERT INTO activities (profile_id, date, type, title, equipment_id) VALUES (1, '2026-08-01', 'strength', ?, ?)"
          )
          .run(title, equipmentId).lastInsertRowid
      );
      db.prepare(
        "INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id) VALUES (?, 'Barbell Bench Press', 1, 60, 5, ?)"
      ).run(activityId, equipmentId);
      const detail = `/equipment/${equipmentId}`;
      await page.goto(detail);
      await expect(
        appContent(page).getByTestId("equipment-stat-sessions")
      ).toContainText("1");
      await appContent(page).getByTestId("equipment-detail-delete").click();
      await settledClick(
        page,
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Delete", exact: true })
      );
      await expect(page).toHaveURL(/\/equipment$/);
      await expect(
        page.getByText(`Deleted ${name}`, { exact: true })
      ).toBeVisible();
      await expect(
        appContent(page).getByTestId("equipment-row").filter({ hasText: name })
      ).toHaveCount(0);
      expect(
        db
          .prepare(
            "SELECT equipment_id FROM exercise_sets WHERE activity_id = ?"
          )
          .get(activityId)
      ).toEqual({ equipment_id: null });
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      const row = appContent(page)
        .getByTestId("equipment-row")
        .filter({ hasText: name });
      await expect(row).toBeVisible();
      await expect(
        row.getByRole("link", { name, exact: true })
      ).toHaveAttribute("href", detail);
      await followLink(
        page,
        row.getByRole("link", { name, exact: true }),
        new RegExp(`${detail}$`)
      );
      await expect(
        appContent(page).getByTestId("equipment-stat-sessions")
      ).toContainText("1");
      await expect(
        appContent(page).getByTestId("equipment-session-link")
      ).toHaveText(title);
    } finally {
      cleanup();
      db.close();
    }
  });

  test("a minor can open the Equipment registry by direct URL", async ({
    browser,
  }) => {
    test.slow();

    // Equipment and activity logging are profile-owned tools, not adult statistics.
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/equipment");
      await expect(member).toHaveURL(/\/equipment$/);
      await expect(
        member.getByRole("heading", { name: "Your equipment" })
      ).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
