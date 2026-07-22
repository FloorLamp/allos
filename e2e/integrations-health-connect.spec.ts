import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_HC, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// /integrations/health-connect (issue #391, gap 4). The push-based ingest token is
// managed here (generate → rotate → disconnect). This drives an isolated member on
// a dedicated, connection-less fixture profile — so it never connects profile 1's
// Health Connect, whose UNconnected state the review-inbox spec relies on — and
// proves that rotating the token actually changes the displayed value.

// Reveal the (single, secret) Bearer-token field and read its value. The endpoint
// field is the other font-mono code; it's the one that carries the http(s) URL, so
// the token is the code WITHOUT it. A rotate re-renders the field masked, so reveal
// again each read.
async function readToken(page: Page): Promise<string> {
  const reveal = page.getByRole("button", { name: "Reveal" });
  if (await reveal.count()) await reveal.first().click();
  const tokenCode = page
    .locator("code.font-mono")
    .filter({ hasNotText: "http" });
  const text = await tokenCode.first().textContent();
  return (text ?? "").trim();
}

test.describe("Health Connect integration (#391)", () => {
  test("generating then rotating the token changes the displayed value", async ({
    browser,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const main = member.getByRole("main");
      await expect(
        main.getByRole("heading", {
          name: "Google Health Connect",
          exact: true,
        })
      ).toBeVisible();

      // Enable it if this profile isn't already connected (retry-safe against a
      // reused DB): the generate button only shows in the disconnected state.
      const generate = member.getByRole("button", {
        name: "Generate token & enable",
      });
      if (await generate.count()) {
        await generate.click();
      }

      // Connected: a status badge + a Bearer token now render.
      await expect(member.getByTestId("health-connect-status")).toBeVisible();
      const first = await readToken(member);
      expect(first.length).toBeGreaterThan(10);

      // Rotate → a fresh token replaces the old one on the page. Wait for the
      // revalidated render to actually swap the displayed value away from the old
      // token before reading (the action call resolves before the RSC refresh
      // lands), then reveal + read the new one.
      const tokenCode = member
        .locator("code.font-mono")
        .filter({ hasNotText: "http" });
      await member.getByTestId("health-connect-rotate").click();
      await expect(tokenCode.first()).not.toHaveText(first, {
        timeout: 15_000,
      });
      const second = await readToken(member);
      expect(second.length).toBeGreaterThan(10);
      expect(second).not.toBe(first);
    } finally {
      await member.context().close();
    }
  });

  // Issue #1065: the setup card renders the per-type "Recommended settings" matrix
  // (SOURCE_FIDELITY), so the user knows which granularity to pick in the exporter app.
  test("renders the recommended per-type granularity settings block", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const block = member.getByTestId("hc-recommended-settings");
      await expect(block).toBeVisible();
      await expect(
        block.getByRole("heading", { name: "Recommended settings" })
      ).toBeVisible();
      // A load-bearing row from the verified matrix: Heart rate → 1m.
      await expect(
        block.getByText("Heart rate", { exact: true })
      ).toBeVisible();
      await expect(block.getByText("1m", { exact: true })).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
