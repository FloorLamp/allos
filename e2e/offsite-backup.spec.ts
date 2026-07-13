import { test, expect } from "@playwright/test";

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
    await expect(offsite.getByText(/BACKUP_DEST_DIR/).first()).toBeVisible();
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
