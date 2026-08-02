import { test, expect } from "./fixtures";
import { settledClick, settledFill } from "./helpers";
// The admin Server settings backup card surfaces off-volume replication status
// read-only (issue #130): whether BACKUP_DEST_DIR is configured plus the last
// off-volume backup / error. The e2e DB boots WITHOUT BACKUP_DEST_DIR, so it shows
// the "not configured" state and names the env var to set.
test.describe("Settings → Server: off-volume backup status", () => {
  test("shows the off-volume copy status in the backup card", async ({
    page,
  }) => {
    await page.goto("/settings/server");
    const offsite = page.getByTestId("backup-offsite");
    await expect(offsite).toBeVisible();
    await expect(offsite.getByText("Off-volume copy:")).toBeVisible();
    // No BACKUP_DEST_DIR in the e2e env → the not-configured guidance is shown.
    await expect(offsite.getByText(/not configured/)).toBeVisible();
    await expect(offsite.getByText(/BACKUP_DEST_DIR/).first()).toBeVisible(); // first-ok: asserts the BACKUP_DEST_DIR hint renders in the scoped offsite card — order-agnostic presence
  });
});

// The health endpoint's backup stale alarm is editable on the card (#1869 item 2):
// `backup_staleness_hours` used to be readable by /api/health with no writer
// anywhere. This proves the field round-trips through the card's Save.
test.describe("Settings → Server: backup stale alarm", () => {
  test("the stale alarm field round-trips through Save", async ({ page }) => {
    test.slow();
    await page.goto("/settings/server");
    const card = page.getByTestId("backup-settings");
    const field = page.getByTestId("backup-staleness-hours");
    // settledFill waits out hydration so the value lands in React state (#1188).
    await settledFill(page, field, "36");
    await settledClick(page, card.getByRole("button", { name: "Save" }));
    // Wait for the save to COMMIT before reloading (the SaveStatus chip), so the
    // reload can't abort the in-flight server-action POST.
    await expect(card.getByLabel("Saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("backup-staleness-hours")).toHaveValue("36");
    // Restore the default so other admin-scoped specs see a stable card.
    await settledFill(page, page.getByTestId("backup-staleness-hours"), "48");
    await settledClick(
      page,
      page.getByTestId("backup-settings").getByRole("button", { name: "Save" })
    );
    await expect(
      page.getByTestId("backup-settings").getByLabel("Saved")
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("backup-staleness-hours")).toHaveValue("48");
  });
});

// The backup card exposes a forced live-DB integrity re-check (#621): the
// remediation for a stale `integrity-failed` health verdict after the DB was
// repaired outside a snapshot restore. On the seeded (healthy) e2e DB the recheck
// passes and reports OK, clearing any stale failure without waiting a week.
test.describe("Settings → Server: forced live-integrity recheck", () => {
  test("recheck integrity now runs and reports a passing verdict", async ({
    page,
  }) => {
    await page.goto("/settings/server");
    const integrity = page.getByTestId("backup-integrity");
    await expect(integrity).toBeVisible();
    await expect(integrity.getByText("Live database integrity:")).toBeVisible();

    const recheck = page.getByTestId("backup-recheck-integrity");
    await expect(recheck).toBeVisible();
    await recheck.click();

    // A passing recheck surfaces the success message (the seeded DB is healthy).
    await expect(page.getByText(/Integrity re-check passed/)).toBeVisible();
  });
});
