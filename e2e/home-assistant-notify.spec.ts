import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledCheck, settledFill } from "./helpers";
import { E2E_LOGIN_HA_NOTIFY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Home Assistant notification channel config UI (#248). A real webhook POST can't
// run in CI (there's no HA instance), so this drives the genuine server actions +
// SQLite round trip on Settings → Notifications: enabling reveals the URL + per-kind
// controls, saving persists, and the send-test reports "not configured" until a
// valid webhook URL is stored. The pure payload/toggle/URL logic is covered by the
// unit tests (lib/__tests__/home-assistant.test.ts) and the send path by the DB
// tier (lib/__db_tests__/home-assistant-notify.test.ts).
//
// Runs on its OWN fixture login/profile (post-#1025): the spec persists a real
// (unreachable) webhook config, and the temperature write paths now dispatch the
// red-flag nudge immediately — on a shared profile that config would turn any
// crossing-temp log elsewhere in the suite into a failed real send that overwrites
// the GLOBAL delivery-health marker notify-delivery-error.spec.ts asserts on. No
// spec logs temperatures for this profile, so the config here is never dispatched
// to. (The admin-page "exactly one Save button" composition guard that used to
// live here moved to settings-ia.spec.ts, which still views the admin page.)

test.describe("Home Assistant notification settings", () => {
  test("enable, save, and send-test surface the right states", async ({
    browser,
  }) => {
    const member = await loginAs(browser, {
      username: E2E_LOGIN_HA_NOTIFY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notifications");

      const card = member.getByTestId("ha-settings");
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Apply Home Assistant settings" })
      ).toBeVisible();

      // Enable reveals the URL field + per-kind toggles. settledCheck/settledFill wait
      // for React to hydrate the controlled inputs before toggling/filling (a
      // pre-hydration toggle or fill reverts and the save reads stale state — #1188).
      await settledCheck(member, member.getByTestId("ha-enable"), true);
      await expect(member.getByTestId("ha-webhook-url")).toBeVisible();
      await expect(member.getByTestId("ha-kind-dose")).toBeVisible();

      // Saving with an invalid URL is rejected (no silent disable).
      await settledFill(
        member,
        member.getByTestId("ha-webhook-url"),
        "not-a-url"
      );
      await member.getByTestId("ha-save").click();
      await expect(member.getByTestId("ha-result")).toContainText("valid");

      // A valid webhook URL saves, and a send-test attempts a real POST (which fails
      // at the unreachable host) — proving the row was stored, not "not configured".
      await settledFill(
        member,
        member.getByTestId("ha-webhook-url"),
        "http://127.0.0.1:9/api/webhook/allos-e2e"
      );
      // Turn off one kind so the disabled-set persistence is exercised.
      await settledCheck(
        member,
        member.getByTestId("ha-kind-weekly-recap"),
        false
      );
      await member.getByTestId("ha-save").click();
      await expect(member.getByTestId("ha-status")).toBeVisible();

      // The stored config survives a reload (enable stays checked, URL persisted).
      await member.reload();
      await expect(member.getByTestId("ha-enable")).toBeChecked();
      await expect(member.getByTestId("ha-webhook-url")).toHaveValue(
        "http://127.0.0.1:9/api/webhook/allos-e2e"
      );
      await expect(
        member.getByTestId("ha-kind-weekly-recap")
      ).not.toBeChecked();

      // Send-test now attempts a real POST (config present) → not the "no webhook"
      // message.
      await member.getByTestId("ha-test").click();
      await expect(member.getByTestId("ha-result")).not.toContainText(
        "No Home Assistant webhook"
      );
    } finally {
      await member.context().close();
    }
  });
});
