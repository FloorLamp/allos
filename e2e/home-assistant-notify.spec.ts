import { test, expect } from "@playwright/test";

// Home Assistant notification channel config UI (#248). A real webhook POST can't
// run in CI (there's no HA instance), so this drives the genuine server actions +
// SQLite round trip on Settings → Notifications: enabling reveals the URL + per-kind
// controls, saving persists, and the send-test reports "not configured" until a
// valid webhook URL is stored. The pure payload/toggle/URL logic is covered by the
// unit tests (lib/__tests__/home-assistant.test.ts) and the send path by the DB
// tier (lib/__db_tests__/home-assistant-notify.test.ts).

test.describe("Home Assistant notification settings", () => {
  test("enable, save, and send-test surface the right states", async ({
    page,
  }) => {
    await page.goto("/settings/notifications");

    const card = page.getByTestId("ha-settings");
    await expect(card).toBeVisible();

    // Guard: this card's submit button is deliberately NOT named "Save" — role
    // name matching is substring-based, and pre-existing specs (e.g.
    // preventive-nudge.spec.ts) click a bare "Save" on this page. Exactly one
    // "Save"-named button (the Telegram card's) must exist, or those clicks turn
    // strict-mode ambiguous.
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(1);
    await expect(
      card.getByRole("button", { name: "Apply Home Assistant settings" })
    ).toBeVisible();

    // Enable reveals the URL field + per-kind toggles.
    await page.getByTestId("ha-enable").check();
    await expect(page.getByTestId("ha-webhook-url")).toBeVisible();
    await expect(page.getByTestId("ha-kind-dose")).toBeVisible();

    // Saving with an invalid URL is rejected (no silent disable).
    await page.getByTestId("ha-webhook-url").fill("not-a-url");
    await page.getByTestId("ha-save").click();
    await expect(page.getByTestId("ha-result")).toContainText("valid");

    // A valid webhook URL saves, and a send-test attempts a real POST (which fails
    // at the unreachable host) — proving the row was stored, not "not configured".
    await page
      .getByTestId("ha-webhook-url")
      .fill("http://127.0.0.1:9/api/webhook/allos-e2e");
    // Turn off one kind so the disabled-set persistence is exercised.
    await page.getByTestId("ha-kind-weekly-recap").uncheck();
    await page.getByTestId("ha-save").click();
    await expect(page.getByTestId("ha-status")).toBeVisible();

    // The stored config survives a reload (enable stays checked, URL persisted).
    await page.reload();
    await expect(page.getByTestId("ha-enable")).toBeChecked();
    await expect(page.getByTestId("ha-webhook-url")).toHaveValue(
      "http://127.0.0.1:9/api/webhook/allos-e2e"
    );
    await expect(page.getByTestId("ha-kind-weekly-recap")).not.toBeChecked();

    // Send-test now attempts a real POST (config present) → not the "no webhook"
    // message.
    await page.getByTestId("ha-test").click();
    await expect(page.getByTestId("ha-result")).not.toContainText(
      "No Home Assistant webhook"
    );
  });
});
